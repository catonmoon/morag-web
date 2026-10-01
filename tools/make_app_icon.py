#!/usr/bin/env python3
"""Значок окна загрузки — ASCII-котик в луне из шапки консоли morag, картинкой 1024×1024.

    python3 tools/make_app_icon.py [--from <morag>/services/console/static/index.html] [-o tools/ui/app-icon.png]

Рисунок не перепечатан руками, а взят из консоли морага как есть (заголовок `<h1>`): знак у
платформы один, и копия, набранная заново, разошлась бы с оригиналом молча. Рисуем средствами
macOS (Cocoa через PyObjC — он уже стоит в окружении окна), чтобы не тянуть Pillow ради одной
картинки. Результат лежит в git (`tools/ui/app-icon.png`), установщик делает из него `.icns`.

⚠️ Берём только ЛУНУ С КОТОМ — левые колонки шапки; справа там слово консоли, в значке 128×128
оно превратилось бы в рябь.
"""

from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SRC = HERE.parent.parent / "morag" / "services" / "console" / "static" / "index.html"
SIZE = 1024
BG = (0x0F, 0x17, 0x2A)        # тёмная тема консоли (--bg)
INK = (0xF8, 0xFA, 0xFC)       # цвет шапки консоли


def cat_lines(src: Path) -> list[str]:
    """Строки рисунка: заголовок консоли, обрезанный по правому краю луны."""
    page = src.read_text(encoding="utf-8")
    m = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    if not m:
        raise SystemExit(f"в {src} нет заголовка с рисунком")
    rows = html.unescape(m.group(1)).split("\n")
    # Правый край луны — последний знак рамки в каждой строке рисунка (█ ▄ ▀).
    cut = []
    for row in rows:
        ends = [i for i, ch in enumerate(row) if ch in "█▄▀"]
        if not ends:
            continue
        cut.append(row[: ends[-1] + 1].rstrip())
    pad = min(len(r) - len(r.lstrip()) for r in cut)
    return [r[pad:] for r in cut]


def render(lines: list[str], out: Path) -> None:
    from AppKit import (NSBezierPath, NSBitmapImageRep, NSColor, NSFont, NSFontAttributeName,
                        NSForegroundColorAttributeName, NSGraphicsContext, NSPNGFileType,
                        NSParagraphStyleAttributeName, NSMutableParagraphStyle, NSShadow,
                        NSShadowAttributeName, NSCalibratedRGBColorSpace)
    from Foundation import NSAttributedString, NSMakeRect, NSMakeSize

    rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, SIZE, SIZE, 8, 4, True, False, NSCalibratedRGBColorSpace, 0, 0)
    ctx = NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.setCurrentContext_(ctx)

    rgb = lambda c, a=1.0: NSColor.colorWithCalibratedRed_green_blue_alpha_(c[0] / 255, c[1] / 255, c[2] / 255, a)
    # Плитка значка по сетке macOS: поле 100 px, скругление ~22 %.
    inset = 100
    tile = NSMakeRect(inset, inset, SIZE - 2 * inset, SIZE - 2 * inset)
    rgb(BG).setFill()
    NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(tile, 185, 185).fill()

    width = max(len(r) for r in lines)
    box = SIZE - 2 * inset - 120
    font_size = box / (width * 0.602)          # ширина знака Menlo ≈ 0.602 кегля
    font = NSFont.fontWithName_size_("Menlo", font_size) or NSFont.monospacedSystemFontOfSize_weight_(font_size, 0)
    # Шаг строки = высота блока █ в Menlo — около 1.04 кегля (замер по картинке, а не ascent +
    # descent = 1.164: при таком шаге стенки луны шли пунктиром). Чуть меньше — блоки смыкаются.
    line_h = font_size * 1.03
    para = NSMutableParagraphStyle.alloc().init()
    para.setMinimumLineHeight_(line_h)
    para.setMaximumLineHeight_(line_h)
    glow = NSShadow.alloc().init()
    glow.setShadowBlurRadius_(font_size * 0.35)
    glow.setShadowColor_(rgb(INK, 0.45))
    glow.setShadowOffset_(NSMakeSize(0, 0))
    attrs = {NSFontAttributeName: font, NSForegroundColorAttributeName: rgb(INK),
             NSParagraphStyleAttributeName: para, NSShadowAttributeName: glow}
    text = NSAttributedString.alloc().initWithString_attributes_("\n".join(r.ljust(width) for r in lines), attrs)
    size = text.size()
    x = (SIZE - size.width) / 2
    y = (SIZE - size.height) / 2
    text.drawInRect_(NSMakeRect(x, y, size.width + 2, size.height + 2))

    NSGraphicsContext.restoreGraphicsState()
    out.parent.mkdir(parents=True, exist_ok=True)
    rep.representationUsingType_properties_(NSPNGFileType, {}).writeToFile_atomically_(str(out), True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("-o", "--out", type=Path, default=HERE / "ui" / "app-icon.png")
    args = ap.parse_args()
    lines = cat_lines(args.src)
    print("\n".join(lines))
    render(lines, args.out)
    print(f"значок: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
