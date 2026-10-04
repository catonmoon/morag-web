"""faststart: индекс mp4 (moov) в начало — иначе Safari/iOS не запускают видео.

Монтажки пишут moov после данных; на живом корпусе так было у 9 файлов из 11. Тест собирает
синтетический mp4 ffmpeg'ом (без ffmpeg — пропуск): с moov в конце и с дорожкой таймкода, как у
монтажки, — именно она роняла перепаковку с `-map 0`.
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import faststart  # noqa: E402

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="нет ffmpeg")


def _clip(path: Path, *extra: str) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=10:duration=1",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac",
                    *extra, str(path)], check=True)
    return path


def test_moov_at_end_is_moved_to_start(tmp_path):
    clip = _clip(tmp_path / "x.mp4")          # без +faststart ffmpeg пишет moov в конец
    assert faststart.needs_faststart(clip), faststart.atoms(clip)
    assert faststart.faststart(clip) is True
    a = faststart.atoms(clip)
    assert a.index("moov") < a.index("mdat"), a
    assert not list(tmp_path.glob(".faststart-*")), "временный файл обязан исчезнуть"


def test_already_fast_file_is_left_alone(tmp_path):
    clip = _clip(tmp_path / "y.mp4", "-movflags", "+faststart")
    before = clip.stat().st_mtime_ns
    assert faststart.faststart(clip) is False
    assert clip.stat().st_mtime_ns == before


def test_timecode_track_does_not_break_repack(tmp_path):
    """Дорожка таймкода (как у монтажки) — в mp4 не пишется; берём только видео и звук."""
    clip = _clip(tmp_path / "z.mp4", "-timecode", "00:00:00:00", "-write_tmcd", "1")
    assert faststart.faststart(clip) is True
    a = faststart.atoms(clip)
    assert a.index("moov") < a.index("mdat")
