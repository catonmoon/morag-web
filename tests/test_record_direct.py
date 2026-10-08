"""Вопрос к одной записи без движка (`app/chat/record_direct.py` и его ветка в `/api/ask`).

Что здесь главное — перевод меток времени в сноски. Фронт понимает только `[N]` с кадром цитаты
того же номера; метка, которая дошла до браузера буквой, — это сноска, по которой не перейти,
а выглядит ответ при этом исправным. Метки приходят кусками потока (`[12`, `:3`, `4]`), поэтому
проверяется и разрез.

Шлюз здесь — заглушка: проверяем свой стык, а не модель (её мерил стенд на живом корпусе).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from app.chat.record_direct import (  # noqa: E402
    CitationStream,
    RecordContext,
    build_context,
    load_screens,
    mmss,
)
from app.content.transcript import Utterance  # noqa: E402
from app.main import app  # noqa: E402


class _Rec:
    id = "rec-1"
    title = "Тестовая запись"
    date = "2024-01-15"
    section = ""
    speakers = ["Мария Кузнецова"]
    participants: list[str] = []


UTTS = [
    Utterance(sec=5.0, end_sec=40.0, speaker="Мария Кузнецова", text="Начнём с очередей."),
    Utterance(sec=40.0, end_sec=75.5, speaker="Speaker_12", text="А сколько партиций?"),
    Utterance(sec=75.5, end_sec=3725.0, speaker="Мария Кузнецова", text="Двенадцать, по числу потребителей."),
    Utterance(sec=3725.0, end_sec=3800.0, speaker="Speaker_40", text="Спасибо."),
]


def _stream(chunks: list[str]) -> tuple[list[dict], CitationStream]:
    ctx = build_context(_Rec(), UTTS, [])
    cs = CitationStream(ctx, record_id="rec-1", title="Тестовая запись", media="/api/media/x.mp4")
    out = []
    for c in chunks:
        out.extend(cs.feed(c))
    out.extend(cs.flush())
    return out, cs


def _text(frames: list[dict]) -> str:
    return "".join(f["text"] for f in frames if f["type"] == "token")


# --- контекст ----------------------------------------------------------------


def test_безымянные_голоса_подписаны_участниками_а_номер_реестра_не_виден():
    ctx = build_context(_Rec(), UTTS, [])
    assert "Speaker_" not in ctx.system, "номер реестра в контексте — модель вынесет его в ответ"
    assert "[0:40] Участник 1: А сколько партиций?" in ctx.system
    assert "[1:02:05] Участник 2: Спасибо." in ctx.system
    assert "[0:05] Мария Кузнецова: Начнём с очередей." in ctx.system


def test_без_подписей_голоса_идут_как_есть():
    ctx = build_context(_Rec(), UTTS, [], anon_voices=False)
    assert "Speaker_12: А сколько партиций?" in ctx.system


def test_экран_встаёт_между_репликами_по_времени(tmp_path):
    (tmp_path / "record.annotations.json").write_text(json.dumps({"items": [
        {"kind": "boundary", "at": 30},
        {"kind": "screen", "t0": 30, "label": "Слайд 2", "title": "Партиции", "text": "12 партиций\nключ — id"},
        # тот же экран после перерисовки — не повторяется
        {"kind": "screen", "t0": 35, "label": "Слайд 2", "title": "Партиции", "text": "12 партиций  ключ — id"},
    ]}), encoding="utf-8")
    screens = load_screens(tmp_path)
    assert len(screens) == 1
    ctx = build_context(_Rec(), UTTS, screens)
    lines = ctx.system.splitlines()
    i = lines.index("[0:30] [Экран · Слайд 2 · «Партиции»] 12 партиций ключ — id")
    assert lines[i - 1].startswith("[0:05]") and lines[i + 1].startswith("[0:40]")


def test_битый_сайдкар_экрана_не_роняет_вопрос(tmp_path):
    (tmp_path / "record.annotations.json").write_text("{не json", encoding="utf-8")
    assert load_screens(tmp_path) == []


def test_mmss_с_часами():
    assert mmss(5) == "0:05" and mmss(3725) == "1:02:05"


# --- метки → сноски ----------------------------------------------------------


def test_метка_становится_сноской_и_кадр_цитаты_идёт_раньше_неё():
    frames, cs = _stream(["Двенадцать партиций [1:15]."])
    kinds = [f["type"] for f in frames]
    assert kinds.index("citation") < kinds.index("token")
    cit = next(f for f in frames if f["type"] == "citation")
    assert cit["n"] == 1 and cit["rec"] == "rec-1" and cit["sec"] == 75
    assert cit["url"] == "/api/media/x.mp4"
    assert cit["label"] == "Тестовая запись · 1:15 · Мария Кузнецова"
    assert _text(frames) == "Двенадцать партиций [1]."
    assert cs.citations == 1 and cs.marks == 1 and cs.missed == 0


def test_метка_разрезанная_между_кусками_потока():
    frames, _ = _stream(["Двенадцать [1", ":1", "5] партиций"])
    assert _text(frames) == "Двенадцать [1] партиций"


def test_метка_внутри_реплики_ведёт_на_её_начало():
    frames, _ = _stream(["вопрос из зала [0:52]"])
    cit = next(f for f in frames if f["type"] == "citation")
    assert cit["sec"] == 40 and "[0:40] [Speaker_12] А сколько партиций?" in cit["text"]


def test_часовая_метка_и_две_метки_в_одних_скобках():
    frames, cs = _stream(["итог [1:02:05], а раньше [0:05, 0:40]"])
    assert _text(frames) == "итог [1], а раньше [2][3]"
    assert [f["sec"] for f in frames if f["type"] == "citation"] == [3725, 5, 40]


def test_та_же_реплика_дважды_одна_карточка():
    frames, cs = _stream(["раз [0:05], два [0:20]"])
    assert _text(frames) == "раз [1], два [1]"
    assert cs.citations == 1


def test_метка_за_концом_записи_остаётся_текстом_и_считается_промахом():
    frames, cs = _stream(["выдумано [2:00:00]"])
    assert _text(frames) == "выдумано [2:00:00]"
    assert cs.citations == 0 and cs.missed == 1


def test_квадратные_скобки_не_про_время_не_застревают():
    frames, _ = _stream(["список [см. ниже] и [", "x] конец"])
    assert _text(frames) == "список [см. ниже] и [x] конец"


def test_карточка_короткой_реплики_добирает_продолжение():
    ctx = RecordContext(system="", utterances=[
        Utterance(sec=10, end_sec=12, speaker="A", text="Да."),
        Utterance(sec=12, end_sec=30, speaker="B", text="Так вот."),
        Utterance(sec=60, end_sec=90, speaker="A", text="Другое."),
    ])
    cs = CitationStream(ctx, record_id="r", title="t", media="")
    cit = next(f for f in cs.feed("[0:10]") if f["type"] == "citation")
    assert cit["text"].count("\n") == 1 and cit["end"] == 30


# --- /api/ask ----------------------------------------------------------------


class _FakeAnswerer:
    """Шлюз прямого пути: отдаёт куски и запоминает, что ему прислали."""

    def __init__(self, pieces, *, fits=True, fail=False):
        self.pieces = pieces
        self._fits = fits
        self.fail = fail
        self.enabled = True
        self.seen: list[dict] = []

        class _Cfg:
            anon_voices = True
        self.cfg = _Cfg()

    def fits(self, ctx, history_chars=0):
        return self._fits

    async def stream(self, messages):
        self.seen = list(messages)
        if self.fail:
            raise httpx.ReadTimeout("шлюз молчит")
        for p in self.pieces:
            yield p

    async def aclose(self):
        pass


class _FakeEngine:
    def __init__(self):
        self.called = False

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def stream_chat(self, messages):
        self.called = True

        class _R:
            status_code = 200

            async def aiter_bytes(self):
                yield b'data: {"choices":[{"delta":{"content":"from engine"}}]}\n\n'
                yield b"data: [DONE]\n\n"

            async def aread(self):
                return b""
        yield _R()

    async def aclose(self):
        pass


@pytest.fixture
def site(tmp_path):
    with TestClient(app) as c:
        slug = next(iter(app.state.corpora))
        corpus = app.state.corpora[slug]
        record = corpus.index.all()[0]
        real_engine, real_direct = app.state.engines[slug], app.state.record_direct
        engine = _FakeEngine()
        app.state.engines[slug] = engine
        app.state.journal.path = tmp_path / "journal.jsonl"
        app.state.topic.enabled = False
        holder = {}

        def use(answerer):
            app.state.record_direct = answerer
            holder["a"] = answerer
            return answerer
        try:
            yield c, slug, record, engine, use, tmp_path / "journal.jsonl"
        finally:
            app.state.engines[slug] = real_engine
            app.state.record_direct = real_direct


def _frames(response) -> list[dict]:
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]


def _ask(c, slug, record, question="о чём запись?", history=()):
    return c.post("/api/ask", json={"question": question, "corpus": slug, "history": list(history),
                                    "context": {"record_id": record.id, "scope": "record"},
                                    "want_topic": False})


def _first_mark(record) -> str:
    from app.content.transcript import load_utterances
    corpus = next(iter(app.state.corpora.values()))
    return mmss(load_utterances(corpus.index.path_of(record))[0].sec)


def test_вопрос_к_записи_отвечается_без_движка_со_сноской_и_в_журнал(site):
    c, slug, record, engine, use, journal = site
    fake = use(_FakeAnswerer(["Главное ", f"сказано в начале [{_first_mark(record)}]."]))
    frames = _frames(_ask(c, slug, record, history=[{"role": "user", "content": "раньше"},
                                                   {"role": "assistant", "content": "ответ"}]))
    assert not engine.called, "вопрос к записи ушёл в движок, хотя прямой путь включён"
    types = [f["type"] for f in frames]
    assert types[0] == "answer_id" and "status" in types and types[-1] == "done"
    cit = next(f for f in frames if f["type"] == "citation")
    assert cit["rec"] == record.id and cit["n"] == 1
    assert "".join(f["text"] for f in frames if f["type"] == "token") == "Главное сказано в начале [1]."
    # запись — системным сообщением первой, затем история и голый вопрос
    assert fake.seen[0]["role"] == "system" and record.title in fake.seen[0]["content"]
    assert fake.seen[-1] == {"role": "user", "content": "о чём запись?"}
    assert {"role": "assistant", "content": "ответ"} in fake.seen
    row = json.loads(journal.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert row["engine"] == "direct" and row["status"] == "ok"
    assert row["citations"][0]["rec"] == record.id and row["marks"] == 1 and row["missed"] == 0


def test_запись_не_влезла_в_окно_вопрос_уходит_в_движок(site):
    c, slug, record, engine, use, journal = site
    use(_FakeAnswerer(["не должно прийти"], fits=False))
    frames = _frames(_ask(c, slug, record))
    assert engine.called
    assert "from engine" in "".join(f.get("text", "") for f in frames if f["type"] == "token")


def test_выключенный_прямой_путь_идёт_в_движок(site):
    c, slug, record, engine, use, journal = site
    fake = use(_FakeAnswerer(["нет"]))
    fake.enabled = False
    _ask(c, slug, record)
    assert engine.called


def test_шлюз_молчит_человеку_говорим_про_шлюз_а_в_журнале_ошибка(site):
    c, slug, record, engine, use, journal = site
    use(_FakeAnswerer([], fail=True))
    frames = _frames(_ask(c, slug, record))
    err = [f for f in frames if f["type"] == "error"]
    assert err and "шлюз" in err[0]["message"]
    assert not engine.called
    row = json.loads(journal.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert row["status"] == "error" and row["engine"] == "direct"


def test_пустой_ответ_шлюза_честно_пустой(site):
    c, slug, record, engine, use, journal = site
    use(_FakeAnswerer([]))
    frames = _frames(_ask(c, slug, record))
    assert any(f["type"] == "error" for f in frames)
    assert json.loads(journal.read_text(encoding="utf-8").strip().splitlines()[-1])["status"] == "empty"


def test_вопрос_с_места_строки_по_прежнему_в_движок(site):
    c, slug, record, engine, use, journal = site
    use(_FakeAnswerer(["нет"]))
    c.post("/api/ask", json={"question": "что здесь?", "corpus": slug,
                             "context": {"record_id": record.id, "scope": "line", "sec": 10}})
    assert engine.called
