"""Готовые ответы на кнопки-пресеты (`app/chat/answer_cache.py` и его ветка в `/api/ask`).

Главное свойство — сброс КЛЮЧОМ: ответ привязан к тому, что видела модель (запись с экраном,
модель, вопрос), и любая правка записи даёт промах без всяких событий. Второе — что кэшируется
только то, что можно отдать любому: пресет ветки, первый вопрос, ответ со ссылками.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from app.chat import answer_cache  # noqa: E402
from app.chat.record_direct import mmss  # noqa: E402
from app.content.transcript import load_utterances  # noqa: E402
from app.main import app  # noqa: E402

CIT = {"type": "citation", "n": 1, "label": "З · 0:05 · А", "url": "/old.mp4", "text": "[0:05] [А] т",
       "rec": "r", "sec": 5, "end": 9, "keywords": [], "found_by": []}


# --- модуль ------------------------------------------------------------------


def test_пресеты_ветки_заменяют_общие_целиком():
    chat = {"presets": {"*": [{"label": "a", "question": "общий?"}],
                        "Ветка": [{"label": "b", "question": "свой?"}]}}
    assert answer_cache.preset_questions(chat, "Ветка") == {"свой?"}
    assert answer_cache.preset_questions(chat, "Другая") == {"общий?"}
    assert answer_cache.preset_questions({}, "Ветка") == set()


def test_ключ_меняется_с_записью_моделью_и_вопросом():
    a = answer_cache.context_hash("запись", "M")
    assert a != answer_cache.context_hash("запись поправлена", "M")
    assert a != answer_cache.context_hash("запись", "M2")
    assert answer_cache.cache_key(a, "q1") != answer_cache.cache_key(a, "q2")
    assert answer_cache.cache_key(a, " q1 ") == answer_cache.cache_key(a, "q1")


def test_сохранить_и_отдать_адрес_видео_свежий(tmp_path):
    assert answer_cache.save(tmp_path, "k", ctx_hash="c", question="q", answer="ответ [1]",
                             citations=[CIT], model="M")
    entry = answer_cache.load(tmp_path, "k")
    assert entry["answer"] == "ответ [1]" and "url" not in entry["citations"][0]
    out = answer_cache.replay(entry, "/new.mp4")
    assert [f["type"] for f in out] == ["status", "citation", "token", "done"]
    assert out[1]["url"] == "/new.mp4" and out[2]["text"] == "ответ [1]"


def test_ответ_без_ссылок_не_сохраняется(tmp_path):
    assert not answer_cache.save(tmp_path, "k", ctx_hash="c", question="q", answer="ответ",
                                 citations=[], model="M")
    assert not (tmp_path / answer_cache.FILE).exists()


def test_устаревшие_ответы_выбрасываются_при_сохранении(tmp_path):
    answer_cache.save(tmp_path, "old", ctx_hash="c1", question="q", answer="a [1]", citations=[CIT], model="M")
    answer_cache.save(tmp_path, "new", ctx_hash="c2", question="q", answer="b [1]", citations=[CIT], model="M")
    assert answer_cache.load(tmp_path, "old") is None
    assert answer_cache.load(tmp_path, "new")


def test_битый_или_чужой_версии_файл_это_промах(tmp_path):
    (tmp_path / answer_cache.FILE).write_text("{не json", encoding="utf-8")
    assert answer_cache.load(tmp_path, "k") is None
    (tmp_path / answer_cache.FILE).write_text(json.dumps({"version": "x", "answers": {"k": {}}}))
    assert answer_cache.load(tmp_path, "k") is None


# --- /api/ask ----------------------------------------------------------------


class _Answerer:
    def __init__(self, pieces):
        self.pieces = pieces
        self.enabled = True
        self.model = "M"
        self.calls = 0

        class _Cfg:
            anon_voices = True
        self.cfg = _Cfg()

    def fits(self, ctx, history_chars=0):
        return True

    async def stream(self, messages):
        self.calls += 1
        for p in self.pieces:
            yield p

    async def aclose(self):
        pass


@pytest.fixture
def site(tmp_path, monkeypatch):
    with TestClient(app) as c:
        slug = next(iter(app.state.corpora))
        corpus = app.state.corpora[slug]
        record = corpus.index.all()[0]
        real = app.state.record_direct
        app.state.journal.path = tmp_path / "journal.jsonl"
        app.state.topic.enabled = False
        # Готовые ответы — во временный каталог: демо-корпус в репозитории не мусорим.
        store = tmp_path / "answers"
        store.mkdir()
        load, save = answer_cache.load, answer_cache.save
        monkeypatch.setattr(answer_cache, "load", lambda d, k: load(store, k))
        monkeypatch.setattr(answer_cache, "save", lambda d, k, **kw: save(store, k, **kw))
        mark = mmss(load_utterances(corpus.index.path_of(record))[0].sec)
        preset = sorted(answer_cache.preset_questions(corpus.chat, record.section))[0]
        try:
            yield c, slug, record, mark, preset, store, tmp_path / "journal.jsonl"
        finally:
            app.state.record_direct = real


def _ask(c, slug, record, question, history=()):
    r = c.post("/api/ask", json={"question": question, "corpus": slug, "history": list(history),
                                 "context": {"record_id": record.id, "scope": "record"},
                                 "want_topic": False})
    return [json.loads(x[6:]) for x in r.text.splitlines() if x.startswith("data: ")]


def _journal(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8").strip().splitlines()]


def test_пресет_считается_один_раз_второй_щелчок_готовый(site):
    c, slug, record, mark, preset, store, journal = site
    llm = _Answerer(["Суть ", f"в начале [{mark}]."])
    app.state.record_direct = llm
    first = _ask(c, slug, record, preset)
    second = _ask(c, slug, record, preset)
    assert llm.calls == 1, "второй щелчок снова пошёл в LLM"
    text = lambda fr: "".join(f["text"] for f in fr if f["type"] == "token")  # noqa: E731
    assert text(first) == text(second) == "Суть в начале [1]."
    cit = next(f for f in second if f["type"] == "citation")
    fresh = next(f for f in first if f["type"] == "citation")
    # Адрес видео строится при выдаче, а не берётся из файла — у готовой цитаты он тот же.
    assert cit["rec"] == record.id and cit["url"] == fresh["url"]
    assert {k: v for k, v in cit.items() if k != "url"} == {k: v for k, v in fresh.items() if k != "url"}
    assert second[-1]["type"] == "done"
    rows = _journal(journal)
    assert [r.get("cached", False) for r in rows] == [False, True]
    assert rows[1]["engine"] == "direct" and rows[1]["citations"]


def test_правка_записи_сбрасывает_готовый_ответ(site, monkeypatch):
    c, slug, record, mark, preset, store, journal = site
    llm = _Answerer([f"ответ [{mark}]"])
    app.state.record_direct = llm
    _ask(c, slug, record, preset)
    # Правка записи меняет контекст модели — то же, что сменить его хэш.
    real = answer_cache.context_hash
    monkeypatch.setattr(answer_cache, "context_hash", lambda s, m: real(s + " правка", m))
    _ask(c, slug, record, preset)
    assert llm.calls == 2


def test_свой_вопрос_и_уточнение_не_кэшируются(site):
    c, slug, record, mark, preset, store, journal = site
    llm = _Answerer([f"ответ [{mark}]"])
    app.state.record_direct = llm
    _ask(c, slug, record, "мой собственный вопрос")
    _ask(c, slug, record, "мой собственный вопрос")
    _ask(c, slug, record, preset, history=[{"role": "user", "content": "x"},
                                          {"role": "assistant", "content": "y"}])
    _ask(c, slug, record, preset, history=[{"role": "user", "content": "x"},
                                          {"role": "assistant", "content": "y"}])
    assert llm.calls == 4
    assert not list(store.iterdir())


def test_ответ_без_ссылок_не_запоминается(site):
    c, slug, record, mark, preset, store, journal = site
    llm = _Answerer(["пересказ без единой ссылки"])
    app.state.record_direct = llm
    _ask(c, slug, record, preset)
    _ask(c, slug, record, preset)
    assert llm.calls == 2
