"""Вопрос к ОДНОЙ записи без движка: вся запись в контексте LLM, ответ — прямо из шлюза.

Зачем. Режим записи в движке отвечает только по ПРОИНДЕКСИРОВАННОЙ записи, а индексация идёт
плановым прогоном — загруженная днём запись до ночи немая ровно тогда, когда к ней приходят по
ссылке. Поиск внутри одной записи при этом не нужен: замерено на корпусе в 382 записи, контекст
записи с экраном — медиана 20k токенов, максимум 154k, а окно модели на шлюзе 200k. Модель
читает запись целиком и отвечает; замер против движка на тех же вопросах — 4–25 с против
14–91 с, ссылки на моменты точные (582 из 598 — метка строки, остальные внутри записи).

Как. Контекст — шапка записи и строки `[м:сс] Голос: текст` вперемешку с экраном
`[м:сс] [Экран · Слайд 3 «…»] текст` по времени. Модель ссылается метками времени; поток ответа
проходит через `CitationStream`, который меняет `[12:34]` на `[N]` и ПЕРЕД сноской отдаёт кадр
цитаты — тот же контракт, что у движка, поэтому фронт (карточки-моменты, сноски) не меняется.

⚠️ Безымянные голоса в контексте — «Участник N», а не номер реестра: модель переписывает метку
в ответ («из зала (Speaker_132) спросили»), а номер посетителю не говорит ничего. Замерено: с
номерами — до четырёх протечек на ответ, с подписями — ноль на двенадцати ответах. Карточка
цитаты при этом показывает метку как в читалке: там это подпись голоса, а не текст ответа.
"""

from __future__ import annotations

import bisect
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Iterator

import httpx

from ..content.transcript import Utterance
from ..engine import frames

log = logging.getLogger(__name__)

DEFAULT_PROMPT = """Ты отвечаешь на вопросы про ОДНУ запись. Ниже — её расшифровка целиком и то, \
что было на экране. Отвечай только по ней; чего в записи нет — так и скажи, не додумывай.

Правила:
- Пиши по-русски, по существу, без вступлений. Списки и абзацы — markdown.
- Ссылайся на моменты записи меткой времени в квадратных скобках, ровно как она стоит в начале \
строки расшифровки: «…переходят на новую схему [12:34]». Метку бери только из текста ниже, не \
выдумывай и не округляй. Ставь ссылку после каждого утверждения, которое опирается на конкретное место.
- Строки «[Экран · …]» — что было показано на экране в этот момент; на них тоже можно ссылаться.
- «Участник N» — голос без имени; в ответ эту подпись не выноси, пиши безлично («докладчик», \
«из зала спросили»). Названных людей называй по имени."""

SPEAKER_ID = re.compile(r"^Speaker_\d+$")
# Метка в ответе: `[12:34]`, `[1:02:03]`, а модель иногда кладёт две в одни скобки — `[12:34, 13:05]`.
MARKS = re.compile(r"\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,;]\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]")
ONE_MARK = re.compile(r"\d{1,2}:\d{2}(?::\d{2})?")
# Сколько придерживать хвост потока, если в нём открыта `[`: длиннее метки списком не бывает.
_HOLD_MAX = 40
CARD_SPAN = 30.0  # секунд речи в карточке цитаты — как короткий чанк движка


def mmss(sec: float) -> str:
    s = int(sec)
    h, m, s = s // 3600, s % 3600 // 60, s % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def parse_mark(text: str) -> int:
    sec = 0
    for part in text.split(":"):
        sec = sec * 60 + int(part)
    return sec


def load_screens(record_dir: Path) -> list[tuple[float, str]]:
    """Экран из `record.annotations.json`: элементы `screen` (демо там уже обрезаны сборкой).

    Тот же экран после перерисовки (Jitsi/Meet перерисовывают область показа) не повторяем.
    Файла нет или он битый — записи без экрана тоже отвечают, просто по речи.
    """
    path = record_dir / "record.annotations.json"
    try:
        items = json.loads(path.read_text(encoding="utf-8")).get("items") or []
    except (OSError, ValueError, AttributeError):
        return []
    out: list[tuple[float, str]] = []
    prev = None
    for it in items:
        if not isinstance(it, dict) or it.get("kind") != "screen":
            continue
        text = " ".join(str(it.get("text") or "").split())
        if not text or text == prev:
            continue
        prev = text
        label = " · ".join(x for x in (str(it.get("label") or ""),
                                       f"«{it['title']}»" if it.get("title") else "") if x)
        try:
            t0 = float(it.get("t0") or 0)
        except (TypeError, ValueError):
            continue
        out.append((t0, f"[Экран{' · ' + label if label else ''}] {text}"))
    return out


