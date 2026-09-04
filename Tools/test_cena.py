#!/usr/bin/env python3
"""
Confere que a física em numpy e o simulador dos vetores concordam.

    python3 Tools/test_cena.py

Por que isto existe: a física realista (rolling shutter, flicker, exposição integrada, curva de tom)
já estava provada em `Scene` (gen_test_vectors.py), que é laço por pixel em Python e produz só uma
faixa de 15x96 px — nunca um vídeo. Para virar vídeo ela foi portada para numpy. Duas implementações
da mesma física divergem com o tempo, e uma cena de arena realista E ERRADA é pior que uma cena
simples e certa: ela produziria números convincentes e falsos.

O teste roda as duas com os MESMOS parâmetros num caso de bordo único e exige que os quadros batam,
com tolerância de 1 nível de luma (o arredondamento) — não folga de modelo.

LIMITE CONHECIDO, e não é pequeno: `quadros_numpy` abaixo é uma TERCEIRA cópia da física, escrita
aqui dentro, e não o `_render_arena` de `gen_test_video.py` que realmente produz os vídeos. O que
este teste prova é que a formulação vetorizada bate com a `Scene`; ele NÃO pega uma divergência que
apareça só no gerador de verdade. Para fechar isso, `_render_arena` precisa expor os quadros (hoje
ele só escreve direto no ffmpeg) e este teste passar a consumi-los — está anotado em CLAUDE.md.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import gen_test_vectors as G
from photocell_reference import RoiRect

NS = 1_000_000_000


class Args:
    """Os argumentos que `_render_arena` lê, montados à mão."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def quadros_numpy(*, W, H, fps, expo_ns, speed, L, tc_ns, direcao, bg, obj, gamma, skew_ns, flicker, n, linha_a, linha_b, xc):
    """Roda o caminho de arena com ruído zero e captura os quadros direto, sem passar pelo ffmpeg."""
    periodo = NS // fps
    v = speed / NS
    ys = np.arange(H).reshape(H, 1)
    xs = np.arange(W).reshape(1, W)
    base0 = (bg + (xs * 7 + ys * 3) % 11).astype(np.float64)
    psf = math.sqrt(0.0 + 1.0)
    xk_off = (np.arange(5) - 2) * psf / 4.0
    peso = np.array([0.5, 1.0, 1.0, 1.0, 0.5])
    xx = np.arange(W).reshape(1, W, 1) + xk_off.reshape(1, 1, 5)
    t_linha = (np.arange(H).reshape(H, 1) * skew_ns / max(1, H)).astype(np.float64)
    wf = 2.0 * math.pi * 120.0 / NS
    ga, gb = linha_a, linha_b + 1

    saida = []
    for i in range(n):
        t0 = i * periodo
        cob = np.zeros((H, W), dtype=np.float64)
        tr = (t0 + t_linha)[ga:gb].reshape(-1, 1, 1).astype(np.float64)
        t_ini = tc_ns + (xx - xc - direcao * 0.0) / (direcao * v)
        t_fim = tc_ns + (xx - xc - direcao * (-L)) / (direcao * v)
        f_in = np.clip((tr + expo_ns - t_ini) / expo_ns, 0.0, 1.0)
        f_out = np.clip((tr + expo_ns - t_fim) / expo_ns, 0.0, 1.0)
        cob[ga:gb] = ((f_in - f_out) * peso).sum(axis=2) / 4.0
        frac = np.clip(cob, 0.0, 1.0)
        lin = base0 + (obj - base0) * frac
        if flicker > 0:
            treal = t0 + t_linha
            lin = lin * (1.0 + flicker * (np.cos(wf * treal) - np.cos(wf * (treal + expo_ns))) / (wf * expo_ns))
        val = 255.0 * np.power(np.clip(lin, 0.0, None) / 255.0, 1.0 / gamma)
        saida.append(np.clip(np.floor(val + 0.5), 0, 255).astype(np.uint8))
    return saida


def quadros_scene(*, W, H, fps, expo_ns, speed, L, tc_ns, direcao, bg, obj, gamma, skew_ns, flicker, n, linha_a, linha_b, roi, xc):
    """A mesma cena pela `Scene` dos vetores (ruído zero, sem textura, sem tilt, sem PSF extra)."""
    periodo = NS // fps
    cena = G.Scene(
        plane_width=W, stride=W, plane_height=H, roi=roi,
        skew_ns=skew_ns, exposure_ns=expo_ns, period_ns=periodo,
        direction=direcao, speed_px_per_s=speed, t_cross_center_ns=tc_ns,
        rows_a=linha_a, rows_b=linha_b, bg_level=bg, obj_level=obj,
        noise_sigma=0.0, flicker_amp=flicker, seed=1,
        gamma=gamma, tilt_px_per_row=0.0, texture_amp=0.0,
        flicker_integrated=True, psf_px=0.0,
    )
    return [cena.frame_bytes(i * periodo) for i in range(n)]


def main() -> int:
    W, H, fps = 24, 720, 240
    periodo = NS // fps
    expo = periodo
    roi = RoiRect(x=8, width=9, y0=300, y1=396)
    linha_a, linha_b = 312, 383
    speed, L = 2400.0, 90.0
    tc = 1_000_000_000_000 + 5 * periodo + int(0.37 * periodo)
    n = 12

    falhas = 0
    for nome, skew_ns, flicker in [
        ("sem rolling shutter, sem flicker", 0, 0.0),
        ("com rolling shutter (3,2 ms)", 3_200_000, 0.0),
        ("com rolling shutter e flicker 0,12", 3_200_000, 0.12),
    ]:
        # a `Scene` cruza no centro da ROI, não no centro do plano — alinhar isto é obrigatório,
        # senão a comparação mede uma diferença de convenção e não de física
        comum = dict(W=W, H=H, fps=fps, expo_ns=expo, speed=speed, L=L, tc_ns=tc, direcao=+1,
                     bg=96.0, obj=184.0, gamma=2.2, skew_ns=skew_ns, flicker=flicker, n=n,
                     linha_a=linha_a, linha_b=linha_b, xc=roi.x + (roi.width - 1) / 2.0)
        a = quadros_numpy(**comum)
        b = quadros_scene(roi=roi, **comum)

        pior = 0
        for i in range(n):
            # a `Scene` devolve só as linhas da banda da ROI, com `stride` bytes por linha
            faixa_b = np.frombuffer(b[i], dtype=np.uint8).reshape(roi.height, W)
            faixa_a = a[i][roi.y0:roi.y1, :W]
            pior = max(pior, int(np.abs(faixa_a.astype(int) - faixa_b.astype(int)).max()))
        ok = pior <= 1
        print(f"{'ok  ' if ok else 'FALHA'} — {nome}: diferença máxima {pior} nível(is) de luma")
        if not ok:
            falhas += 1

    print(f"\n{'todas as cenas batem' if falhas == 0 else f'{falhas} cena(s) divergem'}")
    return 1 if falhas else 0


if __name__ == "__main__":
    raise SystemExit(main())
