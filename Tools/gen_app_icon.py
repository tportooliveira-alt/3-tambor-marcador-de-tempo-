#!/usr/bin/env python3
"""
Gera o ícone do app nas duas plataformas a partir de uma única definição geométrica.

    python3 Tools/gen_app_icon.py

Marca: fundo escuro de arena, a **linha da fotocélula** (feixe vertical vermelho, o elemento central
do produto) e os **três tambores** na disposição em trevo da prova, com o percurso insinuado. Lê bem
em 48 px porque só usa formas cheias e um traço grosso.

Saídas:
  ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png   (o Xcode gera o resto)
  android/app/src/main/res/mipmap-*/ic_launcher.png             (legado, todas as densidades)
  android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml    (adaptativo, API 26+)
  android/app/src/main/res/drawable/ic_launcher_foreground.png  (frente do adaptativo, 432 px)
  android/app/src/main/res/values/ic_launcher_background.xml
"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BG_TOP = (14, 20, 17)        # verde muito escuro (arena à noite)
BG_BOTTOM = (28, 40, 33)
BEAM = (215, 38, 61)         # vermelho do feixe (mesma cor de destaque do app)
BEAM_GLOW = (255, 74, 96, 130)
BARREL = (240, 233, 216)     # areia clara
BARREL_RING = (196, 133, 10) # aro dos tambores
TRACK = (120, 138, 118, 120) # percurso insinuado


def draw_mark(size: int, with_background: bool, inset: float = 0.0) -> Image.Image:
    """
    Desenha a marca num quadrado de `size` px. `inset` encolhe o conteúdo (usado no ícone
    adaptativo do Android, onde o sistema recorta as bordas).
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")
    if with_background:
        for y in range(size):          # degradê vertical
            t = y / max(size - 1, 1)
            c = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
            d.line([(0, y), (size, y)], fill=c + (255,))

    s = size * (1.0 - 2.0 * inset)     # lado útil
    o = size * inset                   # deslocamento
    def px(fx: float, fy: float):      # fração do lado útil -> pixel
        return (o + fx * s, o + fy * s)

    # percurso em trevo (bem discreto, só dá contexto à disposição dos tambores)
    track_w = max(2, int(s * 0.014))
    d.arc([*px(0.36, 0.12), *px(0.90, 0.52)], 195, 25, fill=TRACK, width=track_w)
    d.arc([*px(0.36, 0.48), *px(0.90, 0.88)], 335, 165, fill=TRACK, width=track_w)

    # feixe da fotocélula: linha vertical viva, o "sensor" do app. O halo é um borrão gaussiano do
    # próprio feixe (um retângulo de borda dura pareceria só outra barra).
    beam_w = max(3, int(s * 0.042))
    bx = o + s * 0.255
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow, "RGBA").rectangle(
        [bx - beam_w * 0.9, o + s * 0.03, bx + beam_w * 0.9, o + s * 0.97], fill=BEAM_GLOW)
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(radius=max(1.0, s * 0.045))))
    d.rectangle([bx - beam_w / 2, o + s * 0.03, bx + beam_w / 2, o + s * 0.97], fill=BEAM + (255,))

    # três tambores (trevo: dois à esquerda em cima e embaixo, o terceiro ao fundo)
    r = s * 0.082
    for fx, fy in ((0.63, 0.26), (0.63, 0.74), (0.88, 0.50)):
        cx, cy = px(fx, fy)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BARREL + (255,))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=BARREL_RING + (255,),
                  width=max(2, int(r * 0.30)))
    return img


def save(img: Image.Image, path: str, rgb: bool = False) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    out = img.convert("RGB") if rgb else img
    out.save(path)
    print("  gravado", os.path.relpath(path, ROOT), f"({img.size[0]}x{img.size[1]})")


def main() -> None:
    print("Ícone do app:")
    # iOS: um único 1024x1024 sem alfa (a App Store recusa alfa; o Xcode deriva os tamanhos)
    save(draw_mark(1024, with_background=True),
         os.path.join(ROOT, "ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"), rgb=True)

    # Android adaptativo: frente em 432 px com o conteúdo dentro do círculo seguro (inset 1/6)
    save(draw_mark(432, with_background=False, inset=1.0 / 6.0),
         os.path.join(ROOT, "android/app/src/main/res/drawable/ic_launcher_foreground.png"))
    # Android legado (a partir do minSdk 28 quase não é usado, mas o Play e alguns launchers pedem)
    for folder, px_size in (("mipmap-mdpi", 48), ("mipmap-hdpi", 72), ("mipmap-xhdpi", 96),
                            ("mipmap-xxhdpi", 144), ("mipmap-xxxhdpi", 192)):
        save(draw_mark(px_size, with_background=True),
             os.path.join(ROOT, "android/app/src/main/res", folder, "ic_launcher.png"))

    adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
"""
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        p = os.path.join(ROOT, "android/app/src/main/res/mipmap-anydpi-v26", name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(adaptive)
        print("  gravado", os.path.relpath(p, ROOT))

    colors = """<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- fundo do ícone adaptativo: o mesmo verde escuro de arena do app -->
    <color name="ic_launcher_background">#141B17</color>
</resources>
"""
    p = os.path.join(ROOT, "android/app/src/main/res/values/ic_launcher_background.xml")
    with open(p, "w", encoding="utf-8") as f:
        f.write(colors)
    print("  gravado", os.path.relpath(p, ROOT))


if __name__ == "__main__":
    main()
