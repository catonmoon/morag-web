#!/usr/bin/env python3
"""Автор у записей, загруженных ДО личных записей (17.10): `access.owner` из `sources.upload.by`.

Приём загрузки с 17.10 пишет автора структурно (`record.meta.json` → `access.owner`), а до этого
был только «Имя (логин)» строкой. Без автора хозяин не может скрыть свою общую запись
(`/api/records/<id>/access` отвечает 409 «скрыть её некому»). Видимость инструмент НЕ трогает:
общие записи остаются общими, решает автор.

    python3 tools/access_backfill.py            # отчёт: кому что проставится
    python3 tools/access_backfill.py --write    # записать

⚠️ Пишет только мету (`record.meta.json`), `record.md` не трогает: шапка в индекс, мета — нет,
поэтому переиндексации это не стоит.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spaces  # noqa: E402

LOGIN_RE = re.compile(r"\(([A-Za-z0-9._-]+)\)\s*$")


def owner_of(meta: dict) -> str:
    """Логин из «Имя (логин)» приёма; «local» (вход был выключен) — не автор."""
    sources = meta.get("sources") if isinstance(meta.get("sources"), dict) else {}
    upload = sources.get("upload") if isinstance(sources.get("upload"), dict) else {}
    by = str(upload.get("by") or "")
    m = LOGIN_RE.search(by)
    return m.group(1).lower() if m else ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--write", action="store_true", help="записать (без флага — только отчёт)")
    args = ap.parse_args()

    found = 0
    for record in spaces.record_dirs():
        path = record / "record.meta.json"
        if not path.is_file():
            continue
        meta = json.loads(path.read_text(encoding="utf-8"))
        block = meta.get("access") if isinstance(meta.get("access"), dict) else {}
        login = owner_of(meta)
        if not login or block.get("owner"):
            continue
        found += 1
        print(f"{record.name}: автор {login}")
        if args.write:
            meta["access"] = {**block, "owner": login}
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            tmp.replace(path)
    print(f"\nзаписей без автора, у которых он известен: {found}"
          + ("" if args.write else " (--write, чтобы записать)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