@dataclass
class RecordContext:
    """Запись, собранная для модели, и всё, что нужно, чтобы превращать её метки в цитаты."""

    system: str
    utterances: list[Utterance]
    starts: list[int] = field(default_factory=list)  # int(sec) реплик — для поиска по метке

    def __post_init__(self) -> None:
        self.starts = [int(u.sec) for u in self.utterances]

    def utterance_at(self, sec: int) -> int | None:
        """Реплика, звучащая в секунду `sec`: последняя, начавшаяся не позже. За концом — None."""
        if not self.utterances:
            return None
        i = bisect.bisect_right(self.starts, sec) - 1
        if i < 0:
            return 0 if sec >= 0 else None
        if sec > max(self.utterances[-1].end_sec, self.utterances[-1].sec) + 1:
            return None  # метка за концом записи — выдумана, сноску не ставим
        return i


def build_context(record, utterances: list[Utterance], screens: list[tuple[float, str]],
                  prompt: str = "", anon_voices: bool = True) -> RecordContext:
    names: dict[str, str] = {}

    def who(label: str) -> str:
        if not anon_voices or not SPEAKER_ID.match(label):
            return label
        return names.setdefault(label, f"Участник {len(names) + 1}")

    rows = [(u.sec, 0, f"{who(u.speaker)}: {u.text}") for u in utterances]
    rows += [(t, 1, s) for t, s in screens]
    rows.sort(key=lambda r: (r[0], r[1]))
    head = [f"Запись: {record.title}"]
    if record.date:
        head.append(f"Дата: {record.date}")
    if record.section:
        head.append(f"Раздел: {record.section}")
    if record.speakers:
        head.append("Выступали: " + ", ".join(record.speakers))
    if record.participants:
        head.append("Участвовали: " + ", ".join(record.participants))
    body = "\n".join(f"[{mmss(sec)}] {text}" for sec, _, text in rows)
    system = (prompt or DEFAULT_PROMPT).rstrip() + "\n\n" + "\n".join(head) + "\n\nРасшифровка:\n" + body
    return RecordContext(system=system, utterances=list(utterances))


class CitationStream:
    """Поток текста модели → кадры `token`/`citation`, метки времени → сноски `[N]`.

    Интерфейс счётчиков — как у `engine.normalize.StreamNormalizer` (`tokens`, `citations`,
    `answer_text`, `citation_frames`), чтобы обработчик вопроса и журнал не различали источники.

    ⚠️ Метка приходит кусками (`[12`, `:3`, `4]`), поэтому хвост с открытой `[` придерживаем до
    закрытия или до `_HOLD_MAX` знаков. Сноска на одну и ту же реплику — один номер: модель
    ссылается на одно место по нескольку раз, а карточка нужна одна.
    """

    def __init__(self, ctx: RecordContext, *, record_id: str, title: str, media: str) -> None:
        self.ctx = ctx
        self.record_id = record_id
        self.title = title
        self.media = media
        self.finished = False
        self.tokens = 0
        self.citations = 0
        self.marks = 0        # меток в ответе всего
        self.missed = 0       # меток мимо записи — сноска не поставлена
        self.answer_parts: list[str] = []
        self.citation_frames: list[dict] = []
        self._by_utt: dict[int, int] = {}
        self._hold = ""

    @property
    def answer_text(self) -> str:
        return "".join(self.answer_parts)

    def feed(self, text: str) -> Iterator[dict]:
        buf = self._hold + text
        self._hold = ""
        cut = buf.rfind("[")
        if cut != -1 and "]" not in buf[cut:] and len(buf) - cut <= _HOLD_MAX:
            buf, self._hold = buf[:cut], buf[cut:]
        yield from self._emit(buf)

    def flush(self) -> Iterator[dict]:
        tail, self._hold = self._hold, ""
        self.finished = True
        yield from self._emit(tail)

    def _emit(self, text: str) -> Iterator[dict]:
        if not text:
            return
        out: list[str] = []
        pos = 0
        for m in MARKS.finditer(text):
            out.append(text[pos:m.start()])
            refs = []
            for one in ONE_MARK.findall(m.group(1)):
                self.marks += 1
                n = self._number(parse_mark(one))
                if n is None:
                    self.missed += 1
                    continue
                if n.get("frame"):
                    yield n["frame"]
                refs.append(f"[{n['n']}]")
            out.append("".join(refs) if refs else m.group(0))
            pos = m.end()
        out.append(text[pos:])
        chunk = "".join(out)
        if chunk:
            self.tokens += 1
            self.answer_parts.append(chunk)
            yield frames.token(chunk)

    def _number(self, sec: int) -> dict | None:
        i = self.ctx.utterance_at(sec)
        if i is None:
            return None
        if i in self._by_utt:
            return {"n": self._by_utt[i]}
        n = len(self._by_utt) + 1
        self._by_utt[i] = n
        frame = self._frame(n, i)
        self.citations += 1
        self.citation_frames.append(frame)
        return {"n": n, "frame": frame}

    def _frame(self, n: int, i: int) -> dict:
        utts = self.ctx.utterances
        first = utts[i]
        lines, j = [], i
        # Карточке — реплика и, если она короткая, следующие до ~30 с: «да, согласен» без
        # продолжения моментом не является.
        while j < len(utts) and (j == i or utts[j].sec - first.sec < CARD_SPAN):
            u = utts[j]
            lines.append(f"[{mmss(u.sec)}] [{u.speaker}] {u.text}")
            j += 1
        end = utts[j - 1].end_sec
        return frames.citation(
            n=n,
            label=f"{self.title} · {mmss(first.sec)} · {first.speaker}",
            url=self.media,
            text="\n".join(lines),
            record_id=self.record_id,
            sec=int(first.sec),
            end=max(int(end), int(first.sec) + 1),
        )


