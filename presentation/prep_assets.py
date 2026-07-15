#!/usr/bin/env python3
"""Prepare image assets for the "Curating Agent Memory" deck.

- Crops the "All Results" reranking panel from screenshots/Live-Context.png.
- Rasterizes screenshots/hooks-lifecycle.svg to PNG (for the pptx; the HTML
  embeds the SVG natively).
All outputs land in presentation/assets/.
"""
import os
from PIL import Image
import cairosvg

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(os.path.dirname(__file__), "assets")
os.makedirs(OUT, exist_ok=True)


def crop_all_results():
    src = os.path.join(REPO, "screenshots", "Live-Context.png")
    im = Image.open(src).convert("RGB")
    # Right-hand "All Results" column (header + Reset/Save + reranked cards)
    box = (1348, 508, 1882, 877)
    crop = im.crop(box)
    dst = os.path.join(OUT, "all-results-crop.png")
    crop.save(dst)
    print("crop:", dst, crop.size)


def rasterize_hooks():
    src = os.path.join(REPO, "screenshots", "hooks-lifecycle.svg")
    dst = os.path.join(OUT, "hooks-lifecycle.png")
    # Native SVG is 520x1228 (tall). Scale up 2.4x for crispness.
    cairosvg.svg2png(url=src, write_to=dst, scale=2.4, background_color="white")
    print("svg->png:", dst, Image.open(dst).size)


if __name__ == "__main__":
    crop_all_results()
    rasterize_hooks()
