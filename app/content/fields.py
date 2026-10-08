"""Правка ПОЛЕЙ записи с сайта: название, дата, рубрика, категория, темы, метки, люди, аннотация.

Почему так, а не «поправить `record.md`». Шапка выводится из меты и словарей при каждой
пересборке (`tools/make_record.py`), поэтому правка, положенная прямо в `record.md`, живёт до
первой же правки реплики. Правим то, из чего шапка СОБИРАЕТСЯ, — `record.meta.json`, и кладём
значения в ключи «руки владельца»: `head` (название, рубрика, метки, аннотация), `talk.date`
(дата), `labels` (категория и темы), `roles` (докладчики и участники). Их инструмент не трогает.

⚠️⚠️ Раскладка на диске — это ветка и год, и правила зовут запись по `event`/`tags`/`date`.
Поменяли рубрику или год — запись обязана ПЕРЕЕХАТЬ, иначе шапка разойдётся с путём (а путь
входит в doc_id движка и в фильтр списка). Переезд меняет место в поиске, но не адрес страницы:
он собран из id записи.
"""

from __future__ import annotations

import json
import logging
import shutil
import sys
from pathlib import Path

log = logging.getLogger(__name__)

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import spaces  # noqa: E402

from . import attachments
from .frontmatter import read_frontmatter

DATE = "date"
# Куда какое поле ложится в мете. Порядок ключей здесь — порядок разделов формы на странице.
HEAD_KEYS = ("title", "event", "tags", "summary", "discussion")
LABEL_KEYS = ("category", "topics")
ROLE_KEYS = ("speakers", "participants")


class Refused(Exception):
    """Поле не приняли — с причиной, а не 500."""


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError as error:
        raise Refused(f"мета записи битая: {error}") from error


def _write(path: Path, data: dict) -> None:
    # ⚠️ Через временный файл: правку полей и пересборку разделяют секунды, и половина файла,
    # прочитанная в этот момент, стоила бы записи.
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _clean(value, limit: int = 300):
    if isinstance(value, str):
        return value.strip()[:limit]
    if isinstance(value, list):
        return [str(v).strip()[:limit] for v in value if str(v).strip()]
    return value


def save(record_dir: Path, fields: dict, *, why: str, family: Path,
         events: list[str] | None = None, link_hosts: list[str] | None = None) -> dict:
    """Записать поля в мету и сказать, куда запись должна переехать.

    Возвращает `{changed: [...], move: Path|None}`. Сам перенос делает вызывающий — он же
    ставит НОВЫЙ каталог в пересборку.
    """
    given = {k: v for k, v in fields.items() if v is not None}
    if not given:
        raise Refused("нечего менять")
    if DATE in given and not _is_date(str(given[DATE])):
        raise Refused("дата пишется как ГГГГ-ММ-ДД")
    if given.get("event") and events and given["event"] not in events:
        raise Refused(f"рубрики «{given['event']}» нет в правилах раскладки")
    if "discussion" in given:
        # Пустая строка — «снять ссылку» и СОХРАНЯЕТСЯ пустой: иначе при сборке вернулась бы
        # ссылка из поста, которую человек только что убрал.
        try:
            given["discussion"] = attachments.check_link(given["discussion"], link_hosts or ())
        except attachments.Refused as error:
            raise Refused(str(error)) from error

    path = record_dir / "record.meta.json"
    meta = _load(path)
    head = dict(meta.get("head") or {})
    labels = dict(meta.get("labels") or {})
    roles = dict(meta.get("roles") or {})
    talk = dict(meta.get("talk") or {})

    changed = []
    for key in HEAD_KEYS:
        if key in given:
            head[key] = _clean(given[key], {"summary": 4000, "discussion": 1000}.get(key, 300))
            changed.append(key)
    for key in LABEL_KEYS:
        if key in given:
            labels[key] = _clean(given[key])
            changed.append(key)
    for key in ROLE_KEYS:
        if key in given:
            roles[key] = _clean(given[key])
            changed.append(key)
    if DATE in given:
        talk[DATE] = str(given[DATE])
        # ⚠️ И в `head`: `talk` пересобирается из календаря (`make_meta`), и рука там не отличима
        # от календарной даты; `head` — целиком рука, его инструменты не трогают.
        head[DATE] = str(given[DATE])
        changed.append(DATE)

    if not changed:
        raise Refused("нечего менять")
    meta["head"] = head
    if labels:
        meta["labels"] = labels
    if roles:
        meta["roles"] = roles
    if talk:
        meta["talk"] = talk
    # Подпись правки — как у имён голосов: через год видно, кто и когда трогал поля.
    meta["_why"] = {**(meta.get("_why") or {}), "head": why}
    _write(path, meta)

    move = _where(record_dir, head, talk, family)
    log.info("поля записи %s: %s%s", record_dir.name, ", ".join(changed),
             f" → переезд в {move}" if move else "")
    return {"changed": changed, "move": move}


def _is_date(value: str) -> bool:
    return len(value) == 10 and value[4] == "-" and value[7] == "-" and value[:4].isdigit()


def _where(record_dir: Path, head: dict, talk: dict, family: Path) -> Path | None:
    """Куда правила зовут запись ТЕПЕРЬ. `None` — она уже на месте.

    ⚠️ Читаем поля из СОБРАННОЙ шапки, дополняя правкой: рубрика и метки могли не меняться, а
    решают раскладку вместе с датой. Шапку читает тот же разбор, что и сайт.
    """
    md = record_dir / "record.md"
    fm = read_frontmatter(md) if md.is_file() else {}
    event = str(head.get("event") if head.get("event") is not None else fm.get("event") or "")
    tags = head.get("tags") if head.get("tags") is not None else (fm.get("tags") or [])
    date = str(talk.get(DATE) or fm.get("date") or "")
    branch = spaces.branch_of(event, list(tags), family)
    levels = spaces.sub_levels(event, list(tags), date, family)
    if not branch or not levels:
        return None                       # раскладка не решена правилами — не двигаем вслепую
    root = _root_of(record_dir, family)
    # Внутри потока на любой глубине (неделя, тема) — на месте: глубже правила раскладывает
    # человек, и правка поля не должна выдёргивать запись из её недели.
    if spaces.within(record_dir, root, branch, levels):
        return None
    return root.joinpath(branch, *levels, record_dir.name)


def _root_of(record_dir: Path, family: Path) -> Path:
    """Корень `records/` того пространства, где запись лежит сейчас."""
    for parent in record_dir.parents:
        if parent.name == "records":
            return parent
    return family / "records"


def move(record_dir: Path, target: Path) -> Path:
    """Перенести каталог записи целиком: сайдкары, кадры, слайды — одним движением."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise Refused(f"каталог {target} уже занят")
    shutil.move(str(record_dir), str(target))
    return target
