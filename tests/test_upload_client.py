"""Клиент загрузки (`tools/upload.py`) против фейкового адаптера и фейкового сайта.

Что закреплено: протокол адаптера (multipart + поллинг), пакет и порядок загрузки (видео —
последним), возобновление (повторный запуск не гонит транскрибацию заново и не льёт уже
отданные файлы), сессия сайта на диске с правами 0600, отказ без трейсбека.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))
sys.path.insert(0, str(REPO / "tests"))

import upload  # noqa: E402
from test_turn_edits import whole_artifact  # noqa: E402


class Fake:
    """Адаптер (:8082) и сайт в одном транспорте — по базовому адресу запроса."""

    def __init__(self) -> None:
        self.uploads: list[tuple[str, int]] = []
        self.manifests: list[dict] = []
        self.finishes = 0
        self.transcriptions = 0
        self.polls = 0
        self.status_calls = 0

    def handle(self, request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if request.url.port == 8082:
            if p == "/health":
                return httpx.Response(200, json={"status": "ok"})
            if p == "/v1/audio/transcriptions":
                self.transcriptions += 1
                body = request.read()
                assert b'name="mode"' in body and b"async" in body and b'name="hints"' in body
                return httpx.Response(200, json={"job_id": "j1"})
            if p == "/v1/jobs/j1":
                self.polls += 1
                if self.polls < 2:
                    return httpx.Response(200, json={"status": "running", "progress": "whisper"})
                return httpx.Response(200, json={"status": "done", "result": whole_artifact()})
        if p == "/api/auth/state":
            return httpx.Response(200, json={"enabled": True})
        if p == "/api/auth/login":
            return httpx.Response(200, json={"name": "Мария", "role": "editor"}, headers={"set-cookie": "morag_session=abc; Path=/"})
        if p == "/api/upload" and request.method == "POST":
            self.manifests.append(json.loads(request.read()))
            assert request.headers.get("cookie", "").startswith("morag_session=")
            return httpx.Response(200, json={"id": "2026-03-12-kafka-bez-boli", "video": "video.mp4"})
        if p.startswith("/api/upload/2026-03-12-kafka-bez-boli/files/") and request.method == "PUT":
            self.uploads.append((p.rsplit("/", 1)[-1], len(request.read())))
            return httpx.Response(200, json={"bytes": self.uploads[-1][1]})
        if p.endswith("/finish"):
            self.finishes += 1
            return httpx.Response(200, json={"state": "queued"})
        if p == "/api/upload/2026-03-12-kafka-bez-boli":
            self.status_calls += 1
            state = "building" if self.status_calls < 2 else "done"
            return httpx.Response(200, json={"state": state, "url": "/demo/rec/2026-03-12-kafka-bez-boli"})
        return httpx.Response(404, json={"detail": p})


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = Fake()
    monkeypatch.setattr(upload, "TRANSPORT", httpx.MockTransport(fake.handle))
    # ⚠️⚠️ Файл стека ТОЖЕ в песочницу: тест пишет в него ключи, и без этой строки он
    # правил бы НАСТОЯЩИЙ `~/.asr-stack.env` разработчика — и приложение потом читало бы
    # тестовый ключ и получало 401 (ловилось 25.09).
    monkeypatch.setenv("ASR_STACK_ENV", str(tmp_path / "stack.env"))
    monkeypatch.setattr(upload, "HOME", tmp_path / "work")
    monkeypatch.setattr(upload, "SESSION", tmp_path / "session.json")
    monkeypatch.setattr(upload, "POLL_SEC", 0)
    monkeypatch.setattr(upload.time, "sleep", lambda *_: None)
    monkeypatch.setattr(upload, "ffmpeg_audio", lambda video, out: out.write_bytes(b"mp3" * 100))
    video = tmp_path / "talk.mp4"
    video.write_bytes(b"\x00" * 3000)
    return fake, video, tmp_path


def run(video: Path, *extra: str) -> int:
    sys.argv = ["upload.py", "run", str(video), "--title", "Kafka без боли", "--date", "2026-03-12",
                "--speakers", "Мария Кузнецова", "--no-screen", *extra]
    return upload.main()


def test_login_stores_the_session_with_owner_only_rights(env, monkeypatch):
    fake, video, tmp = env
    monkeypatch.setattr("builtins.input", lambda *_: "kuznetsova")
    monkeypatch.setattr(upload.getpass, "getpass", lambda *_: "pw")
    sys.argv = ["upload.py", "login", "--site", "https://site.example.org/"]
    assert upload.main() == 0
    data = json.loads(upload.SESSION.read_text())
    assert data["site"] == "https://site.example.org" and data["cookies"]["morag_session"] == "abc"
    assert oct(upload.SESSION.stat().st_mode & 0o777) == "0o600"


def test_run_transcribes_uploads_in_order_and_waits(env, monkeypatch):
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    assert run(video) == 0
    assert fake.transcriptions == 1 and fake.polls >= 2
    work = upload.HOME / "2026-03-12-kafka-bez-boli"
    assert (work / "artifact.json").is_file() and (work / "transcript.md").is_file()
    assert not (work / "audio.mp3").exists(), "пакет принят — звук больше не нужен, удалён в конце"
    assert fake.manifests[0]["speakers"] == ["Мария Кузнецова"] and fake.manifests[0]["video"] == "video.mp4"
    assert [n for n, _ in fake.uploads] == ["artifact.json", "video.mp4"], "видео — последним"
    assert dict(fake.uploads)["video.mp4"] == 3000
    assert fake.finishes == 1 and fake.status_calls >= 2


def test_the_screen_runs_ahead_of_the_transcript_and_never_breaks_it(env, monkeypatch):
    """⚠️⚠️ Первые минуты (звук из видео + диаризация) в окне были ПУСТЫМИ: расшифровки ещё нет,
    показывать нечего (владелец, 25.09: «может быть там можно параллельную работу какую-то
    сделать, которую можно отобразить?»). Разбор экрана уехал вперёд — кадрам и описаниям речь
    не нужна, нужна только она двум последним шагам.

    Здесь закреплены три вещи: ранняя тройка стартует ДО обращения к адаптеру, поздний полный
    прогон доделывает остальное, и падение ранней тройки НЕ роняет запись.
    """
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    order: list[str] = []
    early = threading.Event()

    def fake_screen(work, vid, record, *, only_video=False):
        order.append("рано" if only_video else "полностью")
        record.mkdir(parents=True, exist_ok=True)
        if only_video:
            early.set()
            raise upload.Step("кадр не разобрался")     # худший случай: ранняя тройка упала

    real_transcribe = upload.transcribe

    def fake_transcribe(work, vid, rid, title, speakers, on_spans=None):
        # ⚠️ Проверяем ПАРАЛЛЕЛЬНОСТЬ, а не порядок строк: важно, что экран уже работает, пока
        # расшифровка идёт. Сравнение «кто первым дописал в список» зависело бы от планировщика.
        assert early.wait(5), "разбор экрана не начался, пока шла расшифровка"
        order.append("расшифровка")
        return real_transcribe(work, vid, rid, title, speakers, on_spans=on_spans)

    monkeypatch.setattr(upload, "screen", fake_screen)
    monkeypatch.setattr(upload, "transcribe", fake_transcribe)
    sys.argv = ["upload.py", "run", str(video), "--title", "Kafka без боли", "--date", "2026-03-12"]
    assert upload.main() == 0, "падение ранней тройки не роняет запись — расшифровка главнее"
    assert order == ["рано", "расшифровка", "полностью"], order
    assert fake.finishes == 1, "запись всё равно уехала на сайт"
    upload.EVENTS.clear()


def test_the_upload_reports_itself_to_the_window_not_only_to_the_console(env):
    """⚠️ Загрузка видео — гигабайты по сети, и она дольше всей остальной отправки. В окне про
    неё не было НИЧЕГО: проценты печатались строками в свёрнутый лог (владелец, 25.09: «при
    подтверждении загрузки видео на сайт тут уже надо показывать в браузере»).

    Здесь закреплён КАНАЛ: шаг назван, список файлов известен ДО первого байта, у каждого файла
    свои байты и общий вес пакета, а состояния сервера доезжают до окна словами.
    """
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    upload.EVENTS.clear()
    assert run(video) == 0
    kinds = [e["t"] for e in upload.EVENTS]
    assert "upload.begin" in kinds and "upload.file" in kinds

    step = [e for e in upload.EVENTS if e["t"] == "client.step" and e["step"] == "send"]
    assert step, "шаг отправки назван — иначе подпись работы врёт про прежнюю стадию"

    begin = next(e for e in upload.EVENTS if e["t"] == "upload.begin")
    assert [f["name"] for f in begin["files"]] == ["artifact.json", "video.mp4"]
    assert begin["bytes"] == sum(f["bytes"] for f in begin["files"]) > 0

    moves = [e for e in upload.EVENTS if e["t"] == "upload.file" and e["name"] == "video.mp4"]
    assert moves and moves[-1]["done"] and moves[-1]["sent"] == 3000
    assert moves[-1]["moved"] == begin["bytes"] == moves[-1]["whole"], "общий счёт — по байтам"

    states = [e["state"] for e in upload.EVENTS if e["t"] == "upload.state"]
    assert states[0] == "accepted" and states[-1] == "done", states
    upload.EVENTS.clear()


def test_second_run_resumes_without_redoing(env):
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    assert run(video) == 0
    assert run(video) == 0
    assert fake.transcriptions == 1, "артефакт уже есть — адаптер не трогаем"
    assert len(fake.uploads) == 2, "отданные файлы второй раз не льём"
    assert len(fake.manifests) == 1, "манифест не заводится заново — id уже известен"
    assert fake.finishes == 2, "finish повторяем: он идемпотентен"


def test_refusals_are_messages_not_tracebacks(env, capsys):
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    sys.argv = ["upload.py", "run", str(tmp / "нет.mp4"), "--title", "x", "--date", "2026-03-12"]
    assert upload.main() == 1 and "нет файла" in capsys.readouterr().out
    sys.argv = ["upload.py", "run", str(video), "--title", "Норм", "--date", "12.03.2026"]
    assert upload.main() == 1 and "ГГГГ-ММ-ДД" in capsys.readouterr().out
    upload.SESSION.unlink()
    sys.argv = ["upload.py", "run", str(video), "--title", "Норм", "--date", "2026-03-12", "--no-screen"]
    assert upload.main() == 1 and "login" in capsys.readouterr().out


# --- стек: уборка не врёт, а ошибка называет причину ------------------------------------

def test_shutting_the_stack_down_never_masks_the_real_error(tmp_path, monkeypatch):
    """⚠️ Живой случай 24.09: расшифровка упала, а человек увидел «CalledProcessError: stack.sh
    down». Гасим мы в `finally`, и исключение из УБОРКИ заменяет настоящую ошибку; сам `down`
    вдобавок возвращает 1, когда последний порт уже свободен (баг в `stack.sh` движка)."""
    script = tmp_path / "morag" / "services" / "asr-adaptor" / "deploy" / "mac" / "stack.sh"
    script.parent.mkdir(parents=True)
    script.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    script.chmod(0o755)
    monkeypatch.setattr(upload, "MORAG_REPO", tmp_path / "morag")

    with pytest.raises(Exception):
        upload.stack("up")                      # обычный вызов по-прежнему кричит
    upload.stack("down", check=False)           # а уборка молчит и не роняет


def test_a_dead_stack_says_why_and_not_just_that(tmp_path, monkeypatch):
    """«Стек не отвечает» человеку ничего не говорит. Настоящая причина лежит в логах бэкендов —
    в живом случае это было «Missing credentials» у адаптера (пустой ключ шлюза)."""
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "adaptor.log").write_text(
        "INFO: старт\nTraceback (most recent call last):\n"
        "openai.OpenAIError: Missing credentials. Please pass an `api_key`\n", encoding="utf-8")
    (logs / "whisper.log").write_text("INFO:     Application startup complete.\n", encoding="utf-8")
    monkeypatch.setenv("ASR_STACK_HOME", str(tmp_path))
    why = upload.stack_trouble()
    assert "adaptor" in why and "Missing credentials" in why
    assert "whisper" not in why, "у здорового бэкенда жаловаться не на что"


def test_gateway_is_configured_before_work_not_only_at_login(tmp_path, monkeypatch):
    """⚠️ Вход мог случиться ДО обновления приложения — тогда шлюз остался ненастроенным, а
    адаптер без ключа не стартует вовсе (строит клиента на импорте). Проверяем у самой работы."""
    env_file = tmp_path / "asr.env"
    env_file.write_text("OR_KEY=\n", encoding="utf-8")
    monkeypatch.setenv("ASR_STACK_ENV", str(env_file))
    monkeypatch.delenv("OR_KEY", raising=False)
    called: list[str] = []

    def fake_use_site_llm():
        called.append("да")
        upload.set_stack_env(OR_KEY="сессия-сайта")
        return {"via_site": True, "checked": True}

    monkeypatch.setattr(upload, "use_site_llm", fake_use_site_llm)
    upload.ensure_gateway()
    assert called == ["да"] and upload.stack_env_value("OR_KEY") == "сессия-сайта"

    called.clear()
    upload.ensure_gateway()
    assert called == [], "уже настроено — второй раз к сайту не ходим"

    monkeypatch.setattr(upload, "use_site_llm", lambda: {"via_site": False})
    monkeypatch.setenv("ASR_STACK_ENV", str(tmp_path / "пусто.env"))
    monkeypatch.delenv("OR_KEY", raising=False)
    with pytest.raises(upload.Step, match="шлюз"):
        upload.ensure_gateway()


def test_the_audio_outlives_transcription_so_voiceprints_can_be_taken(env, monkeypatch):
    """⚠️⚠️ Регрессия, из-за которой узнавание голосов не работало НИ РАЗУ.

    `transcribe()` удалял `audio.mp3` последним действием, а отпечатки считаются СЛЕДУЮЩИМ шагом
    из того же файла — и без него шаг молча возвращал `None`. Пакет уезжал без `voices.json`,
    сервер честно откатывался на «незнакомцы под номерами», и снаружи всё выглядело исправным.
    Прежний тест это пропускал: он проверял, что звука нет, — то есть закреплял сам дефект.

    Держим ИНВАРИАНТ, а не файл: в момент, когда считаются отпечатки, звук обязан быть на диске.
    """
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    # Шаг требует ключа к CAM++ и без него честно не начинается — значит, в тесте он нужен тоже.
    upload.set_stack_env(ASR_CAMPP_KEY="k")

    sys.path.insert(0, str(REPO / "tools"))
    import voiceprints

    seen: dict = {}

    def fake_prints(artifact, audio, **kw):
        seen["audio"] = Path(audio)
        seen["existed"] = Path(audio).is_file() and Path(audio).stat().st_size > 0
        return {"Speaker_0": {"centroid": [0.0] * 192, "air_sec": 700.0, "cluster": "SPEAKER_00"}}

    monkeypatch.setattr(voiceprints, "fingerprints", fake_prints)
    assert run(video) == 0

    assert seen.get("existed"), "звук должен быть на диске, когда считаются отпечатки"
    work = upload.HOME / "2026-03-12-kafka-bez-boli"
    assert (work / "voices.json").is_file()
    assert "voices.json" in [n for n, _ in fake.uploads], "отпечатки обязаны уехать в пакете"


def test_auto_fields_picks_only_from_what_the_site_allows(tmp_path, monkeypatch):
    """⚠️ Поля, которые человек не заполнил, подставляются САМИ — но строго из существующего.

    Сочинённая рубрика отправила бы запись не в ту ветку (рубрика решает ветку и год), а
    сочинённая метка размыла бы фильтр: словарь меток и так наполовину одноразовый.
    """
    artifact = tmp_path / "artifact.json"
    artifact.write_text(json.dumps({"x_enriched": {
        "doc_summary": "Доклад про очереди сообщений и дежурства.",
        "glossary": [{"term": "Kafka"}, {"term": "Grafana"}]}}), encoding="utf-8")

    asked: list[str] = []

    def fake_options(site, cookies):
        return {"events": ["Доклады", "Встречи"], "tags": ["kafka", "дежурства", "ml"],
                "llm": {"model": "Instruct"}}

    def fake_llm(site, cookies, prompt, **kw):
        asked.append(prompt)
        # первый вопрос — рубрика, второй — метки; на метки отвечаем с выдуманной в середине
        return "Встречи" if "рубрику" in prompt else "kafka, тимлидство, дежурства"

    monkeypatch.setattr(upload, "options", fake_options)
    monkeypatch.setattr(upload, "ask_llm", fake_llm)
    event, tags, _ = upload.auto_fields(artifact, "https://site", {}, title="Очереди", event="", tags=[])
    assert event == "Встречи", "рубрика выбрана из списка сайта"
    assert tags == ["kafka", "дежурства"], "выдуманная метка отброшена, остались существующие"
    assert len(asked) == 2, "рубрика и метки — два отдельных вопроса"


def test_auto_fields_keeps_what_the_person_wrote_and_survives_silence(tmp_path, monkeypatch):
    artifact = tmp_path / "artifact.json"
    artifact.write_text(json.dumps({"x_enriched": {"doc_summary": "о чём-то"}}), encoding="utf-8")
    monkeypatch.setattr(upload, "options", lambda *a: {"events": ["Доклады"], "tags": ["kafka"]})
    monkeypatch.setattr(upload, "ask_llm", lambda *a, **k: "")     # шлюз молчит
    event, tags, _ = upload.auto_fields(artifact, "https://site", {}, title="T", event="", tags=[])
    assert event == "" and tags == [], "молчание шлюза не выдумывает поля и не роняет прогон"
    same = upload.auto_fields(artifact, "https://site", {}, title="T", event="Своя", tags=["своя"])
    assert same == ("Своя", ["своя"], []), "выбранное человеком не трогаем"


def test_speakers_come_from_who_actually_spoke(tmp_path, monkeypatch):
    """⚠️ Докладчики — те, кто ГОВОРИЛ, а не все названные: ведущий открывает встречу
    двумя фразами и в списке докладчиков ему не место. Безымянный голос не попадает вовсе:
    «Speaker_7» в поле «докладчики» хуже, чем пусто.
    """
    artifact = tmp_path / "artifact.json"
    artifact.write_text(json.dumps({"x_enriched": {"doc_summary": "о чём-то"}}), encoding="utf-8")
    monkeypatch.setattr(upload, "options", lambda *a: {})
    voices = {
        "SPEAKER_00": {"voice": "Speaker_7", "name": "Мария Кузнецова", "air": 1800.0},
        "SPEAKER_01": {"voice": "Speaker_9", "name": "Нина Ковалёва", "air": 900.0},
        "SPEAKER_02": {"voice": "Speaker_3", "name": "Клара Зотова", "air": 120.0},
        "SPEAKER_03": {"voice": "Speaker_5", "name": "", "air": 800.0},
    }
    _, _, speakers = upload.auto_fields(artifact, "https://site", {}, title="T", event="Есть",
                                        tags=["есть"], speakers=[], voices=voices)
    assert speakers == ["Мария Кузнецова", "Нина Ковалёва"], speakers


def test_emit_survives_a_field_named_like_its_own_argument():
    """⚠️⚠️ У кадра экрана поле зовётся `kind` — как и первый аргумент `emit`. Живьём это
    уронило прогон на первом же описанном кадре (25.09): «got multiple values for argument».
    Третий случай одного и того же класса после `event` и `i` — поэтому закреплено тестом.
    """
    upload.EVENTS.clear()
    upload.emit("screen.frame", kind="slide", title="Очереди", i=3)
    evt = upload.EVENTS[-1]
    assert evt["t"] == "screen.frame" and evt["kind"] == "slide" and evt["i"] == 3
    upload.EVENTS.clear()


def test_a_frames_second_does_not_overwrite_the_runtime(env, tmp_path):
    """⚠️⚠️ У кадра экрана есть СВОЯ секунда — место в записи, — и `describe_slides` присылает её
    полем `at`. В конверте `at` занято временем прогона, и поле его молча затирало: стенд играет
    трассу по `at` и на первом же кадре прыгал в начало. Секунда кадра зовётся `sec`.
    """
    script = tmp_path / "fake_screen.py"
    script.write_text('print(\'@progress \' + \'{"frame": "slides/s001.jpg", "at": 61.0, '
                      '"kind": "slide", "done": 1, "n": 2}\')\n', encoding="utf-8")
    upload.EVENTS.clear()
    upload.run_step([sys.executable, str(script)], dict(os.environ), tmp_path / "rec")
    evt = next(e for e in upload.EVENTS if e["t"] == "screen.frame")
    assert evt["sec"] == 61.0, "секунда кадра приехала под своим именем"
    assert evt["at"] != 61.0, "время прогона осталось временем прогона"
    assert evt["path"].endswith("rec/slides/s001.jpg") and evt["kind"] == "slide"
    upload.EVENTS.clear()


def test_the_package_waits_when_the_person_unchecks_sending(env, monkeypatch):
    """⚠️ Галочка «загрузить после расшифровки» спрашивается ПЕРЕД ОТПРАВКОЙ, а не на старте:
    её снимают по ходу, увидев расшифровку (решение владельца 25.09). Пакет при этом собран
    и лежит в рабочей папке — отправить позже стоит одного повторного прогона, без пересчёта.
    """
    fake, video, tmp = env
    upload.save_session("https://site.example.org", {"morag_session": "abc"})
    rid = upload.pipeline(video, title="Норм", date="2026-03-12", event="Доклады",
                          with_screen=False, wait=False, should_upload=lambda: False)
    assert rid == "" and not fake.manifests, "манифест на сайт не уехал"
    assert (upload.HOME / "2026-03-12-norm" / "artifact.json").is_file(), "а расшифровка на месте"
    # Передумали — тот же прогон довозит пакет, ничего не считая заново.
    was = fake.transcriptions
    upload.pipeline(video, title="Норм", date="2026-03-12", event="Доклады",
                    with_screen=False, wait=False, should_upload=lambda: True)
    assert fake.manifests, "со второго раза уехал"
    assert fake.transcriptions == was, "и расшифровка заново не гонялась"


def test_the_date_comes_from_the_video_not_from_the_file(monkeypatch, tmp_path):
    """⚠️ Файл, скачанный из архива, «создан» сегодня — и дата выступления оказывалась датой
    загрузки. Teams, Zoom и камеры кладут время съёмки в контейнер — спрашиваем его."""
    import subprocess as sp

    class Done:
        def __init__(self, out): self.stdout = out

    monkeypatch.setattr(upload.subprocess, "run", lambda *a, **k: Done("2025-11-14T09:02:13.000000Z\n"))
    assert upload.shot_at(tmp_path / "talk.mp4") == "2025-11-14"
    monkeypatch.setattr(upload.subprocess, "run", lambda *a, **k: Done("\n"))
    assert upload.shot_at(tmp_path / "talk.mp4") == "", "нет метки — не выдумываем"

    def boom(*a, **k):
        raise OSError("нет ffprobe")

    monkeypatch.setattr(upload.subprocess, "run", boom)
    assert upload.shot_at(tmp_path / "talk.mp4") == "", "и не падаем без ffprobe"
    _ = sp


def test_names_come_from_the_dictionary_not_from_the_stale_snapshot(tmp_path, monkeypatch):
    """⚠️⚠️ Имена берём ПОИМЁННО (`/api/voices/{voice}`), а не из снимка `/api/voices`.

    Снимок собирают руками (`tools/voices.py --scan`), и на сервере он месячной давности: голоса,
    названные позже, в нём просто отсутствуют — и окно три прогона подряд светило `SPEAKER_X`,
    хотя узнавание работало. Карточка одного голоса читает имя прямо из словаря.
    """
    asked: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        asked.append(request.url.path)
        if request.url.path == "/api/voices/identify":
            body = json.loads(request.read())
            assert body["dry"] is True, "узнавание не имеет права занимать номера"
            return httpx.Response(200, json={"map": {"SPEAKER_00": "Speaker_7"}, "report": []})
        if request.url.path == "/api/voices":       # снимок старый: нашего голоса в нём нет
            return httpx.Response(200, json={"ready": True, "voices": []})
        if request.url.path == "/api/voices/Speaker_7":
            return httpx.Response(200, json={"id": "Speaker_7", "name": "Мария Кузнецова"})
        return httpx.Response(404, json={})

    monkeypatch.setattr(upload, "TRANSPORT", httpx.MockTransport(handle))
    work = tmp_path / "rec"
    work.mkdir()
    (work / "voices.json").write_text(json.dumps(
        {"SPEAKER_00": {"centroid": [0.0] * 192, "air_sec": 900.0, "cluster": "SPEAKER_00"}}),
        encoding="utf-8")
    upload.EVENTS.clear()
    out = upload.identify_voices(work, "https://site.example.org", {"s": "1"}, "rec")
    assert out["SPEAKER_00"]["name"] == "Мария Кузнецова", out
    assert out["SPEAKER_00"]["voice"] == "Speaker_7"
    assert "/api/voices/Speaker_7" in asked, "имя спрошено поимённо"
    named = [e for e in upload.EVENTS if e["t"] == "voices.named"]
    assert named and named[-1]["by_label"]["SPEAKER_00"]["name"] == "Мария Кузнецова", \
        "имя уехало в окно событием"
    upload.EVENTS.clear()


def test_voices_are_asked_right_after_diarization_not_after_the_whole_run(tmp_path, monkeypatch):
    """⚠️ Спаны готовы на третьей минуте, артефакт — на одиннадцатой. Ждать артефакт ради
    тех же границ значит всю работу светить человеку `SPEAKER_00`."""
    seen = {}

    monkeypatch.setattr(upload, "stack_env_value", lambda name: "k" if "CAMPP" in name else "")
    import voiceprints
    monkeypatch.setattr(voiceprints, "from_spans",
                        lambda voices, audio, **kw: (seen.update(voices) or
                                                     {"SPEAKER_00": {"centroid": [0.0] * 192,
                                                                     "air_sec": 30.0}}))
    monkeypatch.setattr(upload, "identify_voices",
                        lambda work, site, cookies, episode: {"SPEAKER_00": {"voice": "Speaker_7",
                                                                            "name": "Нина Ковалёва",
                                                                            "air": 30.0}})
    work = tmp_path / "rec"
    work.mkdir()
    (work / "audio.mp3").write_bytes(b"mp3")
    out: dict = {}
    upload.early_voices(work, {"speakers": ["SPEAKER_00", "SPEAKER_01"],
                               "spans": [[0.0, 20.0, 0], [20.0, 30.0, 0], [30.0, 40.0, 1]]},
                        "https://site", {}, "rec", out)
    assert set(seen) == {"SPEAKER_00", "SPEAKER_01"}, "спаны разобраны по меткам"
    assert seen["SPEAKER_00"]["air_sec"] == 30.0, "эфир сложен по отрезкам"
    assert out["SPEAKER_00"]["name"] == "Нина Ковалёва", "имя узнано до конца расшифровки"
    assert (work / "voices.json").is_file(), "отпечатки легли рядом — второй раз их не считают"
