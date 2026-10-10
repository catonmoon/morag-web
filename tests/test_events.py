"""Журнал событий просмотра (`app/events.py`, `app/api/events.py`).

Что закрепляем:
  * выключенный журнал не пишет НИЧЕГО и не заводит файла — включает владелец осознанно;
  * зритель подписан псевдонимом, а не логином, и псевдоним один и тот же между заходами;
  * принимается только белый список родов и полей — браузер не может записать что угодно;
  * хвост очереди дописывается при остановке: рестарт службы не теряет последние секунды.
"""

from __future__ import annotations

import shutil
import sqlite3
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))


def _site(tmp_path, monkeypatch, *, events: bool):
    from app.auth.local import hash_password

    demo = tmp_path / "demo"
    shutil.copytree(REPO / "corpora" / "demo", demo)
    cfg = tmp_path / "config.yml"
    cfg.write_text(
        "corpora:\n"
        f"  - dir: {demo}\n"
        f"events:\n  enabled: {'true' if events else 'false'}\n  path: ./events.sqlite\n  flush_seconds: 60\n"
        "auth:\n  enabled: true\n  secret: секрет-теста\n"
        f"  data_dir: {tmp_path / 'authdata'}\n"
        "  users:\n"
        f"    - login: kuznetsova\n      password: \"{hash_password('пароль')}\"\n"
        "      name: Мария Кузнецова\n      role: viewer\n",
        encoding="utf-8")
    monkeypatch.setenv("MORAG_WEB_CONFIG", str(cfg))
    monkeypatch.setenv("MORAG_WEB_CORPUS", str(demo))
    from app.main import app
    return app, tmp_path / "events.sqlite"


def _rows(db: Path) -> list[tuple]:
    with sqlite3.connect(db) as con:
        return con.execute("SELECT kind, slug, record, pos, val, path, who, dept FROM events ORDER BY rowid").fetchall()


def _login(c: TestClient) -> None:
    assert c.post("/api/auth/login", json={"login": "kuznetsova", "password": "пароль"}).status_code == 200


def test_off_by_default_writes_nothing(tmp_path, monkeypatch):
    app, db = _site(tmp_path, monkeypatch, events=False)
    with TestClient(app) as c:
        _login(c)
        assert c.post("/api/events", json={"events": [{"kind": "view", "path": "/x"}]}).status_code == 204
        assert c.get("/api/site").json()["events"] is False
    assert not db.exists()


def test_without_a_session_nobody_writes(tmp_path, monkeypatch):
    app, db = _site(tmp_path, monkeypatch, events=True)
    with TestClient(app) as c:
        assert c.post("/api/events", json={"events": [{"kind": "view"}]}).status_code == 401
        c.app.state.events.flush()
        assert _rows(db) == []


def test_events_are_written_under_a_pseudonym(tmp_path, monkeypatch):
    app, db = _site(tmp_path, monkeypatch, events=True)
    with TestClient(app) as c:
        _login(c)
        assert c.get("/api/site").json()["events"] is True
        r = c.post("/api/events", json={"events": [
            {"kind": "view", "path": "/demo/rec/a", "record": "a"},
            {"kind": "beat", "record": "a", "pos": 12.34567, "val": 1.5},
        ]})
        assert r.status_code == 204
        c.post("/api/events", json={"events": [{"kind": "pause", "record": "a", "pos": 20}]})
        c.app.state.events.flush()
        rows = _rows(db)
    assert [r[0] for r in rows] == ["view", "beat", "pause"]
    assert rows[1][2:5] == ("a", 12.346, 1.5)
    whos = {r[6] for r in rows}
    assert len(whos) == 1
    who = whos.pop()
    assert who and "kuznetsova" not in who and len(who) == 16


def test_only_known_kinds_and_fields_get_in(tmp_path, monkeypatch):
    app, db = _site(tmp_path, monkeypatch, events=True)
    with TestClient(app) as c:
        _login(c)
        c.post("/api/events", json={"events": [
            {"kind": "drop table", "path": "/x"},
            {"kind": "seek", "record": "r" * 500, "pos": "сорок", "val": None,
             "who": "подделка", "dept": "подделка", "question": "текст"},
            "не объект",
        ] + [{"kind": "view"}] * 100})
        c.post("/api/events", content=b"{not json")
        c.app.state.events.flush()
        rows = _rows(db)
    assert rows[0][0] == "seek"
    assert len(rows[0][2]) == 200 and rows[0][3] is None
    assert rows[0][6] != "подделка" and rows[0][7] is None
    assert len(rows) == 50 - 2  # пачка обрезана до max_batch, два мусорных — отброшены


def test_department_is_written_openly(tmp_path, monkeypatch):
    app, db = _site(tmp_path, monkeypatch, events=True)
    from app.auth.service import AuthService, Identity

    person = Identity(login="kuznetsova", provider="ldap", name="Кузнецова Мария", role="viewer",
                      department="Отдел аналитики")

    def user_of(self, request):
        request.state.user = person
        return person

    monkeypatch.setattr(AuthService, "user_of", user_of)
    with TestClient(app) as c:
        c.post("/api/events", json={"events": [{"kind": "ask"}]})
    assert _rows(db)[0][7] == "Отдел аналитики"  # дописано при остановке, без flush


@pytest.mark.parametrize("value", ["1", True, float("inf")])
def test_numbers_are_numbers(value):
    from app.api.events import _num
    assert _num(value) is None