class DirectAnswerer:
    """Клиент шлюза для прямого пути: OpenAI-совместимый `chat/completions` потоком.

    Адрес, модель и ключ — свои или (по умолчанию) те же, что у авто-темы: это тот же шлюз.
    `trust_env=False` — по той же причине, что у движка и темы: окружение машины не должно
    заворачивать наш вызов в чужой прокси.
    """

    def __init__(self, cfg, *, base_url: str, model: str, api_key: str, proxy: str | None) -> None:
        self.cfg = cfg
        self.model = model
        self.enabled = bool(cfg.enabled and base_url and model and api_key)
        self._base_url = base_url.rstrip("/")
        self._key = api_key
        self._proxy = proxy
        self._client: httpx.AsyncClient | None = None

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                headers={"Authorization": f"Bearer {self._key}"},
                trust_env=False,
                proxy=self._proxy,
                # read — пауза МЕЖДУ кусками потока: префилл длинной записи (140k) — до ~20 с.
                timeout=httpx.Timeout(connect=10, read=self.cfg.read_timeout, write=30, pool=10),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    def fits(self, ctx: RecordContext, history_chars: int = 0) -> bool:
        """Влезает ли запись с историей и ответом в окно — оценкой по знакам (замер шлюза)."""
        need = (len(ctx.system) + history_chars) * self.cfg.tokens_per_char + self.cfg.max_tokens
        return need <= self.cfg.budget_tokens

    async def stream(self, messages: list[dict]) -> AsyncIterator[str]:
        """Куски текста ответа. Не 200 — `httpx.HTTPStatusError` с телом в логе."""
        payload = {
            "model": self.model,
            "stream": True,
            "temperature": self.cfg.temperature,
            "max_tokens": self.cfg.max_tokens,
            # Рассуждение выключаем всеми тремя способами, которые понимают разные шлюзы: иначе
            # оно съедает `max_tokens`, и ответ приходит пустым (замерено у Vision — 21 из 21).
            "chat_template_kwargs": {"enable_thinking": False},
            "reasoning_effort": "none",
            "reasoning": {"effort": "none"},
            "messages": messages,
        }
        async with self._http().stream("POST", "/chat/completions", json=payload) as response:
            if response.status_code != 200:
                body = (await response.aread())[:500].decode("utf-8", "replace")
                log.error("прямой путь: шлюз ответил %s: %s", response.status_code, body)
                response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                try:
                    obj = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for choice in (obj or {}).get("choices") or []:
                    piece = ((choice or {}).get("delta") or {}).get("content")
                    if piece:
                        yield piece
