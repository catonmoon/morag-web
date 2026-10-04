"""Инструменты экрана и разметки: контур шлюза описывает файл стека — модели и прокси тоже.

Инструменты писались под шлюз с алиасами `Vision`/`Instruct` и без прокси. Публичный шлюз
(OpenRouter) называет модели своими именами и из иных сетей доступен только через прокси —
прямой запрос отвечает 403 (замерено). Оба знания — свойство контура, их место в файле стека.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
pytest.importorskip("httpx")
import describe_slides as ds  # noqa: E402

CONTOUR = ("ASR_VISION_MODEL", "ASR_TEXT_MODEL", "ASR_LLM_MODEL", "ASR_LLM_BASE_URL", "OR_KEY",
           *ds.PROXY_VARS)


@pytest.fixture
def stack(tmp_path, monkeypatch):
    """Файл стека во временном каталоге; окружение процесса очищено от ключей контура."""
    for var in CONTOUR:
        monkeypatch.delenv(var, raising=False)
    path = tmp_path / "stack.env"
    monkeypatch.setenv("ASR_STACK_ENV", str(path))

    def write(text: str) -> Path:
        path.write_text(text, encoding="utf-8")
        return path
    return write


def test_models_default_to_gateway_aliases(stack):
    stack("ASR_LLM_BASE_URL=https://llm.example.org/api\nOR_KEY=k\n")
    assert ds.vision_model() == "Vision"
    assert ds.text_model() == "Instruct"


def test_models_come_from_stack_file(stack):
    stack('ASR_VISION_MODEL="vendor/vision-small"\nASR_TEXT_MODEL=vendor/text-flash\n')
    assert ds.vision_model() == "vendor/vision-small"
    assert ds.text_model() == "vendor/text-flash"


def test_process_env_beats_stack_file(stack, monkeypatch):
    """Окно загрузки передаёт подпроцессам модель окружением — она главнее файла."""
    stack("ASR_VISION_MODEL=from-file\n")
    monkeypatch.setenv("ASR_VISION_MODEL", "from-env")
    assert ds.vision_model() == "from-env"


def test_shell_proxy_is_dropped_without_stack_proxy(stack, monkeypatch):
    """Контур без прокси (корпоративный шлюз): прокси оболочки снимается, как раньше."""
    stack("ASR_LLM_BASE_URL=https://llm.example.org/api\nOR_KEY=k\n")
    monkeypatch.setenv("HTTPS_PROXY", "http://shell-proxy:3128")
    env = ds.load_env()
    assert env["base_url"] == "https://llm.example.org/api"
    assert all(var not in __import__("os").environ for var in ds.PROXY_VARS)


def test_stack_proxy_replaces_shell_proxy(stack, monkeypatch):
    """Контур с прокси (публичный шлюз из иной сети): ставится прокси из файла, не из оболочки."""
    import os
    stack("ASR_LLM_BASE_URL=https://gateway.example.com/v1\nOR_KEY=k\n"
          "HTTPS_PROXY=http://contour-proxy:3128\nhttps_proxy=http://contour-proxy:3128\n")
    monkeypatch.setenv("HTTPS_PROXY", "http://shell-proxy:3128")
    monkeypatch.setenv("HTTP_PROXY", "http://shell-proxy:3128")
    ds.load_env()
    assert os.environ["HTTPS_PROXY"] == "http://contour-proxy:3128"
    assert os.environ["https_proxy"] == "http://contour-proxy:3128"
    assert "HTTP_PROXY" not in os.environ, "прокси оболочки, не объявленный в файле, не возвращается"


def test_screen_tools_have_no_hardcoded_models():
    """Имя модели — только через `vision_model()`/`text_model()`, иначе публичный шлюз ответит 404."""
    tools = Path(__file__).resolve().parents[1] / "tools"
    for name in ("screen_refs.py", "make_blurb.py", "make_cover.py"):
        src = (tools / name).read_text(encoding="utf-8")
        assert '"Instruct"' not in src and '"Vision"' not in src, name
        assert "MODEL_TEXT" not in src and "MODEL_VISION" not in src, name


def test_classify_prefers_text_model(stack, monkeypatch):
    import classify
    stack("ASR_LLM_BASE_URL=https://gateway.example.com/v1\nOR_KEY=k\n"
          "ASR_LLM_MODEL=vendor/stage-model\nASR_TEXT_MODEL=vendor/text-flash\n")
    assert classify.load_env()["model"] == "vendor/text-flash"
    stack("ASR_LLM_BASE_URL=https://gateway.example.com/v1\nOR_KEY=k\nASR_LLM_MODEL=vendor/stage-model\n")
    assert classify.load_env()["model"] == "vendor/stage-model"


def test_classify_client_gets_stack_proxy(stack):
    """classify строит клиент с `trust_env=False` — прокси из окружения он не видит; прокси
    контура обязан приехать в клиент параметром (ловилось 04.10: 403 от публичного шлюза)."""
    import classify
    stack("ASR_LLM_BASE_URL=https://gateway.example.com/v1\nOR_KEY=k\nASR_LLM_MODEL=m\n"
          "HTTPS_PROXY=http://contour-proxy:3128\n")
    assert classify.load_env()["proxy"] == "http://contour-proxy:3128"
    stack("ASR_LLM_BASE_URL=https://llm.example.org/api\nOR_KEY=k\nASR_LLM_MODEL=m\n")
    assert classify.load_env()["proxy"] is None
    src = (Path(__file__).resolve().parents[1] / "tools" / "classify.py").read_text(encoding="utf-8")
    assert 'proxy=env.get("proxy")' in src
