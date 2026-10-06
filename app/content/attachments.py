"""Материалы записи: презентации, PDF, ноутбуки — файлы, которые лежат РЯДОМ с расшифровкой.

Список живёт в `record.meta.json` → `attachments`, а не в шапке `record.md`, и это решение по
цене: шапка уезжает в payload каждого чанка, и любое поле в ней стоит переиндексации записи, а
материал поиску не нужен — его скачивают. Мету индексатор не смотрит вовсе.

Элемент: `{file, title, size, from, by?, at?, removed?}`. `file` — путь ВНУТРИ каталога записи:
приложенное с сайта ложится в `files/`, старые колоды, перенесённые с прежнего сайта, остаются
там, где лежали, и просто вносятся в список. `from` — откуда знаем: `site` (приложили с сайта),
`upload` (пришло с записью), `post`/`calendar` (выведено корпусом из своих источников).

⚠️⚠️ ИСТИНА — СПИСОК, А НЕ ФАЙЛ. Убранный материал не удаляется с диска, а помечается
`removed`: доставка корпуса между машинами умеет только добавлять (`rsync --update`), и
удалённый на одной машине файл вернулся бы с другой — с пометкой же он вернётся невидимым. Та же
пометка не даёт корпусу вывести убранную колоду заново из своих источников. И убрать можно
обратно — снятием пометки.

Отдаётся только файл, который есть в списке без пометки, с расширением из белого списка и
внутри каталога записи (проверяется разрешённый путь, а не строка — символическая ссылка
обманула бы строку).
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import sys
from contextlib import contextmanager
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import attach_names  # noqa: E402
from attach_names import DEFAULT_EXT, ext_of  # noqa: E402,F401  — белый список общий с клиентом

META = "record.meta.json"
FILES_DIR = "files"
KEY = "attachments"
# Смотреть прямо в браузере — только то, что браузер показывает сам и безопасно.
INLINE = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
          "txt": "text/plain; charset=utf-8", "md": "text/plain; charset=utf-8"}


class Refused(Exception):
    """Материал не приняли — с причиной (и кодом ответа), а не 500."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def safe_name(name: str, allowed: tuple[str, ...] | list[str] = DEFAULT_EXT) -> str:
    """Правило имени — общее с клиентом загрузки (`tools/attach_names.py`)."""
    try:
        return attach_names.safe_name(name, allowed)
    except ValueError as error:
        raise Refused(str(error)) from error


def _load(record_dir: Path) -> dict:
    path = record_dir / META
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError as error:
        raise Refused(f"мета записи битая: {error}", 500) from error


def _write(record_dir: Path, meta: dict) -> None:
    path = record_dir / META
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


@contextmanager
def _locked(record_dir: Path):
    """Замок на каталог записи: два человека, приложившие файлы разом, иначе затёрли бы список
    друг друга (прочитал — дописал — записал). Замок на сам каталог, а не на файл рядом: лишний
    файл в каталоге записи уехал бы доставкой."""
    fd = os.open(record_dir, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _inside(record_dir: Path, rel: str) -> Path | None:
    try:
        path = (record_dir / rel).resolve()
        path.relative_to(record_dir.resolve())
    except (ValueError, OSError):
        return None
    return path if path.is_file() else None


def items(record_dir: Path, allowed=DEFAULT_EXT) -> list[dict]:
    """Видимые материалы записи: в списке, без пометки, файл на месте, расширение разрешено."""
    out = []
    for item in _load(record_dir).get(KEY) or []:
        rel = str(item.get("file") or "")
        if not rel or item.get("removed") or ext_of(rel) not in allowed:
            continue
        path = _inside(record_dir, rel)
        if path is None:
            continue
        out.append({"file": rel, "title": str(item.get("title") or Path(rel).name),
                    "size": path.stat().st_size, "ext": ext_of(rel),
                    "from": str(item.get("from") or ""), "at": str(item.get("at") or "")})
    return out


def find(record_dir: Path, rel: str, allowed=DEFAULT_EXT) -> Path | None:
    """Путь к материалу для отдачи — только если он виден (см. `items`)."""
    for item in items(record_dir, allowed):
        if item["file"] == rel:
            return _inside(record_dir, rel)
    return None


def _free_name(folder: Path, name: str, taken: set[str]) -> str:
    """Имя занято (файлом на диске или строкой списка, в том числе убранной) — `-2`, `-3`…"""
    stem, ext = name.rsplit(".", 1)
    candidate, n = name, 1
    while (folder / candidate).exists() or f"{FILES_DIR}/{candidate}" in taken:
        n += 1
        candidate = f"{stem}-{n}.{ext}"
    return candidate


def add(record_dir: Path, name: str, source: Path, *, by: str = "", source_from: str = "site",
        allowed=DEFAULT_EXT, title: str = "") -> dict:
    """Переложить принятый файл (`source`, временный) в `files/` и внести в список."""
    clean = safe_name(name, allowed)
    folder = record_dir / FILES_DIR
    with _locked(record_dir):
        meta = _load(record_dir)
        listed = list(meta.get(KEY) or [])
        final = _free_name(folder, clean, {str(i.get("file") or "") for i in listed})
        folder.mkdir(exist_ok=True)
        os.replace(source, folder / final)
        item = {"file": f"{FILES_DIR}/{final}", "title": (title or clean).strip()[:200],
                "size": (folder / final).stat().st_size, "from": source_from,
                "at": date.today().isoformat()}
        if by:
            item["by"] = by
        listed.append(item)
        meta[KEY] = listed
        _write(record_dir, meta)
    return item


def remove(record_dir: Path, rel: str, *, by: str = "") -> bool:
    """Убрать материал из списка пометкой (см. докстринг модуля). False — такого нет."""
    with _locked(record_dir):
        meta = _load(record_dir)
        listed = list(meta.get(KEY) or [])
        hit = False
        for item in listed:
            if item.get("file") == rel and not item.get("removed"):
                item["removed"] = by or f"убрано с сайта, {date.today().isoformat()}"
                hit = True
        if hit:
            meta[KEY] = listed
            _write(record_dir, meta)
    return hit


def check_link(url: str, hosts: list[str] | tuple[str, ...] = ()) -> str:
    """Ссылка на обсуждение: http(s), без пробелов; хост — из белого списка, если он задан.
    Пустая строка — «снять ссылку», её и возвращаем."""
    url = str(url or "").strip()
    if not url:
        return ""
    m = re.match(r"^https?://([^/\s?#]+)[^\s]*$", url)
    if not m or len(url) > 1000:
        raise Refused("ссылка на обсуждение — адрес вида https://…")
    host = m.group(1).lower().split("@")[-1].split(":")[0]
    if hosts and host not in {h.lower() for h in hosts}:
        raise Refused(f"ссылка на обсуждение принимается только с {', '.join(hosts)}")
    return url
