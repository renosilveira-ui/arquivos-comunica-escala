#!/usr/bin/env python3
"""
Gera os assets de marca do Escala+ (ícones de app, favicon e logo) a partir
das peças oficiais em assets/brand/source/ — aprovadas pelo PO em 2026-08-18.

    app-icon-light.png  calendário navy contornado com E+ sobre branco → ÍCONE DO APP
    app-icon-navy.png   tile navy com grade e E+ branco                → favicon e ícone iOS "dark"
    wordmark.png        ESCALA+ sobre grade de calendário (fundo branco) → logo (login, splash)

Saídas (assets/images/):
    icon.png                    iOS light, 1024², opaco (exigência da App Store)
    icon-dark.png               iOS dark (iOS 18+), full-bleed navy — a máscara de cantos é do sistema
    icon-tinted.png             iOS tinted (iOS 18+), escala de cinza: glifo branco sobre PRETO opaco
                                (o Expo preenche transparência com branco — preto é o "fundo do sistema")
    android-icon-foreground.png camada adaptativa: glifo na zona segura (≤ 66 % do canvas)
    android-icon-background.png camada adaptativa: branco sólido
    android-icon-monochrome.png Android 13+ (ícone temático): silhueta branca sobre transparente
    favicon.png                 256², tile navy com cantos arredondados transparentes
    logo.png                    wordmark com fundo transparente (tinta navy + alpha)

Uso:  python3 scripts/brand/generate-icons.py      (requer Pillow + numpy)
O fundo "quase branco" das peças (JPEG/IA) é normalizado para branco puro, e a
arte é extraída como tinta + alpha para funcionar sobre gradientes (login).
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets" / "brand" / "source"
OUT = ROOT / "assets" / "images"

NAVY_ICON = np.array([0, 31, 59], np.uint8)  # navy medido no ícone claro
NAVY_WORD = np.array([0, 17, 43], np.uint8)  # navy medido no wordmark
WHITE = np.array([255, 255, 255], np.uint8)


def load(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    a[a >= 248] = 255.0  # fundo quase-branco → branco puro
    return a


def darkness(rgb: np.ndarray) -> np.ndarray:
    """0 = branco … 1 = preto (luminância invertida)."""
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    return np.clip((255.0 - lum) / 255.0, 0, 1)


def ink_darkness(ink: np.ndarray) -> float:
    return float(darkness(ink[None, None, :].astype(np.float32))[0, 0])


def bbox(mask: np.ndarray, thr: float):
    ys, xs = np.where(mask > thr)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def ink_rgba(rgb: np.ndarray, color: np.ndarray, ink: np.ndarray, ramp=None) -> Image.Image:
    """Arte pintada com `color` + alpha proporcional à escuridão, normalizada pela
    tinta `ink` da peça (branco → transparente). `ramp=(lo, hi)` descarta a grade
    fraca e mantém o antialias das bordas."""
    d = darkness(rgb) / ink_darkness(ink)
    if ramp:
        lo, hi = ramp
        d = (d - lo) / (hi - lo)
    a = np.clip(d, 0, 1)
    out = np.zeros((*a.shape, 4), np.uint8)
    out[..., :3] = color
    out[..., 3] = np.round(a * 255).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def fit_center(img: Image.Image, canvas: int, frac: float, bg=(0, 0, 0, 0)) -> Image.Image:
    """Centraliza `img` num canvas quadrado com a maior dimensão = frac × canvas."""
    s = frac * canvas / max(img.size)
    im = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
    base = Image.new("RGBA", (canvas, canvas), bg)
    base.alpha_composite(im, ((canvas - im.width) // 2, (canvas - im.height) // 2))
    return base


def save(img: Image.Image, name: str) -> None:
    img.save(OUT / name, optimize=True)
    print(f"  {name:30s} {img.size[0]}×{img.size[1]} {img.mode}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("assets/images/")

    # ---- ícone claro (app icon) ----
    light = load(SRC / "app-icon-light.png")
    x0, y0, x1, y1 = bbox(darkness(light), 0.04)
    art = light[y0:y1, x0:x1]
    glyph = ink_rgba(art, NAVY_ICON, NAVY_ICON)
    silhouette = ink_rgba(art, WHITE, NAVY_ICON, ramp=(0.35, 0.75))

    save(fit_center(glyph, 1024, 0.64, bg=(255, 255, 255, 255)).convert("RGB"), "icon.png")
    save(fit_center(silhouette, 1024, 0.64, bg=(0, 0, 0, 255)).convert("RGB"), "icon-tinted.png")
    save(fit_center(glyph, 1024, 0.52), "android-icon-foreground.png")
    save(Image.new("RGB", (1024, 1024), (255, 255, 255)), "android-icon-background.png")
    save(fit_center(silhouette, 1024, 0.52), "android-icon-monochrome.png")

    # ---- tile navy (favicon + iOS dark) ----
    navy = load(SRC / "app-icon-navy.png")
    nx0, ny0, nx1, ny1 = bbox(darkness(navy), 0.3)
    tile = navy[ny0:ny1, nx0:nx1]
    th, tw = tile.shape[:2]
    radius = int(np.argmax(darkness(tile[2:3])[0] > 0.3))  # 1º pixel escuro na linha do topo
    tile_img = Image.fromarray(tile.astype(np.uint8)).convert("RGBA")
    scale = 4
    mask = Image.new("L", (tw * scale, th * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, tw * scale - 1, th * scale - 1), radius=radius * scale, fill=255)
    tile_img.putalpha(mask.resize((tw, th), Image.LANCZOS))
    save(tile_img.resize((256, 256), Image.LANCZOS), "favicon.png")

    inset = int(0.09 * tw)  # remove os cantos arredondados: o iOS aplica a própria máscara
    dark = Image.fromarray(tile[inset : th - inset, inset : tw - inset].astype(np.uint8))
    save(dark.resize((1024, 1024), Image.LANCZOS), "icon-dark.png")

    # ---- wordmark (logo) ----
    word = load(SRC / "wordmark.png")
    wx0, wy0, wx1, wy1 = bbox(darkness(word), 0.02)
    pad = 24
    wx0, wy0 = max(wx0 - pad, 0), max(wy0 - pad, 0)
    wx1, wy1 = min(wx1 + pad, word.shape[1]), min(wy1 + pad, word.shape[0])
    save(ink_rgba(word[wy0:wy1, wx0:wx1], NAVY_WORD, NAVY_WORD), "logo.png")


if __name__ == "__main__":
    main()
