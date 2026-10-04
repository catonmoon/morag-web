#!/usr/bin/env python3
"""Индекс mp4 (`moov`) — в начало файла: иначе Safari и iOS не начинают воспроизведение.

Монтажные программы часто пишут `moov` ПОСЛЕ данных (`ftyp free mdat moov`). Chrome справляется:
дотягивается Range-запросом до хвоста. Safari/iOS через туннель и CDN не стартуют вовсе (замерено
на лекциях, смонтированных в DaVinci: 9 файлов из 11). Лечение — перепаковка без перекодирования,
`-movflags +faststart`, секунды на гигабайт.

    python3 tools/faststart.py <файл или каталог> [--dry]

⚠️ Берём только первую видео- и первую звуковую дорожку: дорожка таймкода монтажки (`tmcd`)
в mp4 не пишется, и с `-map 0` ffmpeg отказывается собирать файл («Could not find tag for codec
none»). Замена атомарная (временный файл рядом + rename): сервер в это время раздаёт видео.
"""
from __future__ import annotations

import argparse
import shutil
import struct
import subprocess
import sys
from pathlib import Path


def atoms(path: Path, limit: int = 64) -> list[str]:
    """Верхнеуровневые атомы mp4 по порядку. Читаем только заголовки — гигабайты не трогаем."""
    out: list[str] = []
    size = path.stat().st_size
    with path.open("rb") as fh:
        pos = 0
        while pos < size and len(out) < limit:
            fh.seek(pos)
            head = fh.read(16)
            if len(head) < 8:
                break
            n, kind = struct.unpack(">I4s", head[:8])
            if n == 1:
                n = struct.unpack(">Q", head[8:16])[0]
            elif n == 0:
                n = size - pos
            if n < 8:
                break           # битый заголовок — дальше не идём
            out.append(kind.decode("latin1"))
            pos += n
    return out


def needs_faststart(path: Path) -> bool:
    """`moov` после `mdat` — плеер не узнает длительность и раскладку, пока не дочитает хвост."""
    a = atoms(path)
    return "moov" in a and "mdat" in a and a.index("moov") > a.index("mdat")


def faststart(path: Path) -> bool:
    """Перепаковать на месте. True — перепаковано; False — не нужно. Ошибка ffmpeg — исключение."""
    if path.suffix.lower() not in {".mp4", ".m4v", ".mov"} or not needs_faststart(path):
        return False
    if not shutil.which("ffmpeg"):
        raise RuntimeError("нет ffmpeg — moov в конце файла, Safari/iOS видео не запустят")
    tmp = path.with_name(f".faststart-{path.name}")
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0?",
           "-c", "copy", "-movflags", "+faststart", str(tmp)]
    try:
        subprocess.run(cmd, check=True)
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", type=Path)
    ap.add_argument("--dry", action="store_true", help="только показать, что перепаковать")
    a = ap.parse_args()
    files = sorted(a.target.glob("*.mp4")) if a.target.is_dir() else [a.target]
    bad = 0
    for f in files:
        if not needs_faststart(f):
            print(f"ok     {f.name}")
            continue
        if a.dry:
            print(f"нужно  {f.name}")
            continue
        try:
            faststart(f)
            print(f"готово {f.name}")
        except (RuntimeError, subprocess.CalledProcessError) as e:
            bad += 1
            print(f"СБОЙ   {f.name}: {e}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
