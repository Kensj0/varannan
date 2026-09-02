#!/usr/bin/env python3
"""Genererar appikonerna i public/ från en enda definition.

Motivet är en rundad bricka delad av en Z-formad söm. Sömmen är
punktsymmetrisk kring mitten, vilket gör de två fälten kongruenta —
exakt hälften var, och det ena är det andra vridet ett halvt varv.
Det är appen i en bild: lika delar, i tur och ordning, och två former
som passar ihop i skarven där överlämningen sker.

Färgerna är appens standardfärger för föräldrarna (tomat och påfågel ur
PARENT_PALETTE i types/schema.ts), så ikonen och schemat hör ihop.

Ritas i 4x och skalas ner, så kanterna blir mjuka utan att bygget
behöver en SVG-rasteriserare.

Körs med:  python3 scripts/generate-icons.py
Utdata checkas in, så CI inte behöver Pillow.
"""

import os
from PIL import Image, ImageDraw

INK = (0x24, 0x20, 0x1F, 255)      # varm nästan-svart
TOMATO = (0xE8, 0x61, 0x5E, 255)   # förälder 1
PEACOCK = (0x6F, 0xB3, 0xE8, 255)  # förälder 2

SS = 4                              # supersampling
N = 1024 * SS
C = N / 2


def render(size: int, tile_frac: float = 0.70) -> Image.Image:
    """tile_frac styr hur stor brickan är av hela ytan.

    Maskable-varianten behöver mindre bricka: Android beskär ikonen till
    en cirkel, och motivet måste rymmas innanför den.
    """
    hi, lo, seam = 0.66, 0.34, 26

    img = Image.new("RGBA", (N, N), INK)
    S = N * tile_frac
    x0, y0 = C - S / 2, C - S / 2
    radius = S * 0.21

    def px(u, v):
        return (x0 + u * S, y0 + v * S)

    tile = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    # Övre fältet: L-form som griper in i det undre.
    td.polygon([px(0, 0), px(1, 0), px(1, lo), px(.5, lo), px(.5, hi), px(0, hi)], fill=TOMATO)
    # Undre fältet: samma form, vriden ett halvt varv.
    td.polygon([px(0, 1), px(1, 1), px(1, lo), px(.5, lo), px(.5, hi), px(0, hi)], fill=PEACOCK)
    # Söm i bakgrundsfärgen så fälten läser skarpt mot varandra.
    td.line([px(0, hi), px(.5, hi), px(.5, lo), px(1, lo)], fill=INK, width=int(seam * SS))

    clip = Image.new("L", (N, N), 0)
    ImageDraw.Draw(clip).rounded_rectangle([x0, y0, x0 + S, y0 + S], radius=radius, fill=255)
    img.paste(tile, (0, 0), clip)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = os.path.join(os.path.dirname(__file__), "..", "public")
    os.makedirs(out, exist_ok=True)

    targets = [
        ("icon-192.png", 192, 0.70),
        ("icon-512.png", 512, 0.70),
        # Mindre bricka: Android beskär maskable-ikoner till en cirkel.
        ("icon-maskable-512.png", 512, 0.52),
        # iOS använder den här för "Lägg till på hemskärmen". Den får
        # inte ha genomskinlighet — iOS lägger annars svart bakom.
        ("apple-touch-icon.png", 180, 0.70),
    ]
    for name, size, frac in targets:
        render(size, frac).convert("RGB").save(os.path.join(out, name))
        print(f"[icons] {name}")

    render(256).convert("RGB").save(
        os.path.join(out, "favicon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("[icons] favicon.ico")


if __name__ == "__main__":
    main()
