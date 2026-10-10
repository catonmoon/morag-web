"""Журнал событий просмотра: что открывают, что смотрят, где бросают.

Сырые события, без агрегатов: дашборд считает прямо по таблице (~1.3 млн строк в год, ~100 МБ —
SQLite это не замечает). Ручка `/api/events` кладёт пачку в очередь памяти и отвечает сразу, а
фоновый поток пишет на диск раз в несколько секунд одной транзакцией — посетитель диска не ждёт.

⚠️ Это сведения о людях. Зритель подписан не логином, а HMAC логина ключом сайта (решение
владельца 10.10): уникальные зрители и связь между днями видны, а «кто именно смотрел» из
базы не прочитать. Отдел — открытым текстом, для срезов. По умолчанию журнал выключен.
"""

from __future__ import annotations

import logging
import queue
import sqlite3
import threading
from pathlib import Path

log = logging.getLogger(__name__)

COLUMNS = ("ts", "kind", "slug", "record", "pos", "val", "path", "who", "dept")

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    ts REAL NOT NULL, kind TEXT NOT NULL, slug TEXT, record TEXT,
    pos REAL, val REAL, path TEXT, who TEXT, dept TEXT
);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS events_record ON events(record);
"""


class EventLog:
    def __init__(self, path: Path, *, enabled: bool = False, flush_seconds: float = 3.0) -> None:
        self.path = Path(path)
        self.enabled = enabled
        self.flush_seconds = flush_seconds
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        if self.enabled:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as db:
                db.executescript(SCHEMA)
            self._thread = threading.Thread(target=self._run, name="events-writer", daemon=True)
            self._thread.start()

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10)
        # WAL: дашборд читает, пока сайт пишет, и никто никого не ждёт.
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        return db

    def put(self, rows: list[dict]) -> None:
        """Пачка событий в очередь. Не блокирует и не бросает."""
        if self.enabled:
            for row in rows:
                self._queue.put(tuple(row.get(c) for c in COLUMNS))

    def _drain(self) -> list[tuple]:
        out = []
        while True:
            try:
                out.append(self._queue.get_nowait())
            except queue.Empty:
                return out

    def _write(self, rows: list[tuple]) -> None:
        if not rows:
            return
        try:
            with self._connect() as db:
                db.executemany(f"INSERT INTO events ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
                               rows)
        except Exception:  # журнал не должен ронять сайт: потеря пачки дешевле пятисотки
            log.exception("не смог записать %d событий", len(rows))

    def _run(self) -> None:
        while not self._stop.wait(self.flush_seconds):
            self._write(self._drain())
        self._write(self._drain())

    def flush(self) -> None:
        """Дописать накопленное сейчас (тесты, остановка)."""
        self._write(self._drain())

    def close(self) -> None:
        """Остановить писателя, дописав хвост: рестарт службы не должен терять последние секунды."""
        if self._thread is not None:
            self._stop.set()
            self._thread.join(timeout=10)
            self._thread = None
