#!/usr/bin/env python3
"""Build the multi-size Windows icon from the macOS app icon's 1024 master.

Usage: python3 tools/make_windows_icon.py
Writes coral-go/cmd/coral-tray/icon.ico and assets/icons/coral.ico. The master is the 1024 image
inside Coral.icns (the icon build-macos.sh ships: Apple's template, a white rounded tile with the
navy coral, 824 px inside the 1024 canvas), so the Windows icon is the Mac icon: same shape and
padding. Every size is resized from that master, never from another size. Sizes up to 128 are
stored as 32-bit BMP/DIB entries (what the notification-area loader and old shells expect);
256 is a PNG entry. (The macOS menu-bar glyph is white and is not used on Windows.)
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Coral.icns"
OUTS = [ROOT / "coral-go/cmd/coral-tray/icon.ico", ROOT / "assets/icons/coral.ico"]
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
# Up to 32 px the Mac padding (100 px each side of the 1024 canvas) costs a fifth of the icon, so these sizes are
# resized from the master cropped to the tile's edge (the same tile, same shape) and lightly sharpened, which keeps the
# ring and the coral's gaps apart; 40 px and up keep the Mac padding.
TILE = (100, 100, 924, 924)
SMALL = 32


def master():
    """The 1024 px image of Coral.icns (the 512 px @2x entry): the tile as the Mac shows it."""
    im = Image.open(SRC)
    best = max(im.info["sizes"], key=lambda t: t[0] * t[2])
    im.size = best
    im = im.convert("RGBA")
    assert im.size == (1024, 1024), im.size
    return im


def dib(im):
    w, h = im.size
    px = im.load()
    rows = []
    for y in range(h - 1, -1, -1):  # bottom-up BGRA
        rows.append(b"".join(struct.pack("<BBBB", px[x, y][2], px[x, y][1], px[x, y][0], px[x, y][3]) for x in range(w)))
    mask_stride = ((w + 31) // 32) * 4
    mask = b"\x00" * (mask_stride * h)  # alpha channel carries transparency
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, w * h * 4, 0, 0, 0, 0)
    return header + b"".join(rows) + mask


def main():
    art = master()
    entries = []
    for s in SIZES:
        if s <= SMALL:
            im = art.crop(TILE).resize((s, s), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=0))
        else:
            im = art.resize((s, s), Image.LANCZOS)
        if s >= 256:
            buf = io.BytesIO()
            im.save(buf, "PNG", optimize=True)
            entries.append((s, buf.getvalue()))
        else:
            entries.append((s, dib(im)))
    head = struct.pack("<HHH", 0, 1, len(entries))
    off = 6 + 16 * len(entries)
    table, blobs = b"", b""
    for s, data in entries:
        table += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), off + len(blobs))
        blobs += data
    ico = head + table + blobs
    for out in OUTS:
        out.write_bytes(ico)
        print(f"wrote {out.relative_to(ROOT)} ({len(ico)} bytes)")


if __name__ == "__main__":
    main()
