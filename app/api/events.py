"""Приём событий просмотра от браузера (`app/events.py` — куда и зачем).

Ответ 204 ВСЕГДА — и при выключенном журнале, и на кривую пачку: браузеру незачем знать, что
мы записали, а ошибка тут не повод для повтора (`sendBeacon` и не умеет его). Сессию проверяет
общий гейт входа: без неё сюда не дойти.

Принимается только белый список родов и полей; строки режутся, числа — float или ничего.
Время ставит сервер: часы браузера врут, а порядок событий нужен по одной шкале.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import time

from fastapi import APIRouter, Request, Response

router = APIRouter(prefix="/api", tags=["events"])

KINDS = {"view", "play", "pause", "seek", "beat", "ask"}
MAX_BODY = 64 * 1024
MAX_STR = 200


def _text(value) -> str | None:
    return value[:MAX_STR] if isinstance(value, str) and value else None


def _num(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(float(value), 3)


def viewer_tag(secret: bytes, login: str) -> str:
    """Псевдоним зрителя: стабилен между днями, логин из него не восстановить без ключа сайта."""
    return hmac.new(secret, login.encode("utf-8"), hashlib.sha256).hexdigest()[:16]


@router.post("/events", status_code=204)
async def events(request: Request) -> Response:
    state = request.app.state
    log = getattr(state, "events", None)
    cfg = state.cfg.events
    done = Response(status_code=204)
    if log is None or not log.enabled:
        return done
    body = await request.body()
    if len(body) > MAX_BODY:
        return done
    try:
        items = json.loads(body).get("events")
    except (ValueError, AttributeError):
        return done
    if not isinstance(items, list):
        return done

    user = getattr(request.state, "user", None)
    who = viewer_tag(state.auth.derived_secret("events"), user.login) if user else None
    dept = (user.department or None) if user and cfg.department else None
    now = time.time()
    rows = []
    for item in items[: cfg.max_batch]:
        if not isinstance(item, dict) or item.get("kind") not in KINDS:
            continue
        rows.append({
            "ts": now, "kind": item["kind"], "slug": _text(item.get("slug")),
            "record": _text(item.get("record")), "pos": _num(item.get("pos")),
            "val": _num(item.get("val")), "path": _text(item.get("path")),
            "who": who, "dept": dept,
        })
    log.put(rows)
    return done
