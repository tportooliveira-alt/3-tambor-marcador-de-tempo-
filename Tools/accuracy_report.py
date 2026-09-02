#!/usr/bin/env python3
"""
Relatório de validação numérica: varredura reduzida de cenários sintéticos com a referência
Python e tabela de erro por condição em docs/validacao-numerica.md.
(A varredura completa, com ~1.900 cenários, roda nos testes Kotlin/Swift em segundos; aqui em
Python puro usamos um subconjunto representativo.)

Uso: python3 Tools/accuracy_report.py
"""
from __future__ import annotations

import os
import sys
import time
from statistics import mean

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from photocell_reference import NS_PER_SEC, PhotocellConfig, RoiRect  # noqa: E402
import gen_test_vectors as G  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "validacao-numerica.md")


def run_case(speed, expo, noise, d, frac, obj, flick, seed, W=15):
    cfg = PhotocellConfig(calibration_samples=32, calibration_min_samples_for_outlier=8, skew_ns=3_200_000, exposure_ns=expo)
    period = cfg.frame_period_ns
    pw, stride, ph = 32, 40, 720
    roi = RoiRect(x=8, width=W, y0=300, y1=396)
    speed_px = speed * 1000 / 6.0
    n_pre = 1 + 32 + 12
    c = n_pre + 3
    t0 = 1_000_000_000_000
    t_cross = t0 + c * period + int(frac * period)
    scene = G.Scene(plane_width=pw, stride=stride, plane_height=ph, roi=roi, skew_ns=3_200_000, exposure_ns=expo,
                    period_ns=period, direction=d, speed_px_per_s=speed_px, t_cross_center_ns=t_cross,
                    rows_a=312, rows_b=383, obj_level=obj, noise_sigma=noise, flicker_amp=flick, seed=seed)
    frames = [scene.frame_bytes(t0 + i * period) for i in range(c + 10)]
    ts = [t0 + i * period for i in range(c + 10)]
    eng, _, _ = G.run_strip(cfg, roi, pw, ph, stride, frames, ts, {0: "user_arm"})
    st = eng.start
    if st is None:
        return None
    return {"raw": (st.raw_ts_ns - t_cross) / 1e6, "ref": (st.refined_ts_ns - t_cross) / 1e6,
            "q": st.quality, "unc": st.uncertainty_ns / 1e6, "lag": eng.lag}


def main() -> None:
    t_start = time.time()
    rows = []
    seed = 500
    conds = []
    for speed in (8.0, 14.0, 18.0):
        for expo, ename in ((4_166_666, "1/240"), (2_083_333, "1/480"), (500_000, "1/2000")):
            for noise in (0.5, 1.5, 3.0):
                for flick in (0.0, 0.12):
                    conds.append((speed, expo, ename, noise, flick))
    for speed, expo, ename, noise, flick in conds:
        results = []
        for d in (1, -1):
            for frac in (0.1, 0.5, 0.9):
                seed += 1
                r = run_case(speed, expo, noise, d, frac, 184, flick, seed)
                if r:
                    results.append(r)
        q2 = [abs(r["ref"]) for r in results if r["q"] == 2]
        q1 = [r for r in results if r["q"] == 1]
        q0 = [r for r in results if r["q"] == 0]
        raw = [abs(r["raw"]) for r in results]
        q1_ok = sum(1 for r in q1 if abs(r["ref"]) <= r["unc"] + 0.1)
        rows.append({
            "speed": speed, "expo": ename, "noise": noise, "flick": flick, "n": len(results),
            "raw_mean": mean(raw) if raw else 0, "q2": len(q2), "q2_mean": mean(q2) if q2 else None,
            "q2_max": max(q2) if q2 else None, "q1": len(q1), "q1_ok": q1_ok,
            "q1_unc": mean(r["unc"] for r in q1) if q1 else None, "q0": len(q0),
            "lag2": sum(1 for r in results if r["lag"] == 2),
        })
        print(f"  v={speed:4.1f} E={ename:6s} σ={noise:3.1f} flicker={flick:.2f}: q2={len(q2)} (|erro| médio {mean(q2) if q2 else 0:.3f} ms) q1={len(q1)} q0={len(q0)}")

    all_q2 = [r for r in rows if r["q2_mean"] is not None]
    lines = ["# Validação numérica do estimador sub-quadro", "",
             "Gerado por `Tools/accuracy_report.py` com a referência Python (`Tools/photocell_reference.py`): cena sintética com",
             "rolling shutter (skew 3,2 ms), exposição integrada, ruído gaussiano por pixel, flicker de 120 Hz opcional, faixa de",
             "15 px × 96 linhas a 240 FPS, contraste cavalo/fundo ≈ 88 níveis, 6 mm/px. Para cada condição, 6 cruzamentos",
             "(dois sentidos × três fases do quadro). A varredura completa (~1.900 cenários, inclusive contraste baixo) roda nos",
             "testes `PhysicsSweepTest` (Kotlin) e `PhysicsSweepTests` (Swift).", "",
             "Qualidade 2 = ajuste completo (erro comparado ao tempo por quadro); 1 = intervalo honesto (conta quantos contêm a",
             "verdade); 0 = meio da janela de exposição (±2,08 ms).", "",
             "| Velocidade | Exposição | Ruído σ | Flicker | Erro por quadro (médio) | Q2: n / erro médio / máx | Q1: n / dentro | Q0 |",
             "|---|---|---|---|---|---|---|---|"]
    for r in rows:
        q2s = f"{r['q2']} / {r['q2_mean']:.3f} ms / {r['q2_max']:.3f} ms" if r["q2_mean"] is not None else f"{r['q2']}"
        q1s = f"{r['q1']} / {r['q1_ok']} (±{r['q1_unc']:.2f} ms)" if r["q1"] else "0"
        lines.append(f"| {r['speed']:.0f} m/s | {r['expo']} s | {r['noise']:.1f} | {'120 Hz' if r['flick'] else '—'} | {r['raw_mean']:.2f} ms | {q2s} | {q1s} | {r['q0']} |")
    overall = [v for r in all_q2 for v in [r["q2_mean"]]]
    lines += ["", f"Erro médio (qualidade 2) sobre todas as condições: **{mean(overall):.3f} ms**; tempo por quadro: "
              f"**{mean(r['raw_mean'] for r in rows):.2f} ms**. Tempo de geração: {time.time() - t_start:.0f} s.", "",
              "Leitura: exposições mais longas dão mais pixels \"interiores\" (mais qualidade 2); com exposição curta e cavalo",
              "lento só uma coluna vê o bordo e o resultado cai para um intervalo (qualidade 1) que usa a faixa de velocidades",
              "plausível; ruído alto com contraste baixo reduz a qualidade em vez de produzir um número falso."]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("gravado", os.path.relpath(OUT))


if __name__ == "__main__":
    main()
