"""Кто видит запись: общая, личная, открытая по ссылке. ОДНА точка решения на весь сайт.

Модель (17.10). Видимость — это КАТАЛОГ, а не флаг: личная запись лежит в
`<пространство>/records-private/<логин>/<ветка>/…/<id>`, вне `sources[].path` индексатора, и в
поиск не попадает по построению. Кто ещё её видит — `record.meta.json` → `access`:

    "access": {"owner": "login", "link": "<соль ключа ссылки>",
               "granted": [{"login": "...", "name": "...", "at": "ГГГГ-ММ-ДД"}]}

Не в шапке: шапка уезжает в payload КАЖДОГО чанка, и смена доступа стоила бы переиндексации
(то же правило, что у материалов записи). На вырост в тот же блок лягут команды, отделы и
чёрный список — и он же станет источником фильтра доступа на ретриве движка.

Политика — подключаемый объект (`privacy.policy`), как провайдеры входа: сейчас одна,
«владелец + ссылка». Более богатая (команды из каталога, чёрный список, журнал) подключится в ту
же точку, ручки её не заметят.

⚠️ Чужому — 404, а не 403: ответ «нельзя» сообщает, что такая запись есть.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import date
from pathlib import Path

KEY = "access"


@dataclass(frozen=True)
class Viewer:
    """Кто смотрит. `local` — вход выключен и запрос с этой машины (разработка): видит всё,
    как и правка без входа живёт на петлевом адресе."""

    login: str = ""
    name: str = ""
    role: str = ""
    local: bool = False

    @property
    def admin(self) -> bool:
        return self.local or self.role == "admin"


class OwnerLinkPolicy:
    """Владелец + ссылка (17.10, решения владельца сайта):

    * личную запись видят хозяин, открывшие по ссылке и админ;
    * в ЛЕНТЕ админа чужих личных нет — он открывает их по адресу (поддержка), но его список и
      ответы не смешиваются с чужим личным;
    * управлять доступом — хозяин и админ.
    """

    name = "owner_link"

    def can_see(self, rec, viewer: Viewer | None) -> bool:
        if not rec.private:
            return True
        if viewer is None:
            return False
        return viewer.admin or self._own(rec, viewer)

    def listed(self, rec, viewer: Viewer | None) -> bool:
        if not rec.private:
            return True
        if viewer is None:
            return False
        return viewer.local or self._own(rec, viewer)

    def can_manage(self, rec, viewer: Viewer | None) -> bool:
        if viewer is None:
            return False
        return viewer.admin or bool(viewer.login and viewer.login == rec.owner)

    @staticmethod
    def _own(rec, viewer: Viewer) -> bool:
        return bool(viewer.login) and (viewer.login == rec.owner or viewer.login in rec.granted)


POLICIES = {OwnerLinkPolicy.name: OwnerLinkPolicy}


def policy_for(name: str):
    """Политика по имени из конфига. Незнакомое имя — отказ при старте, а не тихая подмена:
    опечатка в конфиге не должна открывать или закрывать записи по умолчанию."""
    try:
        return POLICIES[name or OwnerLinkPolicy.name]()
    except KeyError:
        raise ValueError(f"privacy.policy: нет политики {name!r}; есть: {', '.join(POLICIES)}") from None


# --- ключ ссылки ------------------------------------------------------------------------


def link_token(secret: bytes, record_id: str, salt: str) -> str:
    """Ключ ссылки — подпись `id` и соли. Соль пуста — ссылки нет вовсе."""
    if not salt:
        return ""
    return hmac.new(secret, f"{record_id}\n{salt}".encode("utf-8"), hashlib.sha256).hexdigest()[:32]


def check_link(secret: bytes, record_id: str, salt: str, token: str) -> bool:
    want = link_token(secret, record_id, salt)
    return bool(want) and hmac.compare_digest(want, str(token or ""))


def new_salt() -> str:
    return secrets.token_urlsafe(12)


# --- запись блока доступа -----------------------------------------------------------------


def read(record_dir: Path) -> dict:
    path = Path(record_dir) / "record.meta.json"
    if not path.is_file():
        return {}
    meta = json.loads(path.read_text(encoding="utf-8"))
    return dict(meta.get(KEY) or {}) if isinstance(meta.get(KEY), dict) else {}


def update(record_dir: Path, change) -> dict:
    """Поменять блок `access` в мете функцией `change(dict) -> dict`; через временный файл —
    мету рядом читают сборка и сайт."""
    path = Path(record_dir) / "record.meta.json"
    meta = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    block = change(dict(meta.get(KEY) or {}) if isinstance(meta.get(KEY), dict) else {})
    meta[KEY] = block
    tmp = path.with_suffix(".access.tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return block


def grant(record_dir: Path, viewer: Viewer) -> bool:
    """Открывший по ссылке получает доступ насовсем (пока хозяин не уберёт). True — добавлен."""
    added = False

    def change(block: dict) -> dict:
        nonlocal added
        granted = [g for g in (block.get("granted") or []) if isinstance(g, dict)]
        if any(str(g.get("login") or "").lower() == viewer.login for g in granted):
            return block
        added = True
        granted.append({"login": viewer.login, "name": viewer.name, "at": date.today().isoformat()})
        return {**block, "granted": granted}

    update(record_dir, change)
    return added


def revoke(record_dir: Path, login: str) -> bool:
    removed = False

    def change(block: dict) -> dict:
        nonlocal removed
        granted = [g for g in (block.get("granted") or []) if isinstance(g, dict)]
        kept = [g for g in granted if str(g.get("login") or "").lower() != login.lower()]
        removed = len(kept) != len(granted)
        return {**block, "granted": kept}

    update(record_dir, change)
    return removed
