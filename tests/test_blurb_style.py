"""make_blurb: длина сводки и вид материала — из `content.blurb` пространства.

Карточка на главной показывает сводку; одному корпусу нужны 2-3 предложения «о чём и что решили»,
другому — одна строка до 20 слов. Корпус без настройки получает прежнее (2-3 предложения).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import make_blurb  # noqa: E402

RECORD = '---\ntitle: "Kafka в бою"\nbranch: "Доклады"\n---\n\n[Кузнецова] <!-- t:0.0 --> Расскажу про Kafka.\n'


def _space(tmp_path: Path, site: str) -> Path:
    (tmp_path / "site.yml").write_text(site, encoding="utf-8")
    rec = tmp_path / "records" / "Доклады" / "2024" / "x"
    rec.mkdir(parents=True)
    (rec / "record.md").write_text(RECORD, encoding="utf-8")
    return rec


def test_default_style_is_unchanged(tmp_path):
    rec = _space(tmp_path, "slug: talks\n")
    p = make_blurb.build_prompt(rec)
    assert "2-3 предложения, 40-70 слов" in p
    assert "записи внутренней встречи или лекции компании" in p


def test_site_sets_length_and_material(tmp_path):
    rec = _space(tmp_path, "slug: talks\ncontent:\n  blurb: {sentences: 1, words: до 20, material: лекции курса, max_tokens: 120}\n")
    st = make_blurb.style_for(rec)
    assert st["max_tokens"] == 120
    p = make_blurb.build_prompt(rec, st)
    assert "1 предложение, до 20 слов" in p and "лекции курса" in p
    assert "Kafka в бою" in p
