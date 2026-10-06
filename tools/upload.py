#!/usr/bin/env python3
"""Своя запись — на сайт: транскрибация и экран у себя на Mac, сборка и индексация на сервере.

    python3 tools/upload.py login --site https://site.example.org
    python3 tools/upload.py run talk.mp4 --title "Kafka без боли" --date 2026-03-12 \\
        [--event "Доклады"] [--speakers "Мария Кузнецова"] [--tags kafka,streams] \\
        [--summary "О чём доклад"] [--slides deck.pdf] [--no-screen] [--stack] [--no-wait]
    python3 tools/upload.py status 2026-03-12-kafka-bez-boli

Что происходит (`run`), по шагам, каждый — с возобновлением: упало на третьем — второй раз
начнётся с третьего (состояние — `~/morag-upload/<id>/state.json`):

  1. стек транскрибации у вас на машине (`morag/services/asr-adaptor/deploy/mac/stack.sh`,
     ставится `tools/upload-install.sh`): звук вынимает ffmpeg, адаптер гонит диаризацию,
     whisper и LLM-стадии через ВАШ ключ (`~/.asr-stack.env`) → `artifact.json`;
  2. экран из видео (`--no-screen` пропускает): шкала слайдов, заставка, описания кадров
     Vision-моделью, обращения «вот здесь», аннотации — инструменты `tools/*.py` под
     `~/asr-stack/video-venv`; для них запись собирается ВО ВРЕМЕННОЙ семье с пустыми словарями
     (`~/morag-upload/family`) — на сайт эта сборка не едет, едет сырой артефакт;
  3. пакет уезжает на сайт под вашей учёткой (`/api/upload`): манифест, артефакт, сайдкары
     экрана, кадры, слайды, видео (последним, с прогрессом); сервер собирает запись с
     настоящими словарями и раскладкой и отвечает адресом. Индексация — отдельно и планово:
     ждать её человеку незачем, запись читается на сайте сразу.

Голоса в записи приедут безымянными (`Speaker_N`): у вашей машины свой реестр голосов, и на
сайте их называют потом — «Это я» у своего голоса, карточка голоса у остальных. Категория и
темы — позже, обычной разметкой корпуса.

Зависимости: python3.10+, ffmpeg, httpx (есть в `video-venv`). Стек — `upload-install.sh`.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

try:
    import httpx
except ImportError:  # pragma: no cover — подсказка вместо трейсбека
    sys.exit("нужен httpx: ~/asr-stack/video-venv/bin/python tools/upload.py … (или pip install httpx)")

# ⚠️ Сертификат корпоративного сайта подписан ВНУТРЕННИМ центром сертификации, а httpx носит с
# собой только публичные корни: без этого вход отвечает `CERTIFICATE_VERIFY_FAILED`, и выглядит
# это как «приложение не видит сайт» (ловилось на живой установке 23.09). `truststore` отдаёт
# проверку тому же хранилищу, которым пользуются Safari и системный curl. Нет пакета — работаем
# как раньше: в установке с зеркала то же самое делает `SSL_CERT_FILE` в окружении.
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:  # noqa: BLE001 — не мак, старый питон, пакета нет: не повод падать
    pass

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))
from make_record import slugify  # noqa: E402
import attach_names  # noqa: E402

HOME = Path(os.environ.get("MORAG_UPLOAD_HOME") or (Path.home() / "morag-upload"))
SESSION = Path.home() / ".morag-upload" / "session.json"
ASR_BASE = os.environ.get("ASR_BASE", "http://127.0.0.1:8082")
STACK_HOME = Path(os.environ.get("ASR_STACK_HOME") or (Path.home() / "asr-stack"))
STACK_ENV = Path(os.environ.get("ASR_STACK_ENV") or (Path.home() / ".asr-stack.env"))
VIDEO_PY = STACK_HOME / "video-venv" / "bin" / "python"
MORAG_REPO = Path(os.environ.get("MORAG_REPO") or (REPO.parent / "morag"))
VIDEO_EXT = ("mp4", "webm", "mov", "mkv")
SIDECARS = ("record.slides.json", "record.refs.json", "record.annotations.json")
POLL_SEC = 15
# ⚠️ С лентой событий опрашиваем адаптер РАЗ В СЕКУНДУ, а не раз в пятнадцать: он локальный,
# пустой ответ ~120 байт, а раз в пятнадцать секунд картинка дёргалась бы рывками по четверти
# минуты. В терминальный лог при этом по-прежнему пишем раз в минуту — там частить незачем.
EVENT_POLL_SEC = 1.0
EVENTS_MAX = 20000


class Step(Exception):
    """Шаг не прошёл: причина для человека, без трейсбека."""


# Хвост сообщений — для страницы (`upload_ui.py`): те же строки, что в терминале. Кольцо, а не
# файл: страница показывает ход работы, а разбор потом — в терминале.
LOG: list[str] = []

# Лента событий стадий — то, из чего страница рисует работу. События приходят из адаптера
# (диаризация, куски, замены, голоса) и добавляются здесь (шаги клиента, пики волны).
# ⚠️ Нумерация СВОЯ и сквозная: у страницы должен быть ОДИН монотонный курсор, иначе она не
# отличит «событие адаптера #5» от «своего #5» и покажет кашу.
EVENTS: list[dict] = []
_SEQ = [0]
_T0 = [0.0]                     # начало прогона: время событий считается от него, а не от эпохи
TRACE: list[Path] = []          # куда писать трассу прогона (стенд); пусто — не пишем


def emit(kind: str, /, **fields) -> None:
    """Событие в ленту. ⚠️ Имя `event` занято: так зовётся рубрика записи в конвейере — совпадение
    имён давало «NoneType is not callable» в середине прогона.

    ⚠️⚠️ Первый аргумент — ПОЗИЦИОННЫЙ (`/`), и это не педантизм: у событий свои поля, и у
    кадра экрана одно из них зовётся `kind` (слайд / окно / терминал). Без этой черты прогон
    падал на первом же описанном кадре: «emit() got multiple values for argument» (живьём 25.09).

    Событие в ленту. Показ работы — украшение: оно не имеет права уронить загрузку."""
    try:
        if not _T0[0]:
            _T0[0] = time.monotonic()
        _SEQ[0] += 1
        # ⚠️ Номер конверта — `seq`, а не `i`: `i` у события занято смыслом (номер куска).
        evt = {"t": kind, "seq": _SEQ[0], "at": round(time.monotonic() - _T0[0], 2), **fields}
        EVENTS.append(evt)
        del EVENTS[:-EVENTS_MAX]
        for path in TRACE:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(evt, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


def events_since(cursor: int) -> tuple[list[dict], int]:
    items = [e for e in EVENTS if e["seq"] > cursor]
    return items, (items[-1]["seq"] if items else cursor)


def size_of(n: int) -> str:
    """Человеческий размер: файл на 900 КБ не должен печататься как «0 МБ»."""
    return f"{n / 1e9:.1f} ГБ" if n >= 1e9 else (f"{round(n / 1e6)} МБ" if n >= 1e6 else f"{max(1, round(n / 1e3))} КБ")


def say(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    LOG.append(line)
    del LOG[:-400]


# --- файл стека ----------------------------------------------------------------------------

# Путь ручки сайта, через которую стадии с LLM ходят в корпоративный шлюз (`app/api/llm.py`):
# сервер называет его сам в `/api/upload/options`, здесь — запасное значение.
SITE_LLM_PATH = "/api/upload/llm"

def stack_env_path() -> Path:
    """Файл стека — ПО ЗОВУ, а не по импорту: окружение приложению задаёт запускатор, а тесты
    и терминал подменяют его на ходу; константа, прочитанная при импорте, писала бы не туда."""
    return Path(os.environ.get("ASR_STACK_ENV") or STACK_ENV).expanduser()


def set_stack_env(**values: str) -> Path:
    """Вписать значения в файл стека (0600), заполняя СУЩЕСТВУЮЩИЕ строки, а не дописывая.

    ⚠️ Два присваивания одного имени в одном файле — классическая тихая беда: побеждает
    последнее, и правка верхней строки ни на что не влияет (ловилось в установщике морага).
    ⚠️ Файл читает АДАПТЕР при старте: вписанное на ходу подхватится только после перезапуска
    стека — гасить его должен зовущий.
    """
    path = stack_env_path()
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    for name, value in values.items():
        for i, line in enumerate(lines):
            if line.strip().removeprefix("export ").split("=", 1)[0].strip() == name:
                lines[i] = f"{name}={value}"
                break
        else:
            lines.append(f"{name}={value}")
        os.environ[name] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def stack_env_value(name: str) -> str:
    """Значение из окружения, иначе из файла стека."""
    if os.environ.get(name):
        return os.environ[name]
    path = stack_env_path()
    if not path.is_file():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        key, _, value = line.strip().removeprefix("export ").partition("=")
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


# --- сессия сайта --------------------------------------------------------------------------

def load_session(site: str | None) -> tuple[str, dict[str, str]]:
    """Адрес сайта и cookie. Порядок: сохранённая сессия → аргумент → `MORAG_SITE` из окружения.

    ⚠️ Последнее — не мелочь. Установка с сайта (`install-mac.sh`) знает его адрес и кладёт в
    окружение; без этого шага человек, поставивший приложение по ссылке с сайта, должен был бы
    ВПИСАТЬ адрес этого же сайта руками. Ловилось на чистой установке.
    """
    if SESSION.is_file():
        data = json.loads(SESSION.read_text(encoding="utf-8"))
        if not site or site == data.get("site"):
            return data["site"], data.get("cookies") or {}
    site = site or os.environ.get("MORAG_SITE") or ""
    if not site:
        raise Step("не знаю адрес сайта: сначала `upload.py login --site …`")
    return site.rstrip("/"), {}


def save_session(site: str, cookies: dict[str, str]) -> None:
    SESSION.parent.mkdir(parents=True, exist_ok=True)
    SESSION.write_text(json.dumps({"site": site, "cookies": cookies}), encoding="utf-8")
    SESSION.chmod(0o600)


TRANSPORT: httpx.BaseTransport | None = None   # тесты подменяют сайт и адаптер
# Когда принятая запись попадёт в поиск — «now» или «later» (плановая индексация). Сервер
# говорит это в статусе; окно показывает в карточке «готово», чтобы не обещать лишнего.
LAST_SEARCH = ""
# Адрес принятой записи на сайте — его отдаёт сервер (`/<пространство>/rec/<id>`), сами не собираем:
# пространство и id решает он. Окно показывает его кнопками «Открыть» и «Скопировать адрес».
LAST_URL = ""


def client(site: str, cookies: dict[str, str], timeout=60.0) -> httpx.Client:
    """⚠️ `trust_env=False`: прокси из окружения нам только мешает. Сайт и стек — внутри
    периметра, а корпоративный прокси отвечает на них 503/407; ловилось в терминале, где
    переменные прокси заданы профилем оболочки (у приложения из Finder их нет вовсе)."""
    return httpx.Client(base_url=site, cookies=cookies, timeout=timeout, follow_redirects=False,
                        trust_env=False, transport=TRANSPORT)


def cmd_login(args: argparse.Namespace) -> int:
    site = (args.site or load_session(None)[0]).rstrip("/")
    with client(site, {}) as c:
        state = c.get("/api/auth/state").json()
        if not state.get("enabled"):
            save_session(site, {})
            say(f"{site}: вход выключен — сессия не нужна")
            return 0
        login = args.login or input("логин: ").strip()
        password = getpass.getpass("пароль: ")
        r = c.post("/api/auth/login", json={"login": login, "password": password})
        if r.status_code != 200:
            raise Step(f"вход не удался ({r.status_code}): {r.json().get('detail', r.text)}")
        cookies = {k: v for k, v in c.cookies.items()}
        me = r.json()
    save_session(site, cookies)
    say(f"вошли как {me.get('name') or login} ({me.get('role')}), сессия — {SESSION}")
    # Ключ к шлюзу спрашивать не надо: сайт умеет ходить туда за нас этой же сессией.
    try:
        out = use_site_llm()
        say("стадии с ИИ пойдут через сайт — ключ не нужен" if out.get("via_site")
            else "сайт не ходит в шлюз за вас: впишите свой ключ в OR_KEY файла стека")
    except Step as error:
        say(f"шлюз через сайт не настроился ({error}) — можно вписать свой ключ в OR_KEY")
    return 0


def use_site_llm() -> dict:
    """Ключ не спрашиваем: пусть стадии с LLM ходят в шлюз ЧЕРЕЗ САЙТ, а удостоверением служит
    та же сессия, которой человек только что вошёл.

    Что кладём в файл стека: адрес ручки сайта, модель (её называет сервер) и строку сессии как
    `OR_KEY` — стек умеет только `Authorization: Bearer <строка>`, и этого достаточно. Ключ
    корпоративного шлюза остаётся на сервере; здесь его нет вовсе.
    """
    site, cookies = load_session(None)
    with client(site, cookies, timeout=20) as c:
        r = c.get("/api/upload/options")
        if r.status_code != 200:
            raise Step(f"сайт не ответил про загрузку ({r.status_code}) — войдите заново")
        llm = (r.json() or {}).get("llm") or {}
        if not llm.get("via_site"):
            return {"via_site": False}
        name = llm.get("cookie") or ""
        token = cookies.get(name) or (next(iter(cookies.values())) if len(cookies) == 1 else "")
        if not token:
            raise Step("не нашёл сессию сайта — войдите заново")
        set_stack_env(ASR_LLM_BASE_URL=site + llm.get("path", SITE_LLM_PATH),
                      ASR_LLM_MODEL=llm.get("model") or "", OR_KEY=token)
        checked = c.get(f"{llm.get('path', SITE_LLM_PATH)}/models",
                        headers={"Authorization": f"Bearer {token}"}).status_code == 200
    if stack_health():
        stack("down")   # адаптер читает файл при старте
    return {"via_site": True, "checked": checked}


# --- шаг 1: транскрибация ------------------------------------------------------------------

def ffmpeg_audio(video: Path, out: Path) -> None:
    if out.is_file() and out.stat().st_size:
        return
    if not shutil.which("ffmpeg"):
        raise Step("нет ffmpeg: brew install ffmpeg")
    say(f"звук из видео → {out.name}")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
                    "-vn", "-acodec", "libmp3lame", "-q:a", "4", str(out)], check=True)


WAVE_BARS = 1200      # столбиков на всю запись: шире окна, мельче — глазу не нужно
WAVE_RATE = 4000      # частота для огибающей; больше незачем, а меньше теряет короткие реплики


def wave_peaks(audio: Path) -> None:
    """Огибающая звука для шкалы в окне: одно событие на всю запись, ~1.6 КБ.

    ⚠️ Нормируем по 99-му ПЕРЦЕНТИЛЮ, а не по максимуму: один хлопок дверью или щелчок микрофона
    иначе придавливает всю запись в ровную ниточку — ради одного столбика теряется вся картинка.

    Украшение не имеет права ронять загрузку: не нашёлся ffmpeg, не встала numpy, битый звук —
    молча уходим, окно нарисует ровную линию.
    """
    try:
        import numpy as np  # noqa: PLC0415 — нужен только здесь

        raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(audio),
                              "-ac", "1", "-ar", str(WAVE_RATE), "-f", "s16le", "-"],
                             check=True, capture_output=True).stdout
        x = np.frombuffer(raw, dtype="<i2")
        if x.size < WAVE_BARS:
            return
        x = np.abs(x[:x.size - x.size % WAVE_BARS].reshape(WAVE_BARS, -1)).max(axis=1)
        top = float(np.percentile(x, 99)) or 1.0
        bars = np.clip(x / top * 255.0, 0, 255).astype("uint8")
        emit("wave.peaks", n=WAVE_BARS, b64=base64.b64encode(bars.tobytes()).decode())
    except Exception as error:  # noqa: BLE001
        say(f"  шкала звука не построилась ({type(error).__name__}) — окно покажет работу без неё")


def options(site: str, cookies: dict) -> dict:
    """Что сайт разрешает и что у него уже есть: рубрики, метки, потолки, шлюз.

    Ошибка здесь не фатальна: без списков поля просто останутся пустыми.
    """
    try:
        with client(site, cookies, timeout=20) as c:
            r = c.get("/api/upload/options")
        return r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        return {}


def ask_llm(site: str, cookies: dict, prompt: str, *, model: str = "", limit: int = 120) -> str:
    """Один короткий вопрос к шлюзу ЧЕРЕЗ САЙТ — той же сессией, что и стадии расшифровки.

    ⚠️ Пустой ответ — НЕ ошибка. Этот канал нужен только чтобы ПОДСТАВИТЬ поле, которое
    человек не заполнил; уронить из-за этого двадцать минут расшифровки было бы дико.
    """
    body = {"model": model or "Instruct", "stream": False, "temperature": 0,
            "messages": [{"role": "user", "content": prompt}]}
    try:
        with client(site, cookies, timeout=90) as c:
            r = c.post(f"{SITE_LLM_PATH}/chat/completions", json=body)
        if r.status_code != 200:
            return ""
        text = (((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        return ""
    return text.strip()[:limit]


def stack_health() -> dict:
    try:
        with client(ASR_BASE, {}, timeout=20) as c:
            r = c.get("/health")
        return r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        return {}


def warm() -> dict:
    """Прогреть бэкенды: модели грузятся по первому запросу, а не при старте.

    ⚠️ Без этого первая стадия МОЛЧИТ минутами — человек видит «идёт работа» и ничего
    больше (живьём: три минуты тишины на первой записи). Греем пока он заполняет поля.
    """
    try:
        with client(ASR_BASE, {}, timeout=900) as c:
            r = c.post("/warmup")
        return r.json() if r.status_code == 200 else {}
    except (httpx.HTTPError, ValueError):
        return {}


def stack(command: str, *, check: bool = True) -> None:
    """Поднять или погасить стек транскрибации.

    ⚠️ `check=False` для гашения — и это не мелочь. `stack.sh down` возвращает 1, если последний
    порт уже свободен (последняя строка функции — ложная проверка `[[ -n … ]] &&`), а гасим мы в
    `finally`: исключение из уборки ЗАМЕНЯЕТ настоящую ошибку. Ловилось 24.09 живьём — человек
    увидел «CalledProcessError: stack.sh down», а на деле не стартовал адаптер.
    """
    script = MORAG_REPO / "services" / "asr-adaptor" / "deploy" / "mac" / "stack.sh"
    if not script.is_file():
        raise Step(f"нет {script}: чекаут morag ожидается рядом (MORAG_REPO) — см. upload-install.sh")
    env = {**os.environ, "ASR_STACK_ENV": str(STACK_ENV)}
    say(f"стек: {command}")
    done = subprocess.run([str(script), command], check=check, env=env)
    if done.returncode and not check:
        say(f"  (гашение вернуло {done.returncode} — не страшно, порты свободны)")


def stack_trouble() -> str:
    """Почему стек не поднялся — последняя внятная строка логов бэкендов.

    Без неё человек видит «стек не отвечает» и идёт спрашивать; с ней он видит «Missing
    credentials» и понимает, что не настроен ключ. Логи пишет сам `stack.sh` (`$STACK/logs`).
    """
    logs = Path(os.environ.get("ASR_STACK_HOME") or STACK_HOME) / "logs"
    out = []
    for name in ("adaptor", "diarizer", "whisper", "campp"):
        path = logs / f"{name}.log"
        if not path.is_file():
            continue
        tail = [x.strip() for x in path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]]
        bad = [x for x in tail if ("Error" in x or "error:" in x.lower()) and "INFO" not in x]
        if bad:
            out.append(f"{name}: {bad[-1][:200]}")
    return "; ".join(out)


def _session_key_off_site(key: str, base: str) -> bool:
    """Ключ в файле стека — строка СЕССИИ сайта, а адрес шлюза ведёт не на сайт.

    ⚠️ Так бывает после переустановки поверх вошедшей сессии: установщик кладёт адрес шлюза с
    зеркала, сессия остаётся — и стадии с ИИ идут прямо в шлюз с чужим для него ключом, 401
    (ловилось 01.10: разбор экрана сыпал «401 Unauthorized» на каждый кадр). Свой ключ человека
    сюда не попадает: он не совпадает ни с одной cookie сайта.
    """
    try:
        site, cookies = load_session(None)
    except Exception:       # noqa: BLE001 — нет сессии: судить не о чем
        return False
    return key in cookies.values() and not (base or "").startswith(site)


def ensure_gateway() -> bool:
    """Перед подъёмом стека убедиться, что стадиям с ИИ есть куда ходить.

    ⚠️ Без ключа адаптер не просто теряет LLM-стадии — он НЕ СТАРТУЕТ вовсе (строит клиента на
    импорте модуля), и снаружи это выглядит как «стек не отвечает» через две минуты ожидания.
    Настройка через сайт делается при входе, но вход мог случиться раньше обновления — поэтому
    проверяем здесь, у самой работы, и чиним молча.
    """
    key, base = stack_env_value("OR_KEY"), stack_env_value("ASR_LLM_BASE_URL")
    if key and not _session_key_off_site(key, base):
        return False
    say("шлюз ещё не настроен — беру доступ у сайта…" if not key
        else "ключ — сессия сайта, а адрес шлюза прямой: настраиваю ход через сайт заново…")
    out = use_site_llm()
    if not out.get("via_site") or not stack_env_value("OR_KEY"):
        raise Step("нечем ходить в LLM-шлюз: войдите на сайт в настройках приложения "
                   "(или впишите свой ключ — «У меня свой ключ»)")
    return True     # файл стека переписан — поднятый стек опущен use_site_llm, поднять заново


def prints_match(prints: Path, artifact: Path) -> bool:
    """Ключи отпечатков — те же метки, что в тексте записи? Иначе сервер их не сопоставит.

    ⚠️ Каталог прогона живёт между запусками: `voices.json`, записанный прежней версией
    (с метками диаризатора), иначе пережил бы и починку — «уже есть — пропускаю».
    """
    try:
        keys = set(json.loads(prints.read_text(encoding="utf-8")))
        x = json.loads(artifact.read_text(encoding="utf-8")).get("x_enriched") or {}
    except (OSError, ValueError, AttributeError):
        return False
    labels = {str(t.get("speaker_id") or t.get("speaker") or "") for t in x.get("turns") or []}
    return bool(keys) and keys <= labels


def voiceprint(work: Path, artifact: Path) -> Path | None:
    """Отпечатки голосов записи — чтобы сервер узнал, КТО говорит, а не выдавал незнакомцев.

    Считает CAM++ из того же стека (он ещё поднят после расшифровки); 192 числа на голос.
    ⚠️ Шаг необязательный и загрузку не роняет: не ответил CAM++ — пакет уедет без отпечатков, и
    сервер разведёт номера по отдельному диапазону, как делал раньше. Потерять запись из-за
    неузнанных голосов было бы куда хуже.
    """
    out = work / "voices.json"
    if out.is_file() and out.stat().st_size and prints_match(out, artifact):
        say("отпечатки голосов уже есть — пропускаю")
        return out
    audio = work / "audio.mp3"
    if not audio.is_file():
        # ⚠️ Молчать тут нельзя: ровно эта тишина и прятала дефект — звук удалялся шагом раньше,
        # отпечатки не считались никогда, и снаружи всё выглядело исправным.
        say("  звука нет — отпечатки голосов пропускаю, голоса приедут безымянными")
        return None
    # ⚠️ Пустой ключ даёт ровно тот же 401, что и неверный, и человек идёт искать проблему в CAM++,
    # а на самом деле приложение смотрит НЕ В ТОТ файл стека (ловилось живьём 25.09).
    if not stack_env_value("ASR_CAMPP_KEY"):
        say(f"  нет ASR_CAMPP_KEY в {stack_env_path()} — отпечатки голосов пропускаю, "
            "голоса приедут безымянными")
        return None
    try:
        import voiceprints   # noqa: PLC0415 — нужен только здесь

        url = stack_env_value("ASR_CAMPP_URL") or voiceprints.DEFAULT_URL
        prints = voiceprints.fingerprints(artifact, audio, url=url,
                                          key=stack_env_value("ASR_CAMPP_KEY"), work=work)
    except Exception as error:  # noqa: BLE001 — любая осечка здесь не повод терять запись
        say(f"  отпечатки голосов не посчитались ({type(error).__name__}: {str(error)[:120]}) — "
            "голоса приедут безымянными")
        return None
    if not prints:
        return None
    out.write_text(json.dumps(prints, ensure_ascii=False), encoding="utf-8")
    say(f"отпечатки голосов: {len(prints)} — сервер узнает знакомых")
    return out


def transcribe(work: Path, video: Path, rid: str, title: str, speakers: list[str],
               on_spans=None) -> Path:
    artifact = work / "artifact.json"
    if artifact.is_file():
        say("транскрибация уже есть — пропускаю")
        return artifact
    if not stack_health():
        why = stack_trouble()
        raise Step(f"стек транскрибации не отвечает на {ASR_BASE}/health"
                   + (f" — {why}" if why else " — поднимите `stack.sh up` или запустите с --stack"))
    audio = work / "audio.mp3"
    ffmpeg_audio(video, audio)
    wave_peaks(audio)      # шкала нужна с первой секунды показа, а не после расшифровки
    hints = json.dumps({"about": title, "names": speakers, "terms": []}, ensure_ascii=False)
    say(f"отправляю звук в адаптер ({size_of(audio.stat().st_size)})…")
    with client(ASR_BASE, {}, timeout=900) as c:
        with audio.open("rb") as fh:
            r = c.post("/v1/audio/transcriptions",
                       files={"file": (audio.name, fh, "audio/mpeg")},
                       data={"mode": "async", "episode": rid, "title": title, "url": str(video),
                         "hints": hints, "events": "1"})
        r.raise_for_status()
        job = r.json()["job_id"]
        say(f"задача {job}; жду (диаризация + whisper + LLM-стадии — на час записи ~10–15 минут)")
        polls = 0
        cursor = 0
        spent = 0.0
        while True:
            time.sleep(EVENT_POLL_SEC)
            spent += EVENT_POLL_SEC
            try:
                s = c.get(f"/v1/jobs/{job}", params={"since": cursor}, timeout=60).json()
            except (httpx.HTTPError, ValueError):
                continue
            # ⚠️ Старый адаптер про ленту не знает и просто не вернёт этих ключей — тогда работаем
            # как раньше, по строке прогресса. Разъезд версий не должен ломать загрузку.
            for evt in s.get("events") or ():
                # ⚠️ Нумерацию и время ставим СВОИ: у адаптера они относительны его задачи, а
                # окну нужна одна шкала на весь прогон — вместе с шагами клиента.
                kind = str(evt.pop("t", "?"))
                fields = {k: v for k, v in evt.items() if k not in ("seq", "at")}
                emit(kind, **fields)
                # ⚠️⚠️ Голоса узнаём СРАЗУ ПОСЛЕ ДИАРИЗАЦИИ, а не после всей расшифровки:
                # границы речи уже есть (они в самом событии), звук лежит рядом, CAM++ свободен.
                # Ждать артефакт значит светить человеку `SPEAKER_00` всю работу.
                if kind == "diar.spans" and on_spans is not None:
                    on_spans(fields)
            if s.get("dropped"):
                # Дыру показываем, а не прячем: иначе картинка будет плавной, но с провалом.
                emit("gap", n=int(s["dropped"]))
            cursor = int(s.get("cursor") or cursor)
            status = s.get("status")
            if status == "done":
                break
            if status == "error":
                raise Step(f"адаптер вернул ошибку: {json.dumps(s, ensure_ascii=False)[:600]}")
            polls += 1
            if spent >= 60 and polls % int(60 / EVENT_POLL_SEC) == 0:
                say(f"  …{s.get('progress', status)} (~{int(spent)} с)")
    result = s["result"]
    x = result.get("x_enriched") or {}
    if not x.get("markdown") or not (x.get("words") or {}).get("turns"):
        raise Step("в ответе адаптера нет x_enriched.markdown/words — это не тот адаптер или прогон без выравнивания")
    artifact.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    (work / "transcript.md").write_text(x["markdown"], encoding="utf-8")
    # ⚠️⚠️ Звук здесь НЕ удаляем. Удалял — и следующий шаг, отпечатки голосов, молча не работал
    # НИ РАЗУ: он читает тот же `audio.mp3` и без него просто возвращает `None`. Пакет уезжал без
    # `voices.json`, сервер честно откатывался на «незнакомцы под номерами», и узнавание голосов,
    # ради которого всё это заведено, не срабатывало вообще. Тесты не ловили: они создают
    # `audio.mp3` руками, а порядок шагов конвейера не проверял никто.
    # Теперь звук живёт до конца работы: его же читает шкала волны в окне, и на возобновлённом
    # прогоне не приходится снова гонять ffmpeg по гигабайтному видео.
    say(f"расшифровка готова: {work / 'transcript.md'}")
    return artifact


# --- шаг 2: экран из видео -----------------------------------------------------------------

def temp_family() -> Path:
    """Семья с пустыми словарями — только чтобы собрать `record.words.json` для обращений к экрану."""
    fam = HOME / "family"
    if not (fam / "site.yml").is_file():
        fam.mkdir(parents=True, exist_ok=True)
        (fam / "site.yml").write_text('slug: local\nbrand: {title: "Локальная сборка"}\n', encoding="utf-8")
        for name, body in (("names.json", {"speakers": {}, "records": {}}),
                           ("text_fixes.json", {"global": [], "records": {}}),
                           ("turn_fixes.json", {"records": {}})):
            (fam / name).write_text(json.dumps(body), encoding="utf-8")
        (fam / "records").mkdir(exist_ok=True)
        (fam / "inbox").mkdir(exist_ok=True)
    return fam


def local_record(work: Path, artifact: Path, rid: str, title: str, date: str) -> Path:
    fam = temp_family()
    record = fam / "records" / rid
    if (record / "record.words.json").is_file():
        return record
    src = fam / "inbox" / f"{rid}.json"
    shutil.copy2(artifact, src)
    env = {**os.environ, "MORAG_WEB_CORPUS": str(fam)}
    say("черновик записи — по нему обращения «вот здесь» привязываются к экрану "
        "(видео и настоящая запись собираются на сервере)")
    subprocess.run([sys.executable, str(HERE / "make_record.py"), str(src), "--id", rid, "--title", title,
                    "--date", date, "--no-media"], check=True, env=env, cwd=str(REPO))
    if not (record / "record.words.json").is_file():
        raise Step("локальная сборка не дала record.words.json")
    return record


def shot_at(video: Path) -> str:
    """Когда запись СНЯТА — по метаданным самого файла, `YYYY-MM-DD` или пусто.

    ⚠️ Дата файла для этого плоха: скачали из архива — и «создан» сегодня. А Teams, Zoom и камеры
    кладут в контейнер настоящее время съёмки. Пусто — зовущий решает сам, что брать дальше.
    """
    try:
        done = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags=creation_time",
                               "-of", "default=nw=1:nk=1", str(video)],
                              capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    raw = (done.stdout or "").strip()[:10]
    return raw if len(raw) == 10 and raw[4] == "-" and raw[7] == "-" and raw[:4].isdigit() else ""


def has_video_stream(video: Path) -> bool:
    """Есть ли в файле картинка вообще.

    ⚠️ Галочки «разобрать экран» больше нет — экран разбираем всегда. Значит, файл без
    видеодорожки (бывает: запись встречи сохранили одним звуком в контейнере mp4) обязан
    пройти целиком, а не упасть на первом же шаге разбора кадров.
    """
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                              "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(video)],
                             capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return True                      # не смогли спросить — пробуем разобрать, как раньше
    return "video" in out.stdout


def run_step(argv: list[str], env: dict, record: Path) -> subprocess.CompletedProcess:
    """Запустить шаг экрана и ЧИТАТЬ его вывод ПО СТРОКАМ.

    ⚠️ Потоком, а не `communicate()`: иначе весь прогресс придёт одной пачкой в конце — то есть
    его не будет вовсе. Раньше вывод просто наследовался в терминал, и окно всё время разбора
    молчало, даже когда все кадры падали один за другим.
    """
    proc = subprocess.Popen(argv, env=env, cwd=str(REPO), stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout or []:
        line = line.rstrip()
        if not line:
            continue
        if line.startswith("@progress "):
            try:
                fields = json.loads(line[len("@progress "):])
            except ValueError:
                continue
            # Детектор кадров говорит, сколько записи просмотрел, — это не кадр, а ход работы.
            if fields.pop("scan", None):
                emit("screen.scan", **fields)
                continue
            frame = str(fields.pop("frame", "") or "")
            # ⚠️⚠️ Секунда КАДРА приезжает от `describe_slides` под именем `at`, а `at` в конверте
            # события — время прогона. Поле молча затирало конверт: стенд играет трассу по `at` и
            # на первом же кадре прыгал в начало записи. Секунда кадра зовётся `sec`.
            if "at" in fields:
                fields["sec"] = fields.pop("at")
            emit("screen.frame", path=str(record / frame) if frame else "", **fields)
            continue
        say(line)
    proc.wait()
    return subprocess.CompletedProcess(argv, proc.returncode)


def screen(work: Path, video: Path, record: Path, *, only_video: bool = False) -> None:
    """Разбор экрана. `only_video` — первые три шага, которым хватает САМОГО ВИДЕО.

    ⚠️⚠️ Деление не техническое, а по входным данным: шкала кадров, заставка и описания Vision
    знают только видеофайл, а «вот здесь» (`screen_refs`) привязывается к СЛОВАМ расшифровки, и
    аннотации собираются уже из обоих сайдкаров. Отсюда и весь смысл круга: первую тройку можно
    считать ПАРАЛЛЕЛЬНО расшифровке — и занять ею те первые минуты, где окно раньше молчало
    (владелец, 25.09: «пока идёт диаризация и первое прослушивание, ничего не происходит»).
    ⚠️ Завершение (сайдкары в пакет, `slides.zip`, отметка `screen.done`) делает только ПОЛНЫЙ
    прогон: после ранней тройки экран ещё не готов.
    """
    done = work / "screen.done"
    if done.is_file():
        say("экран уже снят — пропускаю")
        return
    if not has_video_stream(video):
        say("в файле нет видеодорожки — экран разбирать нечего")
        if not only_video:
            done.write_text("no-video\n", encoding="utf-8")
        return
    py = VIDEO_PY if VIDEO_PY.is_file() else Path(sys.executable)
    env = {**os.environ, "ASR_STACK_ENV": str(STACK_ENV), "MORAG_WEB_CORPUS": str(temp_family())}
    steps = [
        ("шкала слайдов и кадры", ["slides_from_video.py", str(video), "--record", str(record)]),
        ("заставка", ["intro_frame.py", str(video), "--record", str(record)]),
        ("описания кадров (Vision)", ["describe_slides.py", str(record)]),
        ("обращения к экрану", ["screen_refs.py", str(record), "--resolve", "--video", str(video)]),
        ("аннотации", ["make_annotations.py", str(record)]),
    ]
    if only_video:
        steps = steps[:3]
        # ⚠️⚠️ Ранний Vision УСТУПАЕТ расшифровке: у сайта на человека 4 слота к шлюзу с очередью
        # в 180 с (`app/config.py::upload.llm.slots`), а адаптер на своих стадиях шлёт до восьми
        # запросов разом. Три наших кадра в очереди — это стадия расшифровки, ждущая нашего
        # показа; меняем скорость описаний (их и так есть чем занять первые минуты) на то, чтобы
        # главная работа не ждала. После расшифровки полный прогон идёт с обычной тройкой.
        steps[2] = (steps[2][0], [*steps[2][1], "--concurrency", "1"])
    env["MORAG_PROGRESS"] = "1"
    for label, argv in steps:
        say(f"экран: {label}")
        emit("client.step", step="screen", lane="side", say=label)
        proc = run_step([str(py), str(HERE / argv[0]), *argv[1:]], env, record)
        if proc.returncode:
            raise Step(f"экран: «{label}» не прошёл (код {proc.returncode}); повторный запуск продолжит отсюда")
    if only_video:
        emit("client.step", step="screen", lane="side", say="экран разобран", done=True)
        say("экран: кадры и описания готовы — обращения свяжем, когда будет расшифровка")
        return
    for name in SIDECARS:
        if (record / name).is_file():
            shutil.copy2(record / name, work / name)
    frames = sorted((record / "slides").glob("*.jpg")) if (record / "slides").is_dir() else []
    if frames:
        with zipfile.ZipFile(work / "slides.zip", "w", zipfile.ZIP_STORED) as z:
            for f in frames:
                z.write(f, f.name)
    done.write_text(time.strftime("%Y-%m-%dT%H:%M:%S"), encoding="utf-8")
    say(f"экран готов: кадров {len(frames)}")


def screen_ahead(work: Path, video: Path, record: Path) -> None:
    """Ранняя тройка шагов экрана — фоном, пока идёт расшифровка.

    ⚠️ Падение здесь НЕ роняет прогон: расшифровка главная, экран — дополнение, а недостающее
    доделает полный `screen()` после неё (каждый шаг возобновляем). Обратный порядок значимости
    стоил бы человеку двадцати минут работы из-за одного неудачного кадра.
    """
    try:
        screen(work, video, record, only_video=True)
    except Step as error:
        say(f"экран пока не вышел ({error}); доберём после расшифровки")
        emit("client.step", step="screen", lane="side", say="экран отложен", done=True)
    except Exception as error:  # noqa: BLE001 - показ не имеет права ронять загрузку
        say(f"экран пока не вышел ({type(error).__name__}: {error}); доберём после расшифровки")
        emit("client.step", step="screen", lane="side", say="экран отложен", done=True)


# --- шаг 3: загрузка ------------------------------------------------------------------------

class Progress:
    """Файл, который считает отданные байты: у видео это единственный способ увидеть, что идёт.

    ⚠️ Двух получателей у счётчика два, и темп у них РАЗНЫЙ: в лог строкой раз в пять секунд
    (иначе он превращается в простыню), в окно — событием раз в семьсот миллисекунд, потому что
    там полоса, и на пяти секундах она выглядела бы зависшей. До 25.09 второго получателя не
    было вовсе: загрузка гигабайтного видео шла только в консоль (владелец: «тут уже надо
    показывать в браузере»).
    """

    BEAT = 0.7          # как часто событие в окно

    def __init__(self, path: Path, label: str, on_move=None) -> None:
        self.fh = path.open("rb")
        self.total = path.stat().st_size
        self.sent = 0
        self.label = label
        self.last = 0.0
        self.on_move = on_move
        self.beat = 0.0

    def read(self, n: int = -1) -> bytes:
        chunk = self.fh.read(n if n > 0 else 1 << 20)
        self.sent += len(chunk)
        now = time.monotonic()
        if self.total > 50_000_000 and now - self.last > 5:
            self.last = now
            say(f"  {self.label}: {self.sent * 100 // max(1, self.total)} % ({size_of(self.sent)} из {size_of(self.total)})")
        if self.on_move and (not chunk or now - self.beat > self.BEAT):
            self.beat = now
            self.on_move(self.sent, not chunk)
        return chunk

    def __iter__(self):
        while True:
            chunk = self.read(1 << 20)
            if not chunk:
                self.fh.close()
                return
            yield chunk


def upload(work: Path, site: str, cookies: dict[str, str], manifest: dict, files: list[tuple[str, Path]],
           video: Path, wait: bool) -> str:
    emit("client.step", step="send", say="отправляю на сайт")
    state_path = work / "state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.is_file() else {}
    with client(site, cookies, timeout=httpx.Timeout(600.0, connect=30.0)) as c:
        rid = state.get("server_id")
        if not rid:
            r = c.post("/api/upload", json=manifest)
            if r.status_code == 401:
                raise Step("сессия сайта протухла: `upload.py login`")
            if r.status_code != 200:
                raise Step(f"сайт отверг манифест ({r.status_code}): {r.json().get('detail', r.text)}")
            rid = r.json()["id"]
            state["server_id"] = rid
            state_path.write_text(json.dumps(state), encoding="utf-8")
        sent = set(state.get("sent") or [])
        # ⚠️ Очередь считаем ЗАРАНЕЕ и целиком: окно рисует список файлов с полосами, и «сколько
        # всего» должно быть известно до первого байта, а не выясняться по ходу.
        queue = [(name, path) for name, path in files + [(manifest["video"], video)]
                 if name not in sent and path.is_file()]
        sizes = {name: path.stat().st_size for name, path in queue}
        whole = sum(sizes.values())
        emit("upload.begin", files=[{"name": n, "bytes": sizes[n]} for n, _ in queue], bytes=whole)
        moved = 0
        for i, (name, path) in enumerate(queue, 1):
            size = sizes[name]
            say(f"загружаю {name} ({size_of(size)})")

            def moving(done: int, fin: bool, *, name=name, i=i, size=size, base=moved) -> None:
                emit("upload.file", name=name, i=i, n=len(queue), sent=done, bytes=size,
                     moved=base + done, whole=whole, done=bool(fin))

            moving(0, False)
            body = Progress(path, name, on_move=moving)
            r = c.put(f"/api/upload/{rid}/files/{name}", content=body,
                      headers={"Content-Length": str(body.total), "Content-Type": "application/octet-stream"})
            if r.status_code != 200:
                raise Step(f"{name}: сайт ответил {r.status_code}: {r.text[:300]}")
            moving(size, True)
            moved += size
            sent.add(name)
            state["sent"] = sorted(sent)
            state_path.write_text(json.dumps(state), encoding="utf-8")
        r = c.post(f"/api/upload/{rid}/finish")
        if r.status_code != 200:
            raise Step(f"приём не запустился ({r.status_code}): {r.json().get('detail', r.text)}")
        say(f"пакет принят, сервер собирает запись {rid}")
        emit("upload.state", state="accepted")
        if not wait:
            return rid
        seen = ""
        while True:
            time.sleep(5)
            s = c.get(f"/api/upload/{rid}").json()
            if s.get("state") != seen:
                seen = s.get("state")
                say(f"  сервер: {seen}")
                emit("upload.state", state=seen or "")
            if seen == "done":
                say(f"готово: {site}{s.get('url') or ''}")
                globals()["LAST_SEARCH"] = s.get("search") or ""
                globals()["LAST_URL"] = f"{site}{s.get('url')}" if s.get("url") else ""
                if s.get("search") == "later":
                    say("  (в поиске запись появится после ближайшей плановой индексации — обычно ночью)")
                emit("upload.state", state="done", search=s.get("search") or "")
                return rid
            if seen == "error":
                emit("upload.state", state="error", error=str(s.get("error") or "")[:300])
                raise Step(f"сервер не принял запись: {s.get('error')}")


# --- run ---------------------------------------------------------------------------------------

def as_list(value) -> list[str]:
    """Поле-список приходит ДВУМЯ видами: из формы — строкой через запятую, из карточки перед
    отправкой — уже списком (фронт разбирает его сам). Принимаем оба.

    ⚠️ Раньше на этом пути стоял безусловный `.split(",")`, и кнопка «Загрузить» из карточки
    падала на `AttributeError` у списка — то есть ровно там, ради чего карточка и сделана.
    """
    items = value.split(",") if isinstance(value, str) else list(value or [])
    return [str(x).strip() for x in items if str(x).strip()]


def check_fields(video: Path, title: str, date: str, slides: str | None,
                 attach: list[str] | None = None) -> dict:
    """Проверить то, что ввёл человек, ДО долгой работы: час расшифровки и отказ на загрузке
    из-за кривой даты — худшее, что можно сделать с его временем. Возвращает разобранные поля."""
    if not video.is_file():
        raise Step(f"нет файла {video}")
    ext = video.suffix.lower().lstrip(".")
    if ext not in VIDEO_EXT:
        raise Step(f"видео — {', '.join(VIDEO_EXT)}; у вас .{ext}")
    if len(date) != 10 or date[4] != "-" or date[7] != "-" or not date.replace("-", "").isdigit():
        raise Step("дата — в виде ГГГГ-ММ-ДД")
    if len(title.strip()) < 3:
        raise Step("название — от трёх знаков")
    rid = f"{date}-{slugify(title)}"
    if not rid.rsplit("-", 1)[-1]:
        raise Step("из названия не вышло адреса записи — напишите его словами")
    slides_pdf = Path(slides).expanduser().resolve() if slides else None
    if slides_pdf and not slides_pdf.is_file():
        raise Step(f"нет слайдов {slides_pdf}")
    # Материалы проверяем тем же правилом имени, что и сервер (`attach_names`): отказ сайта
    # после часа расшифровки из-за расширения — то, чего нельзя делать с временем человека.
    materials: list[tuple[str, Path]] = []
    for raw in attach or []:
        path = Path(raw).expanduser().resolve()
        if not path.is_file():
            raise Step(f"нет файла {path}")
        try:
            name = attach_names.safe_name(path.name)
        except ValueError as error:
            raise Step(str(error)) from None
        if name in {n for n, _ in materials}:
            raise Step(f"два материала с одним именем: {name}")
        materials.append((name, path))
    return {"id": rid, "ext": ext, "slides": slides_pdf, "materials": materials}


def pipeline(video: Path, *, title: str, date: str, event: str = "", speakers: list[str] | None = None,
             tags: list[str] | None = None, summary: str = "", slides: str | None = None,
             site: str | None = None, with_stack: bool = False, with_screen: bool = True,
             wait: bool = True, title_auto: bool = False, should_upload=None, rid: str = "",
             attach: list[str] | None = None, discussion: str = "") -> str:
    """Весь путь записи: расшифровка → экран → пакет на сайт. Общий для командной строки и для
    страницы (`upload_ui.py`) — шаги, возобновление и сообщения обязаны быть одни и те же.

    ⚠️⚠️ `rid` — адрес РАБОЧЕГО КАТАЛОГА, и его можно задать снаружи. По умолчанию он считается из
    названия и даты (`check_fields`), а значит МЕНЯЕТСЯ, стоит поправить любое из них. Владелец
    поправил метаданные в карточке перед отправкой — и вторая половина пути не нашла ни
    `artifact.json`, ни кадров в новом каталоге: запись пошла расшифровываться заново, двадцать
    минут впустую (25.09). Поэтому окно передаёт адрес первого прогона, а название и дата
    остаются тем, чем и были, — полями манифеста: идентификатор записи на сайте выдаёт сервер.
    """
    video = Path(video).expanduser().resolve()
    fields = check_fields(video, title, date, slides, attach)
    rid, ext, slides_pdf = (rid or fields["id"]), fields["ext"], fields["slides"]
    discussion = (discussion or "").strip()
    if discussion and not discussion.startswith(("http://", "https://")):
        raise Step("ссылка на обсуждение — адрес вида https://…")
    speakers = as_list(speakers)
    tags = as_list(tags)
    site_url, cookies = load_session(site)
    work = HOME / rid
    work.mkdir(parents=True, exist_ok=True)
    say(f"запись {rid} — рабочий каталог {work}")

    stack_started = False
    known_voices: dict = {}    # метка → {voice, name, air}; наполняется фоном сразу после диаризации
    try:
        # ⚠️ Шлюз проверяем ВСЕГДА, а не только когда стек ещё не поднят: окно поднимает стек
        # заранее (прогрев), и с прямым адресом шлюза вместо ручки сайта он жил бы всю работу —
        # 401 на каждой стадии с ИИ (ловилось 01.10 после переустановки). Перенастроили — стек
        # опущен (адаптер читает файл при старте) и поднимается заново.
        if with_stack and not (work / "artifact.json").is_file():
            if ensure_gateway() or not stack_health():
                stack("up")
                stack_started = True
        TRACE[:] = [work / "events.jsonl"]   # трасса прогона: по ней настраивается окно (стенд)
        emit("client.step", step="audio", say="звук из видео")
        def spans_ready(fields: dict) -> None:
            threading.Thread(target=early_voices, daemon=True, name="voices",
                             args=(work, fields, site_url, cookies, rid, known_voices)).start()

        # ⚠️⚠️ Разбор экрана уезжает ВПЕРЁД и идёт параллельно расшифровке (владелец, 25.09):
        # первые минуты (звук из видео + диаризация) в окне были пустыми — расшифровки ещё нет
        # вовсе, а кадрам и описаниям речь не нужна. Работа всё равно нужна, просто теперь она
        # накладывается на ожидание, а не добавляется к нему.
        # ⚠️ Каталог черновика создаём ЗДЕСЬ, до потока: на возобновлённом прогоне `transcribe`
        # вернётся мгновенно, и `local_record` полез бы в `temp_family()` ровно тогда же, когда
        # её создаёт поток.
        draft = temp_family() / "records" / rid
        screen_early = None
        if with_screen:
            draft.mkdir(parents=True, exist_ok=True)
            screen_early = threading.Thread(target=screen_ahead, daemon=True, name="screen",
                                            args=(work, video, draft))
            screen_early.start()

        artifact = transcribe(work, video, rid, title, speakers, on_spans=spans_ready)
        emit("client.step", step="voices", say="отпечатки голосов")
        voiceprint(work, artifact)
        # Узнали раньше (по спанам диаризации) — второй раз не спрашиваем.
        if not known_voices:
            known_voices.update(identify_voices(work, site_url, cookies, rid))
        if with_screen:
            emit("client.step", step="record", say="черновик записи")
            record = local_record(work, artifact, rid, title, date)
            # Ждём фоновую тройку: обращения к экрану опираются на её сайдкар.
            if screen_early is not None:
                screen_early.join()
            emit("client.step", step="screen", say="экран из видео")
            screen(work, video, record)
    finally:
        if stack_started:
            stack("down", check=False)

    # ⚠️ Человек поля НЕ ЗАПОЛНЯЛ — значит, заполняем сами (владелец, 24.09). Спрашивать
    # его после двадцати минут работы некого: он ушёл. Незаполненные поля — это запись без
    # рубрики (а рубрика решает ветку и год) и без меток, то есть запись, которую не найти.
    event, tags, speakers = auto_fields(artifact, site_url, cookies, title=title, event=event,
                                       tags=tags, speakers=speakers, voices=known_voices)

    manifest = {"title": title, "date": date, "event": event or "", "tags": tags,
                "summary": summary or "", "speakers": speakers, "video": f"video.{ext}",
                # «название подставилось само» — чтобы сервер знал, можно ли его переписать
                "title_auto": bool(title_auto), "discussion": discussion}
    # ⚠️ Что именно уедет на сайт — ОДНИМ событием, перед самой отправкой. До этого подставленных
    # полей в окне не было вовсе: `field.auto` никто не разбирал, а состояние хранило только
    # введённое при старте — человек видел результат только строкой в свёрнутом логе.
    emit("manifest.ready", **{k: v for k, v in manifest.items() if k != "video"},
         id=rid, work=str(work), **record_size(work, known_voices))
    files: list[tuple[str, Path]] = [("artifact.json", artifact)]
    if (work / "voices.json").is_file():
        files.append(("voices.json", work / "voices.json"))
    files += [(name, work / name) for name in SIDECARS if (work / name).is_file()]
    if (work / "slides.zip").is_file():
        files.append(("slides.zip", work / "slides.zip"))
    if slides_pdf:
        files.append(("slides.pdf", slides_pdf))
    # Материалы — под `attach-<имя>`: сервер кладёт их в `files/` записи и в её список.
    files += [(f"attach-{name}", path) for name, path in fields["materials"]]
    # ⚠️ Спрашиваем ПЕРЕД ОТПРАВКОЙ, а не на старте: галочку «загрузить после расшифровки»
    # можно снять ПО ХОДУ работы (владелец, 25.09) — человек увидел расшифровку и передумал.
    # Пакет при этом собран и лежит в рабочей папке: отправить позже — тот же шаг, без пересчёта.
    if should_upload is not None and not should_upload():
        say("на сайт не отправляю — галочка снята; пакет готов в " + str(work))
        emit("client.step", step="held", say="готово, но не отправлено")
        return ""
    rid = upload(work, site_url, cookies, manifest, files, video, wait=wait)
    # Звук держим до этого места: до принятия пакета он может понадобиться — отпечаткам голосов,
    # шкале волны в окне и возобновлённому прогону (иначе ffmpeg снова полезет в гигабайтное
    # видео). Пакет принят — больше не нужен.
    (work / "audio.mp3").unlink(missing_ok=True)
    return rid


# Доля эфира, с которой голос считается выступавшим, а не спросившим из зала (владелец: «больше
# например 20%»). Тот же порядок, что у ролей в корпусе: ведущий открывает встречу и говорит мало.
SPEAKER_SHARE = 0.2


EARLY_PRINTS = "voices.early.json"   # отпечатки по диаризации — для показа, на сайт не едут


def early_voices(work: Path, spans_event: dict, site: str, cookies: dict, episode: str,
                 done: dict) -> None:
    """Отпечатки и узнавание СРАЗУ ПОСЛЕ ДИАРИЗАЦИИ, фоном.

    Событие несёт отрезки `[начало, конец, номер голоса]` и список меток — ровно то, что
    нужно CAM++. Звук лежит рядом с начала работы.
    ⚠️ Фоном — чтобы не задержать опрос адаптера: пока считаются отпечатки, идёт пасс-1.
    ⚠️ Шаг необязателен целиком: нет ключа к CAM++, нет сессии, молчит сайт — просто не будет
    имён, а после расшифровки отпечатки посчитаются по-старому.
    """
    audio = work / "audio.mp3"
    key = stack_env_value("ASR_CAMPP_KEY")
    if not audio.is_file() or not key:
        return
    labels = list(spans_event.get("speakers") or [])
    by_label: dict[str, dict] = {}
    for item in spans_event.get("spans") or []:
        try:
            a, b, idx = float(item[0]), float(item[1]), int(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        if b <= a or idx >= len(labels):
            continue
        rec = by_label.setdefault(labels[idx], {"spans": [], "air_sec": 0.0})
        rec["spans"].append((a, b))
        rec["air_sec"] += b - a
    if not by_label:
        return
    try:
        import voiceprints   # noqa: PLC0415 — нужен только здесь
        prints = voiceprints.from_spans(by_label, audio,
                                        url=stack_env_value("ASR_CAMPP_URL") or voiceprints.DEFAULT_URL,
                                        key=key, work=work)
    except Exception as error:      # noqa: BLE001 — узнавание не имеет права ронять прогон
        say(f"  ранние отпечатки не посчитались ({type(error).__name__}) — спросим позже")
        return
    if not prints:
        return
    # ⚠️⚠️ В СВОЙ файл, не в `voices.json`. Ранние отпечатки ключуются метками ДИАРИЗАТОРА
    # (`SPEAKER_00`), а текст записи — номерами конвейера (`Speaker_0`); после `resplit` и раскладка
    # голосов другая. Лёжа в `voices.json`, они отменяли финальный подсчёт («уже есть — пропускаю»),
    # и сервер не находил в карте ни одной метки текста: все голоса отдавались самому длинному —
    # доклад с ведущим приехал одним человеком (владелец, 01.10). Ранние — только для показа имён.
    (work / EARLY_PRINTS).write_text(json.dumps(prints, ensure_ascii=False), encoding="utf-8")
    done.update(identify_voices(work, site, cookies, episode, name=EARLY_PRINTS))


def identify_voices(work: Path, site: str, cookies: dict, episode: str = "",
                    name: str = "voices.json") -> dict:
    """Кто говорит — СПРАШИВАЕМ У САЙТА, не дожидаясь приёма записи.

    ⚠️ Номера голосов на этой машине НИЧЕГО НЕ ЗНАЧАТ: реестр корпуса живёт на сервере, и
    `Speaker_3` отсюда — не его `Speaker_3`. Поэтому спрашиваем по ОТПЕЧАТКАМ и только чтобы
    ПОКАЗАТЬ имена человеку и подставить докладчиков; настоящие номера присвоит сервер при приёме.
    ⚠️⚠️ Спрашиваем `dry` — иначе узнавание ПИШЕТ в реестр и занимает номера под запись,
    которую ещё не приняли (ловилось на сервере 24.09).
    ⚠️ Имена берём ОТДЕЛЬНЫМ запросом: узнавание отвечает номерами, а имена живут в словаре
    (`names.json`), который реестр не читает вовсе.
    """
    path = work / name
    if not path.is_file():
        return {}
    try:
        prints = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not prints:
        return {}
    body = {"episode": episode, "dry": True,
            "voices": {k: {"centroid": v.get("centroid"), "air_sec": v.get("air_sec", 0)}
                       for k, v in prints.items() if v.get("centroid")}}
    if not body["voices"]:
        return {}
    try:
        with client(site, cookies, timeout=120) as c:
            r = c.post("/api/voices/identify", json=body)
            if r.status_code != 200:
                return {}
            answer = r.json()
            # ⚠️⚠️ Имена спрашиваем ПОИМЁННО, а не одним запросом за снимком: `/api/voices` отдаёт
            # СНИМОК (`tools/voices.py --scan`), а он на сервере месячной давности — голоса, названные
            # позже, в нём просто отсутствуют, и имён не было вовсе (три прогона подряд в окне
            # светились `SPEAKER_X`). Карточка одного голоса берёт имя ПРЯМО из словаря и от
            # снимка не зависит; голосов в записи единицы — цена вопроса ничтожна.
            names = {}
            for voice in dict.fromkeys((answer.get("map") or {}).values()):
                one = c.get(f"/api/voices/{voice}")
                if one.status_code == 200:
                    names[voice] = (one.json() or {}).get("name") or ""
    except (httpx.HTTPError, ValueError):
        return {}
    by_label = {}
    for label, voice in (answer.get("map") or {}).items():
        by_label[label] = {"voice": voice, "name": names.get(voice, ""),
                           "air": float(prints.get(label, {}).get("air_sec") or 0)}
    if by_label:
        known = sorted({v["name"] for v in by_label.values() if v["name"]})
        say(f"голоса: сайт узнал {len(by_label)}"
            + (f", по именам — {', '.join(known)}" if known else ", имён у них пока нет"))
        emit("voices.named", by_label=by_label)
    return by_label


def record_size(work: Path, voices: dict) -> dict:
    """Что внутри записи числами — для карточки перед отправкой. Нет данных — нет ключа:
    ноль выглядит как ошибка, а пустота — как пустота."""
    out: dict = {}
    if voices:
        out["voices"] = len(voices)
    transcript = work / "transcript.md"
    if transcript.is_file():
        out["chars"] = len(transcript.read_text(encoding="utf-8"))
    artifact = work / "artifact.json"
    if artifact.is_file():
        try:
            data = json.loads(artifact.read_text(encoding="utf-8"))
            sec = float(((data.get("x_enriched") or {}).get("coverage") or {}).get("audio_sec") or 0)
            if sec:
                out["duration"] = round(sec)
        except (OSError, ValueError, TypeError):
            pass
    slides = work / "record.slides.json"
    if slides.is_file():
        try:
            data = json.loads(slides.read_text(encoding="utf-8"))
            frames = [e for e in (data.get("slides") or []) if e.get("frame")]
            if frames:
                out["frames"] = len(frames)
        except (OSError, ValueError):
            pass
    return out


def digest_of(artifact: Path, limit: int = 1200) -> str:
    """О чём запись — короткой выжимкой для вопроса к LLM: сводка расшифровки и термины.

    ⚠️ Целиком расшифровку не шлём: час речи — это десятки тысяч токенов ради выбора
    одной строки. Сводку движок уже сделал сам (`x_enriched.doc_summary`).
    """
    try:
        data = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    rich = data.get("x_enriched") or {}
    parts = [str(rich.get("doc_summary") or "")]
    gloss = rich.get("glossary") or []
    terms = [str(g.get("term") or g) for g in gloss][:20]
    if terms:
        parts.append("Термины: " + ", ".join(terms))
    if not parts[0]:
        parts[0] = (rich.get("markdown") or "")[:800]
    return "\n".join(p for p in parts if p)[:limit]


def auto_fields(artifact: Path, site: str, cookies: dict, *, title: str,
                event: str, tags: list[str], speakers: list[str] | None = None,
                voices: dict | None = None) -> tuple[str, list[str], list[str]]:
    """Чего человек не выбрал — выбираем сами, ПО ЗАПИСИ.

    Рубрика и метки — два отдельных коротких вопроса, а не один общий: ответ на каждый
    проверяется по СВОЕМУ списку, и промах в одном не портит другой.
    ⚠️ Выбираем только ИЗ СУЩЕСТВУЮЩЕГО (рубрики — из правил раскладки, метки — из корпуса):
    сочинённая рубрика отправит запись не в ту ветку, а сочинённая метка размоет фильтр.
    ⚠️ Шаг НЕОБЯЗАТЕЛЬНЫЙ: нет сессии, молчит шлюз, пустой ответ — поле остаётся пустым,
    и это честнее, чем уронить прогон или выбрать наугад.
    """
    speakers = list(speakers or [])
    # Докладчики — те, кто ГОВОРИЛ, а не все названные: ведущий открывает каждую встречу
    # и в списке докладчиков ему не место. Безымянный голос в список не попадает вовсе:
    # «Speaker_7» в поле «докладчики» — это хуже, чем пусто.
    if not speakers and voices:
        total = sum(float(v.get("air") or 0) for v in voices.values())
        if total > 0:
            loud = [(float(v.get("air") or 0), v.get("name") or "") for v in voices.values()
                    if (v.get("name") or "") and float(v.get("air") or 0) / total >= SPEAKER_SHARE]
            speakers = [name for _, name in sorted(loud, key=lambda x: -x[0])]
            if speakers:
                say("докладчики не заданы — по эфиру: " + ", ".join(speakers))
                emit("field.auto", field="speakers", value=", ".join(speakers))
    if event and tags:
        return event, tags, speakers
    opts = options(site, cookies)
    model = ((opts.get("llm") or {}).get("model") or "")
    digest = digest_of(artifact)
    if not digest:
        return event, tags, speakers

    if not event and opts.get("events"):
        choices = list(opts["events"])
        answer = ask_llm(site, cookies, (
            "Ниже — о чём запись выступления. Выбери ОДНУ рубрику из списка и ответь ТОЛЬКО ею, "
            "без пояснений.\n\nСписок: " + "; ".join(choices)
            + f"\n\nНазвание: {title}\n{digest}"), model=model)
        pick = next((c for c in choices if c.casefold() == answer.casefold()), "")
        if not pick:
            pick = next((c for c in choices if c.casefold() in answer.casefold()), "")
        if pick:
            event = pick
            say(f"рубрика не задана — выбрали «{pick}»")
            emit("field.auto", field="event", value=pick)

    if not tags and opts.get("tags"):
        known = list(opts["tags"])[:200]
        answer = ask_llm(site, cookies, (
            "Ниже — о чём запись. Выбери до четырёх меток СТРОГО из списка, через запятую, "
            "без пояснений. Не подходит ни одна — ответь прочерк.\n\nСписок: " + ", ".join(known)
            + f"\n\nНазвание: {title}\n{digest}"), model=model, limit=200)
        low = {t.casefold(): t for t in known}
        picked = [low[part] for part in
                  (p.strip(" .\u00ab\u00bb\"'").casefold() for p in answer.split(",")) if part in low]
        if picked:
            tags = picked[:4]
            say("метки не заданы — выбрали: " + ", ".join(tags))
            emit("field.auto", field="tags", value=", ".join(tags))
    return event, tags, speakers


def cmd_run(args: argparse.Namespace) -> int:
    pipeline(Path(args.video),
             title=args.title, date=args.date, event=args.event,
             speakers=[s.strip() for s in (args.speakers or "").split(",") if s.strip()],
             tags=[t.strip() for t in (args.tags or "").split(",") if t.strip()],
             summary=args.summary or "", slides=args.slides, site=args.site,
             with_stack=args.stack, with_screen=not args.no_screen, wait=not args.no_wait,
             attach=args.attach or [], discussion=args.discussion or "")
    return 0


def cmd_ui(args: argparse.Namespace) -> int:
    """Страница вместо командной строки: поднять локальный сервер и открыть браузер."""
    import upload_ui
    return upload_ui.serve(port=args.port, open_browser=not args.no_open)


def cmd_app(args: argparse.Namespace) -> int:
    """Окно приложения. Нет PyObjC (не мак, урезанный питон) — та же страница в браузере."""
    import upload_app
    if not args.browser and upload_app.available():
        return upload_app.run(port=args.port)
    import upload_ui
    say("окна нет (нужен PyObjC) — открываю страницу в браузере")
    return upload_ui.serve(port=args.port, open_browser=True)


def cmd_status(args: argparse.Namespace) -> int:
    site, cookies = load_session(args.site)
    with client(site, cookies) as c:
        r = c.get(f"/api/upload/{args.id}")
    print(json.dumps(r.json(), ensure_ascii=False, indent=2))
    return 0 if r.status_code == 200 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="своя запись — на сайт: транскрибация у себя, сборка на сервере")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("login", help="войти на сайт и запомнить сессию")
    p.add_argument("--site", help="адрес сайта, https://…")
    p.add_argument("--login")
    p.set_defaults(fn=cmd_login)
    p = sub.add_parser("run", help="транскрибировать, снять экран, загрузить")
    p.add_argument("video")
    p.add_argument("--title", required=True)
    p.add_argument("--date", required=True, help="YYYY-MM-DD — дата выступления")
    p.add_argument("--event", help="рубрика — из списка сайта (upload.py options)")
    p.add_argument("--speakers", help="докладчики через запятую, «Имя Фамилия»")
    p.add_argument("--tags", help="метки через запятую")
    p.add_argument("--summary", help="аннотация: о чём запись")
    p.add_argument("--slides", help="презентация PDF")
    p.add_argument("--attach", nargs="+", metavar="ФАЙЛ",
                   help="материалы: презентации, PDF, ноутбуки… (несколько через пробел)")
    p.add_argument("--discussion", help="ссылка на обсуждение записи (тред в мессенджере)")
    p.add_argument("--site")
    p.add_argument("--no-screen", action="store_true", help="без экрана из видео (быстрее, но поиск не увидит слайды)")
    p.add_argument("--stack", action="store_true", help="поднять стек транскрибации перед работой и погасить после")
    p.add_argument("--no-wait", action="store_true", help="не ждать сборки на сервере")
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("status", help="что с загрузкой на сервере")
    p.add_argument("id")
    p.add_argument("--site")
    p.set_defaults(fn=cmd_status)
    p = sub.add_parser("app", help="окно приложения: перетащить видео и заполнить поля")
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--browser", action="store_true", help="не окно, а страница в браузере")
    p.set_defaults(fn=cmd_app)
    p = sub.add_parser("ui", help="страница в браузере вместо командной строки")
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--no-open", action="store_true", help="не открывать браузер самому")
    p.set_defaults(fn=cmd_ui)
    p = sub.add_parser("options", help="допустимые рубрики и потолки сайта")
    p.add_argument("--site")
    p.set_defaults(fn=cmd_options)
    args = ap.parse_args()
    try:
        return args.fn(args)
    except Step as error:
        say(f"⚠️ {error}")
        return 1
    except subprocess.CalledProcessError as error:
        say(f"⚠️ команда не прошла: {' '.join(map(str, error.cmd))[:200]}")
        return 1


def cmd_options(args: argparse.Namespace) -> int:
    site, cookies = load_session(args.site)
    with client(site, cookies) as c:
        r = c.get("/api/upload/options")
    print(json.dumps(r.json(), ensure_ascii=False, indent=2))
    return 0 if r.status_code == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
