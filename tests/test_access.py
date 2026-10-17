"""Личные записи: кто видит, ссылка, «показать всем» (17.10, `app/content/access.py`).

⚠️ Главное свойство проверяется с ЧУЖОЙ стороны: личная запись не утекает ни одной дверью —
список, счётчики, слова, кадры, видео, вопрос к записи, ссылка с кривым ключом. Каждая дверь —
своим утверждением: снять заслонку с одной легко, а заметить пропажу нечем.
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "tools"))

import spaces  # noqa: E402
from app.auth import local  # noqa: E402
from app.auth.service import AuthService  # noqa: E402
from app.config import AuthCfg, Corpus, LocalUserCfg, LoginLimitCfg  # noqa: E402
from app.content import access  # noqa: E402
from app.content.voices import Voices  # noqa: E402
from app.main import app  # noqa: E402

DEMO = REPO / "corpora" / "demo"
OWN = "2024-01-15-kafka-osnovy"       # станет личной записью хозяина
SHARED = "2024-02-20-postgres-indeksy"  # общая, но с автором — её можно скрыть
OWNER, STRANGER, ADMIN = "kovalev", "sokolova", "kuznetsova"


def _auth() -> AuthCfg:
    pw = local.hash_password("pw")
    return AuthCfg(enabled=True, login_limit=LoginLimitCfg(attempts=50, per_ip_attempts=500), users=[
        LocalUserCfg(login=ADMIN, name="Мария Кузнецова", password=pw, role="admin"),
        LocalUserCfg(login=OWNER, name="Пётр Ковалёв", password=pw, role="editor"),
        LocalUserCfg(login=STRANGER, name="Агата Соколова", password=pw, role="editor"),
    ])


def _meta(record: Path, **extra) -> None:
    path = record / "record.meta.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    data.update(extra)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


@pytest.fixture
def site(tmp_path):
    """Копия демо-корпуса: одна запись личная (`records-private/kovalev/`), одна общая с автором;
    видео личной — в `private-media`, общей — в «архиве»."""
    corpus_dir = tmp_path / "demo"
    shutil.copytree(DEMO, corpus_dir)
    own = corpus_dir / "records" / OWN
    private = corpus_dir / spaces.PRIVATE_DIR / OWNER / OWN
    private.parent.mkdir(parents=True)
    shutil.move(str(own), str(private))
    _meta(private, access={"owner": OWNER, "link": "salt-1"})
    _meta(corpus_dir / "records" / SHARED, access={"owner": OWNER})

    archive, hidden_media = tmp_path / "archive", tmp_path / "private-media"
    media = _header(private, "media")
    if media:
        (hidden_media / media).parent.mkdir(parents=True, exist_ok=True)
        (hidden_media / media).write_bytes(b"0123456789" * 100)
    shared_media = _header(corpus_dir / "records" / SHARED, "media")
    if shared_media:
        (archive / shared_media).parent.mkdir(parents=True, exist_ok=True)
        (archive / shared_media).write_bytes(b"x" * 10)

    with TestClient(app) as c:
        state = app.state
        saved = (state.corpora, state.default_corpus, state.auth, state.cfg.auth, state.voices,
                 state.cfg.privacy.enabled, state.cfg.upload.archive, state.cfg.upload.private_media)
        corpus = Corpus(corpus_dir)
        state.corpora = {corpus.slug: corpus}
        state.default_corpus = corpus
        state.cfg.auth = _auth()
        state.auth = AuthService(state.cfg.auth, tmp_path / "auth")
        state.voices = Voices(tmp_path / "family")
        state.cfg.privacy.enabled = True
        state.cfg.upload.archive = str(archive)
        state.cfg.upload.private_media = str(hidden_media)
        try:
            yield c, corpus, tmp_path
        finally:
            (state.corpora, state.default_corpus, state.auth, state.cfg.auth, state.voices,
             state.cfg.privacy.enabled, state.cfg.upload.archive, state.cfg.upload.private_media) = saved


def _header(record: Path, key: str) -> str:
    for line in (record / "record.md").read_text(encoding="utf-8").splitlines()[1:]:
        if line.strip() == "---":
            break
        if line.startswith(f"{key}:"):
            return line.split(":", 1)[1].strip().strip('"')
    return ""


def as_(c, who: str) -> None:
    c.cookies.clear()
    assert c.post("/api/auth/login", json={"login": who, "password": "pw"}).status_code == 200


def ids(c) -> set[str]:
    return {r["id"] for r in c.get("/api/records").json()["records"]}


# --- чужой не видит ничего -------------------------------------------------------------------


def test_a_stranger_sees_no_trace_of_a_private_record(site):
    c, corpus, _ = site
    as_(c, STRANGER)
    assert OWN not in ids(c)
    for path in (f"/api/records/{OWN}/words", f"/api/records/{OWN}/transcript.md",
                 f"/api/records/{OWN}/frames", f"/api/records/{OWN}/files",
                 f"/api/records/{OWN}/media", f"/api/records/{OWN}/access"):
        assert c.get(path).status_code == 404, path
    # Вопрос к записи — тот же 404: её текст не уйдёт ни в контекст, ни в движок.
    r = c.post("/api/ask", json={"question": "о чём запись?", "session_id": "s1",
                                 "context": {"record_id": OWN, "scope": "record"}})
    assert r.status_code == 404
    # Счётчики витрины считают только общие: число чужих личных — тоже сведение.
    total = len(list((corpus.dir / "records").glob("*/record.md")))
    assert c.get("/api/corpora").json()["corpora"][0]["records_count"] == total


def test_the_owner_sees_it_marked_mine_with_the_video_through_the_site(site):
    c, _, _ = site
    as_(c, OWNER)
    rec = next(r for r in c.get("/api/records").json()["records"] if r["id"] == OWN)
    assert rec["private"] is True and rec["mine"] is True and rec["owner"] == OWNER
    assert "indexed" not in rec, "личная в поиск не идёт — «ждёт индексации» ей не обещаем"
    if rec["media"]:
        assert rec["media_url"].startswith(f"/api/records/{OWN}/media")
    shared = next(r for r in c.get("/api/records").json()["records"] if r["id"] == SHARED)
    assert shared["mine"] is True and not shared["private"] and "media_url" not in shared
    assert c.get(f"/api/records/{OWN}/words").status_code == 200


def test_the_admin_opens_by_address_but_does_not_get_it_in_the_feed(site):
    c, _, _ = site
    as_(c, ADMIN)
    assert OWN not in ids(c)
    assert c.get(f"/api/records/{OWN}/words").status_code == 200
    assert c.get(f"/api/records/{OWN}/access").json()["owner"] == OWNER


# --- видео -----------------------------------------------------------------------------------


def test_private_video_is_served_in_ranges_only_to_those_who_see_the_record(site):
    c, corpus, _ = site
    if not corpus.index.by_id(OWN).media:
        pytest.skip("у демо-записи нет видео в шапке")
    as_(c, OWNER)
    whole = c.get(f"/api/records/{OWN}/media")
    assert whole.status_code == 200 and len(whole.content) == 1000
    part = c.get(f"/api/records/{OWN}/media", headers={"Range": "bytes=10-19"})
    assert part.status_code == 206 and part.content == b"0123456789"
    assert part.headers["content-range"] == "bytes 10-19/1000"
    # Общая запись этой дверью не отдаётся: её видео раздаёт архив.
    assert c.get(f"/api/records/{SHARED}/media").status_code == 404


# --- ссылка ----------------------------------------------------------------------------------


def _key(c) -> str:
    as_(c, OWNER)
    return c.get(f"/api/records/{OWN}/access").json()["key"]


def test_the_link_grants_access_for_good_and_the_owner_can_take_it_back(site):
    c, _, _ = site
    key = _key(c)
    as_(c, STRANGER)
    assert c.post(f"/api/records/{OWN}/access/accept", json={"k": "x" * 32}).status_code == 404
    assert OWN not in ids(c)
    assert c.post(f"/api/records/{OWN}/access/accept", json={"k": key}).json()["added"] is True
    assert OWN in ids(c), "открывший по ссылке видит запись в своём списке"
    assert c.get(f"/api/records/{OWN}/words").status_code == 200
    assert c.get(f"/api/records/{OWN}/access").status_code == 403, "управляет только хозяин"

    as_(c, OWNER)
    granted = c.get(f"/api/records/{OWN}/access").json()["granted"]
    assert [g["login"] for g in granted] == [STRANGER]
    c.delete(f"/api/records/{OWN}/access/granted/{STRANGER}")
    as_(c, STRANGER)
    assert OWN not in ids(c)


def test_a_new_link_kills_the_old_one(site):
    c, _, _ = site
    old = _key(c)
    new = c.post(f"/api/records/{OWN}/access/link/reset").json()["key"]
    assert new and new != old
    as_(c, STRANGER)
    assert c.post(f"/api/records/{OWN}/access/accept", json={"k": old}).status_code == 404
    assert c.post(f"/api/records/{OWN}/access/accept", json={"k": new}).status_code == 200


# --- показать всем и обратно ------------------------------------------------------------------


def test_publishing_moves_the_record_and_its_video_without_touching_the_header(site):
    c, corpus, tmp = site
    as_(c, OWNER)
    header_before = (Path(corpus.index.by_id(OWN).file)).read_text(encoding="utf-8")
    media = corpus.index.by_id(OWN).media
    assert c.post(f"/api/records/{OWN}/access", json={"visibility": "public"}).json()["visibility"] == "public"
    rec = corpus.index.by_id(OWN)
    assert not rec.private and Path(rec.file).parent == corpus.dir / "records" / OWN
    assert Path(rec.file).read_text(encoding="utf-8") == header_before, "шапка не меняется"
    if media:
        assert (tmp / "archive" / media).is_file() and not (tmp / "private-media" / media).exists()
    assert not (corpus.dir / spaces.PRIVATE_DIR / OWNER).exists(), "пустой каталог логина убран"
    as_(c, STRANGER)
    assert OWN in ids(c)

    as_(c, OWNER)
    assert c.post(f"/api/records/{OWN}/access", json={"visibility": "private"}).json()["key"]
    as_(c, STRANGER)
    assert OWN not in ids(c)


def test_only_the_owner_or_admin_switches_and_an_ownerless_record_cannot_be_hidden(site):
    c, corpus, _ = site
    as_(c, STRANGER)
    assert c.post(f"/api/records/{SHARED}/access", json={"visibility": "private"}).status_code == 403
    as_(c, ADMIN)
    nobody = next(r.id for r in corpus.index.all() if not r.owner)
    assert c.post(f"/api/records/{nobody}/access", json={"visibility": "private"}).status_code == 409


def test_privacy_switched_off_still_hides_but_nothing_new_can_be_shared(site):
    """Флаг выключает то, что СОЗДАЁТ и РАЗДАЁТ личное, — но не прячет уже лежащее в личном
    корне от чужих: безопасная сторона."""
    c, _, _ = site
    app.state.cfg.privacy.enabled = False
    as_(c, STRANGER)
    assert OWN not in ids(c)
    as_(c, OWNER)
    assert c.get(f"/api/records/{OWN}/access").status_code == 404


# --- модель и раскладка без сайта ------------------------------------------------------------


def test_policy_table():
    pol = access.policy_for("owner_link")

    class R:
        private, owner, granted = True, OWNER, (STRANGER,)

    owner, guest = access.Viewer(login=OWNER), access.Viewer(login=STRANGER)
    other, admin = access.Viewer(login="ivanova"), access.Viewer(login=ADMIN, role="admin")
    assert pol.can_see(R, owner) and pol.listed(R, owner) and pol.can_manage(R, owner)
    assert pol.can_see(R, guest) and pol.listed(R, guest) and not pol.can_manage(R, guest)
    assert not pol.can_see(R, other) and not pol.listed(R, other)
    assert pol.can_see(R, admin) and not pol.listed(R, admin) and pol.can_manage(R, admin)
    assert not pol.can_see(R, None)
    with pytest.raises(ValueError):
        access.policy_for("everyone")


def test_link_token_depends_on_record_and_salt():
    secret = b"k" * 32
    token = access.link_token(secret, "a", "s1")
    assert access.check_link(secret, "a", "s1", token)
    assert not access.check_link(secret, "b", "s1", token)
    assert not access.check_link(secret, "a", "s2", token)
    assert access.link_token(secret, "a", "") == "" and not access.check_link(secret, "a", "", "")


def test_private_layout_mirrors_the_public_one(tmp_path):
    space = tmp_path / "space"
    rec = space / "records" / "Встречи" / "2024" / "rec-1"
    rec.mkdir(parents=True)
    hidden = spaces.private_target(rec, "Kovalev")
    assert hidden == space / spaces.PRIVATE_DIR / "kovalev" / "Встречи" / "2024" / "rec-1"
    hidden.mkdir(parents=True)
    assert spaces.public_target(hidden) == rec.resolve()
    for bad in ("../x", "a/b", ".hidden", ""):
        with pytest.raises(ValueError):
            spaces.safe_owner(bad)

    import make_record  # noqa: PLC0415
    assert make_record.branch_for(hidden) == "Встречи"


def test_site_and_tools_agree_on_the_private_root():
    """Сайт не импортирует инструменты, поэтому имя личного корня у него своё — и обязано совпасть:
    разъедутся — сборка положит запись туда, где сайт её не ищет (или ищет как общую)."""
    from app import config  # noqa: PLC0415
    assert config.PRIVATE_DIR == spaces.PRIVATE_DIR


def test_voices_snapshot_hides_traces_of_hidden_records():
    voice = {"id": "Speaker_1", "records": ["a", "b"], "intros": [{"record": "b", "raw": "меня зовут"}],
             "candidates": [{"name": "Икс", "from": "b"}]}
    out = Voices._hide(voice, {"b"})
    assert out["records"] == ["a"] and out["intros"] == [] and out["candidates"] == []


# --- приём загрузки ----------------------------------------------------------------------------


@pytest.fixture
def intake(tmp_path, monkeypatch):
    """Приём на копии демо-корпуса с ВХОДОМ: личной записи нужен хозяин из сессии."""
    from test_upload import upload_all, wait  # noqa: PLC0415
    demo = tmp_path / "demo"
    shutil.copytree(DEMO, demo)
    marker = tmp_path / "indexed"
    monkeypatch.setenv("MORAG_WEB_CORPUS", str(demo))
    with TestClient(app) as c:
        state = app.state
        up = state.cfg.upload
        saved = (up.enabled, up.archive, up.private_media, up.after, up.index, up.min_free_gb,
                 state.cfg.privacy.enabled, state.auth, state.cfg.auth)
        up.enabled, up.archive, up.private_media, up.after = True, str(tmp_path / "archive"), \
            str(tmp_path / "private-media"), []
        up.index = [sys.executable, "-c", f"open({str(marker)!r}, 'w').write('1')"]
        up.min_free_gb = 0
        state.cfg.privacy.enabled = True
        state.cfg.auth = _auth()
        state.auth = AuthService(state.cfg.auth, tmp_path / "auth")
        try:
            yield c, demo, tmp_path, marker, upload_all, wait
        finally:
            (up.enabled, up.archive, up.private_media, up.after, up.index, up.min_free_gb,
             state.cfg.privacy.enabled, state.auth, state.cfg.auth) = saved


def _send(c, upload_all, wait, **over) -> str:
    body = {"title": "Kafka без боли", "date": "2026-03-12", "video": "talk.mp4", **over}
    r = c.post("/api/upload", json=body)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    upload_all(c, rid)
    assert c.post(f"/api/upload/{rid}/finish").status_code == 200
    assert wait(c, rid)["state"] == "done"
    return rid


def test_an_upload_without_a_choice_lands_private_and_skips_the_index(intake):
    c, demo, tmp, marker, upload_all, wait = intake
    as_(c, OWNER)
    rid = _send(c, upload_all, wait)
    record = demo / spaces.PRIVATE_DIR / OWNER / rid
    assert (record / "record.md").is_file() and not (demo / "records" / rid).exists()
    assert (tmp / "private-media" / "Uploads" / f"{rid}.mp4").is_file()
    assert not (tmp / "archive" / "Uploads" / f"{rid}.mp4").exists(), "в открытый архив — нельзя"
    meta = json.loads((record / "record.meta.json").read_text(encoding="utf-8"))
    assert meta["access"]["owner"] == OWNER and meta["access"]["link"]
    assert not marker.exists(), "личная в индекс не идёт"
    assert rid in ids(c)
    as_(c, STRANGER)
    assert rid not in ids(c)


def test_an_upload_shown_to_everyone_lands_public_with_its_author(intake):
    c, demo, tmp, marker, upload_all, wait = intake
    as_(c, OWNER)
    rid = _send(c, upload_all, wait, visibility="public")
    record = demo / "records" / rid
    assert (record / "record.md").is_file()
    assert (tmp / "archive" / "Uploads" / f"{rid}.mp4").is_file()
    assert json.loads((record / "record.meta.json").read_text(encoding="utf-8"))["access"] == {"owner": OWNER}
    assert marker.exists()
    as_(c, STRANGER)
    assert rid in ids(c)
