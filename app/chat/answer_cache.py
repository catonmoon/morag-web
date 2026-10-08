"""Готовые ответы на кнопки-пресеты: считаются при первом щелчке, дальше отдаются мгновенно.

Решение владельца (08.10): прямой путь (`record_direct.py`) отвечает за секунды, поэтому
отдельной стадии «посчитать заранее» (ночью, после приёма записи) не заводим — ответ запоминается
после первого раза и сбрасывается при правке.

**Сброс — ключом, а не событием.** Ключ — хэш всего, что видит модель: текст записи с экраном
(системное сообщение), модель и вопрос. Правка реплики, имя голоса, пересборка с новым словарём
меняют `record.md` → другой контекст → другой ключ → промах и пересчёт. Подписываться на события
правки не нужно, и пропустить правку нельзя: ключ считается из того, что модель увидела бы сейчас.

Кэшируются только пресеты (сервер узнаёт их по тексту вопроса из конфига ветки — клиенту не
доверяем) и только первый вопрос разговора: уточнение зависит от истории. Ответ без единой
ссылки на запись не сохраняется — это брак (модель пересказала по общим знаниям), пусть
следующий щелчок посчитает заново.

Файл — `record.answers.json` в каталоге записи: рядом с записью, уезжает и удаляется вместе с
ней. Записи с прежним контекстом при сохранении выбрасываются — копить устаревшие незачем.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path

from ..engine import frames

log = logging.getLogger(__name__)

FILE = "record.answers.json"
VERSION = "answers-v1"  # формат файла и ключа; смена — все готовые ответы считаются заново


def preset_questions(chat: dict, section: str) -> set[str]:
    """Тексты пресетов ветки — тем же правилом, что у фронта: своя строка заменяет общую."""
    by_branch = (chat or {}).get("presets") or {}
    if not isinstance(by_branch, dict):
        return set()
    items = by_branch.get(section) or by_branch.get("*") or []
    return {str(i.get("question") or "").strip() for i in items if isinstance(i, dict)} - {""}


def context_hash(system: str, model: str) -> str:
    return hashlib.sha256(f"{VERSION}\0{model}\0{system}".encode("utf-8")).hexdigest()[:16]


def cache_key(ctx_hash: str, question: str) -> str:
    return hashlib.sha256(f"{ctx_hash}\0{question.strip()}".encode("utf-8")).hexdigest()[:16]


def _read(record_dir: Path) -> dict:
    try:
        data = json.loads((record_dir / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != VERSION:
        return {}
    answers = data.get("answers")
    return answers if isinstance(answers, dict) else {}


def load(record_dir: Path, key: str) -> dict | None:
    entry = _read(record_dir).get(key)
    if not isinstance(entry, dict) or not entry.get("answer") or not entry.get("citations"):
        return None
    return entry


def save(record_dir: Path, key: str, *, ctx_hash: str, question: str, answer: str,
         citations: list[dict], model: str) -> bool:
    """Запомнить ответ. Без ссылок — не запоминаем (брак). Пишем атомарно: файл читают на лету."""
    if not answer.strip() or not citations:
        return False
    kept = {k: v for k, v in _read(record_dir).items()
            if isinstance(v, dict) and v.get("ctx") == ctx_hash}
    kept[key] = {
        "ctx": ctx_hash,
        "question": question.strip(),
        "answer": answer,
        # Кадры цитат как есть, без адреса видео: его строим при выдаче — `media_base` может
        # смениться, а ответ остаться верным.
        "citations": [{k: v for k, v in c.items() if k != "url"} for c in citations],
        "model": model,
        "at": int(time.time()),
    }
    path = record_dir / FILE
    tmp = path.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps({"version": VERSION, "answers": kept}, ensure_ascii=False,
                                  indent=1) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        log.warning("готовый ответ не сохранён: %s", path, exc_info=True)
        return False
    return True


def replay(entry: dict, media: str) -> list[dict]:
    """Кадры сохранённого ответа: сначала цитаты (как у движка), затем текст, затем конец."""
    out = [frames.status("📚 Готовый ответ", done=True)]
    out += [{**c, "url": media} for c in entry.get("citations") or []]
    out.append(frames.token(entry["answer"]))
    out.append(frames.done())
    return out
