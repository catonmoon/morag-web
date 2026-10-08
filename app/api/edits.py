"""Правка реплики с сайта и повышение правки до правила корпуса.

Рубежи те же три, что у правки имён, и берём мы их оттуда же (`voices._guard`), а не заводим
свои: выключенный флаг (умолчание), отказ СЕРВЕРА, кто правит (роль при включённой
авторизации, петлевой адрес без неё). Дублировать эту проверку значило бы однажды поправить
её в одном месте из двух. Реплика — право `edit` (любой вошедший), «починить везде» — правило
на весь корпус, право `voices` (admin).

Смотреть, где ещё встречается написание, можно всегда: это чтение корпуса, который и так открыт.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import config
from ..content import attachments
from ..content import fields as record_fields
from ..content import upload as core
from ..content.edits import Refused, Stale
from .voices import _guard, _record_dirs

router = APIRouter(prefix="/api", tags=["edits"])
log = logging.getLogger(__name__)


class TurnEdit(BaseModel):
    # Номер АБЗАЦА в `record.words.json` — ровно то, что видит читалка. Перевод в координаты
    # сырца делает сервер: клиент про реплики сырца ничего не знает и знать не должен.
    turn: int
    was: str = Field(max_length=20000)
    now: str = Field(max_length=20000)


class Batch(BaseModel):
    # Правки копятся в памяти читалки и уезжают ОДНОЙ пачкой по выходу из режима: иначе запись
    # пересобиралась бы после каждого слова.
    edits: list[TurnEdit] = Field(default_factory=list, max_length=200)


class Fields(BaseModel):
    """Поля шапки, которые правят с сайта. Все необязательные: пришло — меняем, нет — не трогаем.

    ⚠️ `None` и `""` значат РАЗНОЕ: пустая строка — «стереть поле», отсутствие ключа — «не
    трогать». Иначе форма, отправленная целиком, затирала бы то, чего человек не касался.
    """
    title: str | None = Field(default=None, max_length=300)
    date: str | None = Field(default=None, max_length=10)
    event: str | None = Field(default=None, max_length=200)
    summary: str | None = Field(default=None, max_length=4000)
    tags: list[str] | None = Field(default=None, max_length=40)
    category: str | None = Field(default=None, max_length=120)
    topics: list[str] | None = Field(default=None, max_length=40)
    speakers: list[str] | None = Field(default=None, max_length=40)
    participants: list[str] | None = Field(default=None, max_length=60)
    # Ссылка на обсуждение записи (тред в мессенджере). Рука человека побеждает ссылку из поста.
    discussion: str | None = Field(default=None, max_length=1000)


class Promote(BaseModel):
    was: str = Field(max_length=120)
    now: str = Field(max_length=120)
    record: str = Field(default="", max_length=200)


def _store(request: Request):
    store = getattr(request.app.state, "edits", None)
    if store is None:
        raise HTTPException(503, "корпус не настроен")
    return store


def _dir(request: Request, record_id: str):
    dirs = _record_dirs(request, [record_id])
    if record_id not in dirs:
        raise HTTPException(404, f"записи {record_id} нет")
    return dirs[record_id]


@router.get("/tokens/{word}")
async def tokens(request: Request, word: str) -> dict:
    """Где ещё встречается написание и какие рядом варианты.

    ⚠️ Варианты — не украшение. Гарбл никогда не бывает один: замерено на живом корпусе —
    у одного термина шесть написаний, у другого двенадцать, у фамилии докладчика десять.
    """
    store = getattr(request.app.state, "tokens", None)
    if store is None:
        raise HTTPException(503, "корпус не настроен")
    return {**store.where(word), "variants": store.variants(word)}


@router.post("/records/{record_id}/edits")
async def save(request: Request, record_id: str, payload: Batch) -> dict:
    """Принять пачку правок абзацев и поставить запись в пересборку."""
    _guard(request)
    record_dir = _dir(request, record_id)
    why = request.app.state.auth.why_line(request)
    try:
        result = _store(request).save(record_dir, [e.model_dump() for e in payload.edits], why=why)
    except Stale as error:
        raise HTTPException(409, str(error))
    except Refused as error:
        raise HTTPException(400, str(error))

    queued = request.app.state.rebuilder.enqueue({record_id: record_dir}) if result["saved"] else []
    log.info("правок реплик в %s: %d", record_id, len(result["saved"]))
    return {**result, "queued": queued, "queue": request.app.state.rebuilder.status()}


@router.post("/records/{record_id}/fields")
async def fields(request: Request, record_id: str, payload: Fields) -> dict:
    """Правка полей шапки: название, дата, рубрика, категория, темы, метки, люди, аннотация.

    Право то же, что у правки реплики (`edit`, любой вошедший — решение владельца 25.09): подпись
    правки несёт логин, видно, кто что менял.
    ⚠️ Если новые рубрика/метки/дата зовут запись в другую ветку или год, каталог ПЕРЕЕЗЖАЕТ, и в
    пересборку ставится уже новый путь. Иначе шапка разойдётся с раскладкой на диске, а путь
    входит в doc_id движка. Адрес страницы при этом не меняется — он по id записи.
    """
    _guard(request)
    record_dir = _dir(request, record_id)
    family = config.family_dir(request.app.state.cfg)
    try:
        result = record_fields.save(record_dir, payload.model_dump(exclude_unset=True),
                                    why=request.app.state.auth.why_line(request), family=family,
                                    events=core.events_of(family),
                                    link_hosts=request.app.state.cfg.editing.discussion_hosts)
        moved = record_fields.move(record_dir, result["move"]) if result["move"] else None
    except record_fields.Refused as error:
        raise HTTPException(400, str(error))
    where = moved or record_dir
    for corpus in request.app.state.corpora.values():
        corpus.index.refresh_if_stale()
    queued = request.app.state.rebuilder.enqueue({record_id: where})
    log.info("поля записи %s: %s%s", record_id, ", ".join(result["changed"]),
             f", переехала в {where}" if moved else "")
    return {"changed": result["changed"], "moved": str(where) if moved else "",
            "queued": queued, "queue": request.app.state.rebuilder.status()}


@router.get("/records/{record_id}/rubrics")
async def rubrics(request: Request, record_id: str) -> dict:
    """Рубрики для выбора в форме правки — по веткам, с адресом переезда этой записи."""
    _guard(request)
    record_dir = _dir(request, record_id)
    try:
        return record_fields.rubrics(record_dir, config.family_dir(request.app.state.cfg))
    except record_fields.Refused as error:
        raise HTTPException(400, str(error))


@router.delete("/records/{record_id}/edits")
async def drop(request: Request, record_id: str) -> dict:
    """Снять все правки записи. Обратимость — операция, а не обещание."""
    _guard(request)
    record_dir = _dir(request, record_id)
    gone = _store(request).drop(record_id)
    queued = request.app.state.rebuilder.enqueue({record_id: record_dir}) if gone else []
    return {"record": record_id, "dropped": gone, "queued": queued,
            "queue": request.app.state.rebuilder.status()}


@router.post("/fixes")
async def promote(request: Request, payload: Promote) -> dict:
    """«Починить везде»: правка становится правилом корпуса.

    Список записей отдаём вместе с ответом — человек должен видеть масштаб того, что запустил.
    """
    _guard(request, "voices")
    store = _store(request)
    why = request.app.state.auth.why_line(request)
    try:
        result = store.promote(payload.record.strip(), payload.was, payload.now, why=why)
    except Refused as error:
        raise HTTPException(400, str(error))

    touched = [r["id"] for r in request.app.state.tokens.where(payload.was.strip())["records"]]
    if payload.record.strip() and payload.record.strip() not in touched:
        touched.append(payload.record.strip())  # там написание уже поправлено поместно
    dirs = _record_dirs(request, touched)
    queued = request.app.state.rebuilder.enqueue(dirs)
    log.info("правило «%s» → «%s», записей %d", payload.was, payload.now, len(touched))
    return {**result, "records": touched, "queued": queued,
            "queue": request.app.state.rebuilder.status()}


MB = 1024 ** 2


@router.put("/records/{record_id}/files/{name}")
async def attach(request: Request, record_id: str, name: str) -> dict:
    """Приложить материал: тело запроса — сам файл, имя — в адресе (как у загрузки записи:
    потоком на диск, без multipart). Право `edit` — материал касается одной записи, как правка
    реплики. Запись НЕ пересобирается: список живёт в мете, а мета в шапку не идёт."""
    _guard(request)
    record_dir = _dir(request, record_id)
    cfg = request.app.state.cfg.editing
    try:
        attachments.safe_name(name, cfg.attachments_ext)
    except attachments.Refused as error:
        raise HTTPException(error.status, str(error))
    limit = int(cfg.attachments_max_mb * MB)
    if int(request.headers.get("content-length") or 0) > limit:
        raise HTTPException(413, f"файл больше {cfg.attachments_max_mb:g} МБ")
    part = record_dir / f".attach-{uuid.uuid4().hex}.part"
    written = 0
    try:
        with part.open("wb") as out:
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise HTTPException(413, f"файл больше {cfg.attachments_max_mb:g} МБ")
                out.write(chunk)
        if not written:
            raise HTTPException(400, "файл пустой")
        user = request.app.state.auth.user_of(request)
        item = attachments.add(record_dir, name, part, allowed=cfg.attachments_ext,
                               by=f"{user.name} ({user.login})" if user else "")
    except attachments.Refused as error:
        raise HTTPException(error.status, str(error))
    finally:
        part.unlink(missing_ok=True)
    log.info("материал записи %s: %s, %d байт", record_id, item["file"], written)
    return {"file": item, "files": attachments.items(record_dir, cfg.attachments_ext)}


@router.delete("/records/{record_id}/files/{name:path}")
async def detach(request: Request, record_id: str, name: str) -> dict:
    """Убрать материал: пометка в списке, файл остаётся на диске (почему — `attachments`)."""
    _guard(request)
    record_dir = _dir(request, record_id)
    cfg = request.app.state.cfg.editing
    try:
        hit = attachments.remove(record_dir, name,
                                 by=request.app.state.auth.why_line(request, "убрано"))
    except attachments.Refused as error:
        raise HTTPException(error.status, str(error))
    if not hit:
        raise HTTPException(404, "нет такого материала")
    log.info("материал записи %s убран: %s", record_id, name)
    return {"files": attachments.items(record_dir, cfg.attachments_ext)}
