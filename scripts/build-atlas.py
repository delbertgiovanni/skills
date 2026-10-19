import gzip
import json
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

FACES = {
    "mono": ("JetBrainsMono-Regular.ttf", 26),
    "monoItalic": ("JetBrainsMono-Italic.ttf", 26),
    "sans": ("Inter-Regular.ttf", 26),
    "sansBold": ("Inter-Bold.ttf", 26),
    "title": ("Inter-Bold.ttf", 30),
    "badge": ("Inter-Bold.ttf", 20),
    "watermark": ("Inter-Bold.ttf", 40),
}

EXTRA = "…•✓✗–—‘’“”→←↑↓‹›€™·▸§°±×÷"
CHARS = [chr(c) for c in range(32, 127)] + [chr(c) for c in range(160, 256)] + list(EXTRA) + ["\ufffd"]


def mask(font, ch):
    x0, y0, x1, y1 = font.getbbox(ch, anchor="ls")
    w, h = max(0, x1 - x0), max(0, y1 - y0)
    if w == 0 or h == 0:
        return x0, y0, 0, 0, b""
    img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(img).text((-x0, -y0), ch, font=font, fill=255, anchor="ls")
    return x0, y0, w, h, img.tobytes()


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "."
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "reporting", "snapshotting-http-requests", "assets", "atlas.bin")
    header = {"scale": 2, "faces": {}}
    blob = bytearray()
    for name, (file, size) in FACES.items():
        font = ImageFont.truetype(os.path.join(src, file), size)
        ascent, descent = font.getmetrics()
        notdef = mask(font, "\ue000")
        glyphs = {}
        for ch in CHARS:
            m = mask(font, ch)
            if ch != " " and m[4] == notdef[4] and m[2:4] == notdef[2:4]:
                continue
            x0, y0, w, h, data = m
            glyphs[str(ord(ch))] = [round(font.getlength(ch), 3), x0, y0, w, h, len(blob)]
            blob += data
        header["faces"][name] = {"size": size, "ascent": ascent, "descent": descent, "glyphs": glyphs}
        print(f"{name}: {len(glyphs)} glyphs")
    head = json.dumps(header, separators=(",", ":")).encode()
    with open(out, "wb") as f:
        f.write(gzip.compress(struct.pack("<I", len(head)) + head + bytes(blob), 9))
    print(f"wrote {os.path.normpath(out)} ({os.path.getsize(out) // 1024} KB)")


if __name__ == "__main__":
    main()
