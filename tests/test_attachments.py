"""Материалы записи и ссылка на обсуждение.

⚠️⚠️ Главное, что здесь закреплено: отдаётся только то, что ЕСТЬ В СПИСКЕ меты, и только внутри
каталога записи. Файл в каталоге записи — ещё не материал: рядом лежат сырые сайдкары, которые
наружу не отдаются никогда. И «убрать» — пометка, а не удаление: доставка между машинами умеет
только добавлять, удалённый файл вернулся бы.
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

from app.content import attachments  # noqa: E402
from app.content import fields as record_fields  # noqa: E402
from app.main import app  # noqa: E402
from test_turn_edits import build, make_corpus, run  # noqa: E402


def tmp_file(tmp_path: Path, name: str = "x.part", data: bytes = b"%PDF-1.4 demo") -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


# --- модуль ---------------------------------------------------------------------------------

def test_safe_name_keeps_cyrillic_and_drops_the_path():
    assert attachments.safe_name("../../etc/Доклад про индексы.PDF") == "Доклад про индексы.pdf"
    assert attachments.safe_name("C:\\Users\\a\\deck.pptx") == "deck.pptx"
    assert attachments.safe_name(".hidden.pdf") == "hidden.pdf"


@pytest.mark.parametrize("name", ["page.html", "logo.svg", "run.sh", "без-расширения", "record.json"])
def test_safe_name_refuses_what_is_not_on_the_list(name):
    """html и svg браузер ВЫПОЛНИТ — с нашего адреса и с нашими cookie."""
    with pytest.raises(attachments.Refused):
        attachments.safe_name(name)


def test_add_lists_the_file_and_a_taken_name_gets_a_suffix(tmp_path):
    record = tmp_path / "rec"
    record.mkdir()
    one = attachments.add(record, "deck.pdf", tmp_file(tmp_path, "a"), by="Кузнецова (kuz)")
    two = attachments.add(record, "deck.pdf", tmp_file(tmp_path, "b"))
    assert one["file"] == "files/deck.pdf" and two["file"] == "files/deck-2.pdf"
    assert one["by"] == "Кузнецова (kuz)" and one["from"] == "site"
    assert [i["file"] for i in attachments.items(record)] == ["files/deck.pdf", "files/deck-2.pdf"]


def test_removed_is_hidden_but_stays_on_disk_and_its_name_is_not_reused(tmp_path):
    record = tmp_path / "rec"
    record.mkdir()
    attachments.add(record, "deck.pdf", tmp_file(tmp_path))
    assert attachments.remove(record, "files/deck.pdf", by="убрано: тест")
    assert attachments.items(record) == []
    assert attachments.find(record, "files/deck.pdf") is None
    assert (record / "files" / "deck.pdf").is_file(), "убранный файл обязан остаться на диске"
    again = attachments.add(record, "deck.pdf", tmp_file(tmp_path, "c"))
    assert again["file"] == "files/deck-2.pdf"
    assert not attachments.remove(record, "files/нет.pdf")


def test_a_file_outside_the_list_or_the_record_is_not_served(tmp_path):
    record = tmp_path / "rec"
    record.mkdir()
    (record / "record.json").write_text("{}")             # сырой сайдкар — не материал
    (tmp_path / "secret.pdf").write_text("x")
    (record / "link.pdf").symlink_to(tmp_path / "secret.pdf")
    (record / "record.meta.json").write_text(json.dumps({"attachments": [
        {"file": "record.json"}, {"file": "../secret.pdf"}, {"file": "link.pdf"}]}))
    assert attachments.items(record) == []
    for rel in ("record.json", "../secret.pdf", "link.pdf"):
        assert attachments.find(record, rel) is None


def test_old_decks_are_listed_where_they_lie(tmp_path):
    """Колоды, перенесённые с прежнего сайта, лежат в корне каталога записи — их не двигаем."""
    record = tmp_path / "rec"
    record.mkdir()
    (record / "Доклад.pptx").write_bytes(b"PK")
    (record / "record.meta.json").write_text(json.dumps(
        {"attachments": [{"file": "Доклад.pptx", "from": "post"}]}, ensure_ascii=False))
    assert attachments.items(record)[0]["ext"] == "pptx"


def test_check_link():
    assert attachments.check_link("  ") == ""
    assert attachments.check_link("https://chat.example.org/team/pl/abc", ["chat.example.org"])
    with pytest.raises(attachments.Refused):
        attachments.check_link("javascript:alert(1)")
    with pytest.raises(attachments.Refused):
        attachments.check_link("https://evil.example.com/pl/abc", ["chat.example.org"])


# --- ссылка на обсуждение через правку полей -------------------------------------------------

def test_discussion_from_the_site_beats_the_post_and_an_empty_one_stays_empty(tmp_path):
    """⚠️ Пустая строка — «снять», и ссылка из поста после пересборки НЕ возвращается."""
    root = make_corpus(tmp_path, [])
    record = build(root)
    meta_path = record / "record.meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    meta["links"] = {"discussion": "https://chat.example.org/team/pl/from-post"}
    meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    def head() -> str:
        out = run(str(record))
        assert out.returncode == 0, out.stderr + out.stdout
        return (record / "record.md").read_text(encoding="utf-8").split("---")[1]

    assert "from-post" in head()
    record_fields.save(record, {"discussion": "https://chat.example.org/team/pl/by-hand"},
                       why="w", family=root, events=[], link_hosts=["chat.example.org"])
    assert "by-hand" in head()
    record_fields.save(record, {"discussion": ""}, why="w", family=root, events=[])
    text = head()
    assert "discussion" not in text, text


def test_discussion_from_a_foreign_host_is_refused(tmp_path):
    root = make_corpus(tmp_path, [])
    record = build(root)
    with pytest.raises(record_fields.Refused):
        record_fields.save(record, {"discussion": "https://evil.example.com/x"}, why="w",
                           family=root, events=[], link_hosts=["chat.example.org"])


def test_date_by_hand_lands_in_head_too(tmp_path):
    """Календарь пересобирает `talk`; рука обязана жить там, где её никто не трогает."""
    root = make_corpus(tmp_path, [])
    record = build(root)
    record_fields.save(record, {"date": "2026-03-13"}, why="w", family=root, events=[])
    meta = json.loads((record / "record.meta.json").read_text(encoding="utf-8"))
    assert meta["head"]["date"] == "2026-03-13"


# --- ручки ----------------------------------------------------------------------------------

@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def demo_record():
    """Запись демо-корпуса с материалом; мета и файлы возвращаются как были."""
    corpus = app.state.default_corpus
    meta = corpus.index.all()[0]
    folder = corpus.index.path_of(meta).parent
    meta_path = folder / "record.meta.json"
    saved = meta_path.read_bytes() if meta_path.is_file() else None
    (folder / "files").mkdir(exist_ok=True)
    (folder / "files" / "deck.pdf").write_bytes(b"%PDF-1.4 demo")
    data = json.loads(saved) if saved else {}
    data["attachments"] = [{"file": "files/deck.pdf", "title": "Слайды", "from": "site"}]
    meta_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    try:
        yield meta.id, folder
    finally:
        shutil.rmtree(folder / "files", ignore_errors=True)
        if saved is None:
            meta_path.unlink(missing_ok=True)
        else:
            meta_path.write_bytes(saved)


def test_list_and_get(client, demo_record):
    rid, _ = demo_record
    r = client.get(f"/api/records/{rid}/files")
    assert r.status_code == 200 and r.json()["files"][0]["title"] == "Слайды"
    r = client.get(f"/api/records/{rid}/files/files/deck.pdf")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")
    for bad in ("record.md", "../record.md", "files/нет.pdf"):
        assert client.get(f"/api/records/{rid}/files/{bad}").status_code == 404, bad


def test_attach_is_refused_when_editing_is_off(client, demo_record):
    rid, _ = demo_record
    app.state.cfg.editing.enabled = False
    assert client.put(f"/api/records/{rid}/files/a.pdf", content=b"x").status_code == 403
    assert client.delete(f"/api/records/{rid}/files/files/deck.pdf").status_code == 403


def test_attach_and_detach(client, demo_record):
    rid, folder = demo_record
    app.state.cfg.editing.enabled = True
    app.state.cfg.editing.local_only = False
    try:
        r = client.put(f"/api/records/{rid}/files/Заметки.md", content="# итог".encode())
        assert r.status_code == 200, r.text
        assert r.json()["file"]["file"] == "files/Заметки.md"
        assert client.put(f"/api/records/{rid}/files/x.html", content=b"<b>").status_code == 400
        assert client.put(f"/api/records/{rid}/files/empty.pdf", content=b"").status_code == 400
        r = client.delete(f"/api/records/{rid}/files/files/deck.pdf")
        assert r.status_code == 200 and [f["file"] for f in r.json()["files"]] == ["files/Заметки.md"]
        assert client.get(f"/api/records/{rid}/files/files/deck.pdf").status_code == 404
        assert not list(folder.glob(".attach-*")), "временный файл остался в каталоге записи"
    finally:
        app.state.cfg.editing.enabled = False
        app.state.cfg.editing.local_only = True
