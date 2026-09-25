"""Правка ПОЛЕЙ записи с сайта: куда ложатся значения и когда запись переезжает.

⚠️ Правка полей отличается от правки реплики одним: она может изменить МЕСТО записи. Ветка и год —
это каталоги, правила зовут туда по рубрике, меткам и дате; шапка, разошедшаяся с путём, ломает
и фильтр списка, и doc_id движка. Поэтому переезд здесь — часть правки, а не отдельная операция.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from app.content import fields as record_fields  # noqa: E402
from test_turn_edits import build, make_corpus, run  # noqa: E402

RECORD = "2026-03-12-grafana"


def prepared(tmp_path: Path) -> tuple[Path, Path]:
    root = make_corpus(tmp_path, [])
    return root, build(root)


def meta_of(record: Path) -> dict:
    return json.loads((record / "record.meta.json").read_text(encoding="utf-8"))


def test_fields_land_in_the_hand_of_the_owner_and_survive_a_rebuild(tmp_path):
    """⚠️⚠️ Значения ложатся в ключи, которые инструмент НЕ ТРОГАЕТ (`head`, `labels`, `roles`,
    `talk`). Иначе правка живёт до первой пересборки: шапку собирают заново из меты и словарей,
    а поля вроде названия копировались из старой шапки."""
    root, record = prepared(tmp_path)
    out = record_fields.save(record, {"title": "Новое имя", "summary": "О чём запись",
                                      "category": "Инструменты", "topics": ["Grafana"],
                                      "speakers": ["Мария Кузнецова"]},
                             why="правка: тест", family=root, events=[])
    assert set(out["changed"]) == {"title", "summary", "category", "topics", "speakers"}
    meta = meta_of(record)
    assert meta["head"]["title"] == "Новое имя" and meta["head"]["summary"] == "О чём запись"
    assert meta["labels"] == {"category": "Инструменты", "topics": ["Grafana"]}
    assert meta["roles"]["speakers"] == ["Мария Кузнецова"]
    assert "правка" in json.dumps(meta["_why"], ensure_ascii=False)

    # Пересборка — та же КОМАНДА, что запускает сайт после правки (`editing.rebuild`).
    out = run(str(record))
    assert out.returncode == 0, out.stderr + out.stdout
    head = (record / "record.md").read_text(encoding="utf-8").split("---")[1]
    assert '"Новое имя"' in head, "название пережило пересборку"
    assert "Инструменты" in head and "Мария Кузнецова" in head


def test_a_bad_date_is_refused_with_a_reason(tmp_path):
    root, record = prepared(tmp_path)
    try:
        record_fields.save(record, {"date": "вчера"}, why="w", family=root, events=[])
    except record_fields.Refused as error:
        assert "ГГГГ-ММ-ДД" in str(error)
    else:
        raise AssertionError("битую дату приняли")


def test_a_rubric_outside_the_rules_is_refused(tmp_path):
    root, record = prepared(tmp_path)
    try:
        record_fields.save(record, {"event": "Чужая рубрика"}, why="w", family=root,
                           events=["Доклады", "Встречи"])
    except record_fields.Refused as error:
        assert "раскладки" in str(error)
    else:
        raise AssertionError("рубрику вне правил приняли")


def test_nothing_to_change_is_refused(tmp_path):
    root, record = prepared(tmp_path)
    try:
        record_fields.save(record, {}, why="w", family=root, events=[])
    except record_fields.Refused as error:
        assert "нечего" in str(error)
    else:
        raise AssertionError("пустую правку приняли")


def test_the_record_moves_when_the_rules_call_it_elsewhere(tmp_path):
    """⚠️ Год — это каталог. Поменяли дату на другой год — каталог обязан переехать, иначе шапка
    и путь разойдутся; адрес страницы при этом не меняется (он по id записи)."""
    root, record = prepared(tmp_path)
    (root / "hub.yml").write_text(
        "spaces: [{slug: local, dir: .}]\n"
        "routing:\n  - match: {event: Доклады}\n    space: local\n    branch: Доклады\n",
        encoding="utf-8")
    moved_dir = root / "records" / "Доклады" / "2025"
    moved_dir.mkdir(parents=True)
    record.rename(moved_dir / RECORD)
    here = moved_dir / RECORD

    out = record_fields.save(here, {"event": "Доклады", "date": "2026-03-12"},
                             why="w", family=root, events=["Доклады"])
    assert out["move"] is not None, "правила зовут в другой год"
    where = record_fields.move(here, out["move"])
    assert where.parent.name == "2026" and (where / "record.md").is_file()
    assert not here.exists(), "старый каталог не остался"
