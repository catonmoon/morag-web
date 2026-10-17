"""Доступ к записи: личная, по ссылке, «показать всем» (17.10). Модель — `app/content/access.py`.

Здесь две вещи:

* ЗАСЛОНКИ для остальных ручек — `viewer_of`, `visible_or_404`, `visible_records`: любая ручка,
  отдающая запись или сведения о ней, спрашивает их, а не решает сама;
* РУЧКИ доступа — что видит хозяин (ссылка, кто открыл), переключение видимости, сброс ссылки,
  «убрать человека», приём по ссылке, видео личной записи.

⚠️ Переключение видимости ПЕРЕНОСИТ каталог записи (`records/` ↔ `records-private/<логин>/`) и
видео (архив ↔ `upload.private_media`), а шапку не трогает: ветка и путь видео в шапке те же.
Общая → личная: запись выпадает из индекса движка при ближайшей индексации; чтобы не ждать
ночи, сразу запускаем `upload.index`, если он задан.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from ..content import access
from ..content import fields  # noqa: F401 — ставит `tools/` на sys.path (там `spaces`)
from ..content.records import RecordMeta

import spaces  # noqa: E402

router = APIRouter(prefix="/api", tags=["access"])
log = logging.getLogger(__name__)

LOOPBACK = {"127.0.0.1", "::1", "localhost"}
_BACKGROUND: set = set()


# --- кто смотрит ---------------------------------------------------------------------------


def viewer_of(request: Request) -> access.Viewer | None:
    """Вошедший — по сессии; без входа — только петлевой адрес (разработка), иначе никто."""
    state = request.app.state
    auth = getattr(state, "auth", None)
    if auth is not None and auth.enabled:
        user = auth.user_of(request)
        if user is None:
            return None
        return access.Viewer(login=user.login.lower(), name=user.name, role=user.role)
    from .ask import _client_ip  # noqa: PLC0415 — ask тянет движок, импорт по месту
    ip = _client_ip(request, state.cfg.server.trusted_proxy_hops)
    return access.Viewer(local=True) if ip in LOOPBACK else None


def policy(request: Request):
    found = getattr(request.app.state, "privacy", None)
    if found is None:
        found = access.policy_for(request.app.state.cfg.privacy.policy)
        request.app.state.privacy = found
    return found


def can_see(request: Request, rec: RecordMeta) -> bool:
    return policy(request).can_see(rec, viewer_of(request))


def visible_or_404(request: Request, corpus, record_id: str) -> RecordMeta:
    """Запись по id — если смотрящему её видно; иначе 404, как будто её нет."""
    meta = corpus.index.by_id(record_id)
    if meta is None or not can_see(request, meta):
        raise HTTPException(404, "нет такой записи")
    return meta


def visible_records(request: Request, corpus) -> list[RecordMeta]:
    """Записи для СПИСКА: общие и свои (у админа чужих личных в ленте нет — см. политику)."""
    pol, viewer = policy(request), viewer_of(request)
    return [r for r in corpus.index.all() if pol.listed(r, viewer)]


def visible_ids(request: Request) -> set[str]:
    """id записей, которые смотрящий вправе ВИДЕТЬ (по всем пространствам) — для ручек, что
    перечисляют записи по id (снимок голосов, токены)."""
    pol, viewer = policy(request), viewer_of(request)
    out: set[str] = set()
    for corpus in request.app.state.corpora.values():
        out.update(r.id for r in corpus.index.all() if pol.can_see(r, viewer))
    return out


def private_ids(request: Request) -> set[str]:
    out: set[str] = set()
    for corpus in request.app.state.corpora.values():
        out.update(r.id for r in corpus.index.all() if r.private)
    return out


# --- видео личной записи -------------------------------------------------------------------


def private_media_root(request: Request) -> Path:
    cfg = request.app.state.cfg
    if cfg.upload.private_media:
        return Path(cfg.upload.private_media)
    from ..config import family_dir  # noqa: PLC0415
    return family_dir(cfg) / "private-media"


def _inside(base: Path, name: str) -> Path | None:
    try:
        path = (base / name).resolve()
        path.relative_to(base.resolve())
    except (ValueError, OSError):
        return None
    return path if path.is_file() else None


def media_url(corpus, rec: RecordMeta) -> str:
    """Адрес видео личной записи — через сайт, с проверкой доступа. У общей — пусто: её видео
    берётся как всегда, из `media_base`. Форма — `content/resolve.py::media_url` (одна на двоих)."""
    if not rec.private or not rec.media:
        return ""
    from ..content.resolve import media_url as build  # noqa: PLC0415
    return build(rec, corpus.slug)


def _ranges(header: str, size: int) -> tuple[int, int] | None:
    """`bytes=a-b` → (a, b) включительно; многодиапазонный и кривой — None (отдадим целиком)."""
    if not header.startswith("bytes=") or "," in header:
        return None
    start_s, _, end_s = header[6:].strip().partition("-")
    try:
        if start_s == "":
            length = int(end_s)
            start, end = max(0, size - length), size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start > end or start >= size:
        return None
    return start, min(end, size - 1)


def _stream(path: Path, start: int, end: int, chunk: int = 1 << 20):
    with path.open("rb") as f:
        f.seek(start)
        left = end - start + 1
        while left > 0:
            data = f.read(min(chunk, left))
            if not data:
                break
            left -= len(data)
            yield data


@router.get("/records/{record_id}/media")
async def record_media(request: Request, record_id: str, slug: str | None = None):
    """Видео личной записи. Перемотка и караоке требуют диапазонов (206): плеер просит кусок
    у места перемотки. Отвечаем сами, не полагаясь на версию Starlette на сервере.

    ⚠️ Общая запись здесь НЕ отдаётся: её видео раздаёт архив (`media_base`), и вторая дверь к
    тем же файлам — лишняя поверхность."""
    from .site import _corpus  # noqa: PLC0415
    corpus = _corpus(request, slug)
    rec = visible_or_404(request, corpus, record_id)
    if not rec.private or not rec.media:
        raise HTTPException(404, "нет видео")
    path = _inside(private_media_root(request), rec.media)
    if path is None:
        raise HTTPException(404, "нет видео")
    size = path.stat().st_size
    kind = {"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime",
            "m4v": "video/mp4", "mkv": "video/x-matroska"}.get(path.suffix.lower().lstrip("."),
                                                                "application/octet-stream")
    head = {"Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
    wanted = _ranges(request.headers.get("range") or "", size)
    if wanted is None:
        if request.headers.get("range"):
            return Response(status_code=416, headers={**head, "Content-Range": f"bytes */{size}"})
        return StreamingResponse(_stream(path, 0, size - 1), media_type=kind,
                                 headers={**head, "Content-Length": str(size)})
    start, end = wanted
    return StreamingResponse(_stream(path, start, end), status_code=206, media_type=kind,
                             headers={**head, "Content-Length": str(end - start + 1),
                                      "Content-Range": f"bytes {start}-{end}/{size}"})


# --- ручки доступа -------------------------------------------------------------------------


class Visibility(BaseModel):
    visibility: str = Field(pattern="^(private|public)$")


class Accept(BaseModel):
    k: str = Field(min_length=8, max_length=80)


def _enabled(request: Request) -> None:
    if not request.app.state.cfg.privacy.enabled:
        raise HTTPException(404, "личные записи выключены")


def _secret(request: Request) -> bytes:
    return request.app.state.auth.derived_secret("share")


def _managed(request: Request, record_id: str, slug: str | None):
    """(пространство, запись) — если смотрящий вправе управлять доступом; иначе 404/403."""
    from .site import _corpus  # noqa: PLC0415
    _enabled(request)
    corpus = _corpus(request, slug)
    rec = visible_or_404(request, corpus, record_id)
    if not policy(request).can_manage(rec, viewer_of(request)):
        raise HTTPException(403, "доступом управляет автор записи или администратор")
    return corpus, rec


def _state(request: Request, corpus, rec: RecordMeta) -> dict:
    block = access.read(Path(rec.file).parent)
    token = access.link_token(_secret(request), rec.id, rec.link) if rec.private else ""
    return {
        "id": rec.id,
        "visibility": "private" if rec.private else "public",
        "owner": rec.owner,
        # Ссылка — относительная: адрес сайта и префикс пространства знает фронт.
        "key": token,
        "granted": [{"login": str(g.get("login") or ""), "name": str(g.get("name") or ""),
                     "at": str(g.get("at") or "")}
                    for g in (block.get("granted") or []) if isinstance(g, dict)],
        "can_publish": bool(rec.owner),
    }


@router.get("/records/{record_id}/access")
async def get_access(request: Request, record_id: str, slug: str | None = None) -> dict:
    corpus, rec = _managed(request, record_id, slug)
    return _state(request, corpus, rec)


def _move_video(rec: RecordMeta, src_root: Path | None, dst_root: Path | None) -> None:
    """Видео записи — между архивом и личным каталогом, тем же относительным путём.

    Нет видео в шапке — двигать нечего. Нет файла ни там, ни там — отказ: запись осталась бы
    без видео или, хуже, с видео в открытом архиве при «личной» записи."""
    if not rec.media:
        return
    if src_root is None or dst_root is None:
        raise HTTPException(409, "архив видео не настроен (upload.archive) — переключить нельзя")
    src, dst = src_root / rec.media, dst_root / rec.media
    if dst.is_file() and not src.is_file():
        return  # уже на месте (повтор после сбоя)
    if not src.is_file():
        raise HTTPException(409, f"видео {rec.media} не найдено — переключить нельзя")
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    except OSError as error:
        raise HTTPException(500, f"не перенёс видео: {error}") from None


@router.post("/records/{record_id}/access")
async def set_access(request: Request, record_id: str, payload: Visibility,
                     slug: str | None = None) -> dict:
    """Показать всем или скрыть. Переносит каталог записи и видео; шапка не меняется."""
    corpus, rec = _managed(request, record_id, slug)
    want_private = payload.visibility == "private"
    if want_private == rec.private:
        return _state(request, corpus, rec)
    if want_private and not rec.owner:
        # Общая запись без автора (перенесённая из старого сайта) — чья она станет личной? Решать
        # это вслепую нельзя: личная у кого-то одного.
        raise HTTPException(409, "у записи нет автора — скрыть её некому")
    record_dir = Path(rec.file).parent
    archive = Path(request.app.state.cfg.upload.archive) if request.app.state.cfg.upload.archive else None
    private_root = private_media_root(request)
    try:
        target = (spaces.private_target(record_dir, rec.owner) if want_private
                  else spaces.public_target(record_dir))
    except ValueError as error:
        raise HTTPException(409, str(error)) from None
    if target.exists():
        raise HTTPException(409, f"каталог {target.name} на новом месте уже занят")

    # Видео — первым: упади перенос каталога, вернуть файл проще, чем открыть утёкшее.
    if want_private:
        _move_video(rec, archive, private_root)
    else:
        _move_video(rec, private_root, archive)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(record_dir), str(target))
    _prune_empty(record_dir.parent)
    if want_private and not access.read(target).get("link"):
        access.update(target, lambda b: {**b, "owner": rec.owner, "link": access.new_salt()})
    elif not want_private:
        access.update(target, lambda b: {**b, "owner": rec.owner})
    corpus.index.build()
    log.info("доступ: %s → %s (%s)", rec.id, payload.visibility,
             (viewer_of(request) or access.Viewer()).login or "local")

    # Общая → личная: из индекса движка запись уйдёт при ближайшей индексации — не ждём ночи.
    cfg = request.app.state.cfg
    index_cmd = cfg.privacy.reindex or cfg.upload.index
    if want_private and index_cmd:
        # Ссылку на задачу держим: цикл событий хранит только слабую, и фоновую задачу без неё
        # может собрать сборщик мусора посреди прогона.
        task = asyncio.get_running_loop().create_task(_reindex(request, index_cmd))
        _BACKGROUND.add(task)
        task.add_done_callback(_BACKGROUND.discard)
    return _state(request, corpus, corpus.index.by_id(record_id))


def _prune_empty(start: Path) -> None:
    """Убрать опустевшие каталоги ветки/года после переезда, но не выше корня записей."""
    path = start
    for _ in range(8):
        if path.name in ("records", spaces.PRIVATE_DIR) or not path.is_dir() or any(path.iterdir()):
            return
        path.rmdir()
        path = path.parent


async def _reindex(request: Request, argv: list[str]) -> None:
    from ..config import family_dir  # noqa: PLC0415
    from ..content.upload import _run  # noqa: PLC0415
    root = Path(__file__).resolve().parents[2]
    try:
        await _run(argv, root, {"family": str(family_dir(request.app.state.cfg)),
                                "record_dir": "", "artifact": ""})
        log.info("индексация после скрытия записи — готово")
    except Exception as error:  # noqa: BLE001 — фон, ответ уже отдан
        log.error("индексация после скрытия записи не удалась: %s", error)


@router.post("/records/{record_id}/access/link/reset")
async def reset_link(request: Request, record_id: str, slug: str | None = None) -> dict:
    """Новая соль — старые ссылки больше не открывают. Кто уже открыл, остаётся (убрать — `×`)."""
    corpus, rec = _managed(request, record_id, slug)
    if not rec.private:
        raise HTTPException(409, "ссылка нужна только личной записи")
    access.update(Path(rec.file).parent, lambda b: {**b, "link": access.new_salt()})
    corpus.index.build()
    return _state(request, corpus, corpus.index.by_id(record_id))


@router.delete("/records/{record_id}/access/granted/{login}")
async def revoke(request: Request, record_id: str, login: str, slug: str | None = None) -> dict:
    corpus, rec = _managed(request, record_id, slug)
    access.revoke(Path(rec.file).parent, login)
    corpus.index.build()
    return _state(request, corpus, corpus.index.by_id(record_id))


@router.post("/records/{record_id}/access/accept")
async def accept_link(request: Request, record_id: str, payload: Accept,
                      slug: str | None = None) -> dict:
    """Вошедший по ссылке получает доступ к личной записи насовсем (пока хозяин не уберёт).

    ⚠️ Плохой ключ — тот же 404, что и «записи нет»: перебором ключей не узнать, есть ли запись.
    """
    from .site import _corpus  # noqa: PLC0415
    _enabled(request)
    corpus = _corpus(request, slug)
    viewer = viewer_of(request)
    rec = corpus.index.by_id(record_id)
    if rec is None or viewer is None:
        raise HTTPException(404, "нет такой записи")
    if not rec.private or policy(request).can_see(rec, viewer) and \
            policy(request).listed(rec, viewer):
        return {"ok": True, "id": rec.id, "added": False}
    if not viewer.login or not access.check_link(_secret(request), rec.id, rec.link, payload.k):
        raise HTTPException(404, "нет такой записи")
    added = access.grant(Path(rec.file).parent, viewer)
    corpus.index.build()
    log.info("доступ по ссылке: %s ← %s", rec.id, viewer.login)
    return {"ok": True, "id": rec.id, "added": added}

