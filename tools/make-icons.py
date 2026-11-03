"""Renders the Feedback Lens icon (lens + annotation dot) at the sizes Chrome needs.

python3 tools/make-icons.py                  → extension/icons/icon{16,32,48,128}.png
python3 tools/make-icons.py 512 out.png      → one large icon (store graphics)
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 1024  # supersampled canvas, downscaled for anti-aliasing

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=(79, 70, 229, 255))

# lens ring
cx, cy, r, w = 440, 430, 230, 78
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=w)
# handle
d.line([(cx + 170, cy + 170), (cx + 390, cy + 390)], fill=(255, 255, 255, 255), width=118)
d.ellipse([cx + 390 - 59, cy + 390 - 59, cx + 390 + 59, cy + 390 + 59], fill=(255, 255, 255, 255))
# annotation dot inside the lens
d.ellipse([cx - 92, cy - 92, cx + 92, cy + 92], fill=(251, 146, 60, 255))

if len(sys.argv) == 3:
    img.resize((int(sys.argv[1]),) * 2, Image.LANCZOS).save(sys.argv[2])
    sys.exit()

OUT.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
# Chrome Web Store guideline: 96x96 artwork with 16 px transparent padding in the 128x128 icon.
padded = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
padded.paste(img.resize((96, 96), Image.LANCZOS), (16, 16))
padded.save(OUT / "icon128.png")
print("icons written to", OUT)
