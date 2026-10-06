"""Имена материалов записи — ОДНО правило на сайт и на клиент загрузки.

Материал приходит на сервер с именем из URL (`attach-<имя>` в пакете загрузки или имя в адресе
правки), и сервер принимает только имя, которое уже прошло это правило. Клиент на маке коллеги
везёт снимок `tools/`, а не `app/`, поэтому правило живёт здесь: два его экземпляра однажды
разошлись бы, и материал отклонялся бы после часа расшифровки.
"""

from __future__ import annotations

import re
import unicodedata

# Что принимаем и отдаём по умолчанию. Исполняемого и разметки, которую браузер ВЫПОЛНИТ
# (html, svg), здесь нет намеренно: файл отдаётся с адреса сайта, а значит с его cookie.
DEFAULT_EXT = ("pdf", "pptx", "ppt", "key", "odp", "docx", "doc", "xlsx", "xls", "csv", "ipynb",
               "zip", "md", "txt", "png", "jpg", "jpeg")
NAME_MAX = 120


def ext_of(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def safe_name(name: str, allowed=DEFAULT_EXT) -> str:
    """Имя, которое можно положить на диск: только последняя часть пути, без управляющих знаков и
    точки в начале, расширение — из белого списка и в нижнем регистре. Кириллица остаётся — это
    имя видит человек в Загрузках. Не подходит — `ValueError` с причиной."""
    base = unicodedata.normalize("NFC", str(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    base = re.sub(r"[\x00-\x1f\x7f]", "", base)
    base = re.sub(r"\s+", " ", base).strip().lstrip(".").strip()
    ext = ext_of(base)
    if not ext or ext not in {e.lower() for e in allowed}:
        raise ValueError(f"такие файлы не принимаются: {base or name!r}; можно: {', '.join(allowed)}")
    stem = base[: -(len(ext) + 1)].strip() or "файл"
    stem = stem[: NAME_MAX - len(ext) - 1]
    return f"{stem}.{ext}"
