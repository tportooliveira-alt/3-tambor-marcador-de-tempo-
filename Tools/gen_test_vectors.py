#!/usr/bin/env python3
"""
Gera os vetores de teste compartilhados em shared/test-vectors/ a partir da
implementação de referência (Tools/photocell_reference.py).

Tipos de vetor:
  * strip_*.json        quadros sintéticos (bytes do plano Y) -> medições, transições e gatilho
  * calibration_*.json  sequências de ΔY -> limiar / reinícios / falha
  * fsm_*.json          eventos em nível de medição (RLE) -> transições, efeitos e resultado
  * format_elapsed.json formatação de tempo

Uso: python3 Tools/gen_test_vectors.py
"""
from __future__ import annotations

import base64
import json
import math
import os
import sys
from dataclasses import asdict
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from photocell_reference import (  # noqa: E402
    NS_PER_SEC, PhotocellConfig, RoiRect, StripDifferencer, NoiseCalibrator,
    PhotocellEngine, FrameMeasurement, format_elapsed, compute_threshold,
    IDLE, ARMED, FINISHED,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shared", "test-vectors")
SENTINEL = 0xEE


# --------------------------------------------------------------------------- #
# RNG determinístico (xorshift64*) — os bytes finais vão para o JSON, então a
# portabilidade do gerador não importa; só a reprodutibilidade aqui.
# --------------------------------------------------------------------------- #
class Rng:
    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFFFFFFFFFF or 0x9E3779B97F4A7C15

    def next_u64(self) -> int:
        x = self.s
        x ^= (x >> 12) & 0xFFFFFFFFFFFFFFFF
        x ^= (x << 25) & 0xFFFFFFFFFFFFFFFF
        x ^= (x >> 27) & 0xFFFFFFFFFFFFFFFF
        self.s = x & 0xFFFFFFFFFFFFFFFF
        return (x * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF

    def uniform(self) -> float:
        return (self.next_u64() >> 11) / float(1 << 53)

    def gauss(self, sigma: float) -> float:
        u1 = max(self.uniform(), 1e-12)
        u2 = self.uniform()
        return sigma * math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def cfg_to_json(cfg: PhotocellConfig) -> Dict:
    d = asdict(cfg)
    return d


# --------------------------------------------------------------------------- #
# Cena sintética
# --------------------------------------------------------------------------- #
class Scene:
    """
    Cena: fundo estático com padrão espacial + ruído gaussiano por quadro;
    objeto (luma alta) cujo bordo vertical cruza a faixa a velocidade constante;
    rolling shutter linha a linha (skew) e integração da exposição (E).
    """

    def __init__(self, *, plane_width: int, stride: int, plane_height: int, roi: RoiRect,
                 skew_ns: int, exposure_ns: int, period_ns: int, direction: int,
                 speed_px_per_s: float, t_cross_center_ns: int, rows_a: int, rows_b: int,
                 bg_level: int = 96, obj_level: int = 184, noise_sigma: float = 1.5,
                 flicker_amp: float = 0.0, seed: int = 1,
                 gamma: float = 1.0, tilt_px_per_row: float = 0.0, texture_amp: float = 0.0,
                 flicker_integrated: bool = False, psf_px: float = 0.0):
        self.pw, self.stride, self.ph, self.roi = plane_width, stride, plane_height, roi
        self.skew, self.E, self.period = skew_ns, exposure_ns, period_ns
        self.d = direction
        self.v = speed_px_per_s / NS_PER_SEC     # px por ns
        self.tc = t_cross_center_ns
        self.xc = roi.x + roi.width // 2         # coluna central da faixa
        self.ra, self.rb = rows_a, rows_b         # linhas (globais) ocupadas pelo objeto
        self.bg, self.obj = bg_level, obj_level
        self.sigma = noise_sigma
        self.flicker = flicker_amp
        self.rng = Rng(seed)
        # Efeitos "reais" opcionais (os portes Kotlin/Swift do simulador tem os mesmos):
        self.gamma = gamma                        # curva de tom: V = 255*(lin/255)^(1/gamma)
        self.tilt = tilt_px_per_row               # bordo inclinado: coluna do bordo varia com a linha
        self.tex = texture_amp                    # textura presa ao objeto (senoide em x e y)
        self.fint = flicker_integrated            # flicker integrado ao longo da exposicao
        self.psf = psf_px                         # desfoque: caixa de psf_px (5 amostras)

    def edge_time_at(self, x: int) -> float:
        # instante em que o bordo alcança a coluna x
        return self.tc + (x - self.xc) * self.d / self.v

    def _edge_time_at_x(self, xe: float) -> float:
        return self.tc + (xe - self.xc) * self.d / self.v

    def frame_bytes(self, t_frame: int) -> bytes:
        buf = bytearray([SENTINEL]) * (self.stride * self.roi.height)
        r = self.roi
        mid = (self.ra + self.rb) / 2.0
        for row in range(r.height):
            g = r.y0 + row
            t_row = t_frame + (g * self.skew) // self.ph
            if self.fint and self.flicker > 0.0:
                wf = 2.0 * math.pi * 120.0 / NS_PER_SEC
                flick = 1.0 + self.flicker * (math.cos(wf * t_row) - math.cos(wf * (t_row + self.E))) / (wf * self.E)
            else:
                flick = 1.0 + self.flicker * math.sin(2.0 * math.pi * 120.0 * (t_row / NS_PER_SEC))
            for x in range(self.pw):
                base = self.bg + ((x * 7 + g * 3) % 11)
                frac = 0.0
                if self.ra <= g <= self.rb:
                    xe = x - (g - mid) * self.tilt
                    if self.psf > 0.0:
                        acc = 0.0
                        for k in range(5):
                            xk = xe + (k - 2.0) * self.psf / 4.0
                            fk = (t_row + self.E - self._edge_time_at_x(xk)) / self.E
                            acc += 0.0 if fk < 0.0 else (1.0 if fk > 1.0 else fk)
                        frac = acc / 5.0
                    else:
                        frac = (t_row + self.E - self._edge_time_at_x(xe)) / self.E
                        frac = 0.0 if frac < 0.0 else (1.0 if frac > 1.0 else frac)
                obj = float(self.obj)
                if self.tex > 0.0:
                    # textura presa ao objeto: fase relativa ao bordo (px atras do bordo no meio da exposicao)
                    rel = (x - self.xc) * self.d - (t_row + self.E / 2.0 - self.tc) * self.v
                    obj = self.obj + self.tex * math.sin(rel * 0.9 + g * 0.3)
                # o flicker modula a LUZ (antes da curva de tom); o ruído é do sensor/ADC (depois)
                lin = (base + (obj - base) * frac) * flick
                if self.gamma != 1.0:
                    val = 255.0 * math.pow((lin if lin > 0.0 else 0.0) / 255.0, 1.0 / self.gamma)
                else:
                    val = lin
                val = val + self.rng.gauss(self.sigma)
                iv = int(math.floor(val + 0.5))
                iv = 0 if iv < 0 else (255 if iv > 255 else iv)
                buf[row * self.stride + x] = iv
        return bytes(buf)


# --------------------------------------------------------------------------- #
# Harness (idêntico ao que os testes Swift/Kotlin devem fazer)
# --------------------------------------------------------------------------- #
def run_strip(cfg: PhotocellConfig, roi: RoiRect, plane_width: int, plane_height: int,
              stride: int, frames: List[bytes], timestamps: List[int], user_events: Dict[int, str]):
    diff = StripDifferencer(roi, plane_width, plane_height, cfg.core_width)
    eng = PhotocellEngine(cfg, roi, plane_height)
    measurements: List[Optional[Dict]] = []
    effect_log: List[Dict] = []

    def apply_effects(tag: str):
        for e in eng.effects:
            if e == "resetDifferencer":
                diff.reset()
            elif e == "updateBackground":
                diff.update_background(cfg.background_ema_alpha)
            elif e.startswith("setReferenceLag:"):
                diff.set_lag(int(e.split(":")[1]))
        if eng.effects:
            effect_log.append({"at": tag, "effects": list(eng.effects)})
        eng.effects.clear()

    full_plane = bytearray([SENTINEL]) * (stride * plane_height)
    for i, (fb, ts) in enumerate(zip(frames, timestamps)):
        if i in user_events:
            getattr(eng, user_events[i])()
            apply_effects(f"before:{i}")
        # o vetor guarda só as linhas da banda: reconstrói o plano completo (como o harness nativo)
        full_plane[roi.y0 * stride: roi.y0 * stride + len(fb)] = fb
        m = diff.process(bytes(full_plane), stride, ts)
        if m is None:
            measurements.append(None)
            eng.frame(None, ts)
        else:
            measurements.append({"ts": m.ts_ns, "full": m.delta_full, "core": m.delta_core,
                                 "bg": m.delta_background})
            eng.frame(m)
        apply_effects(f"frame:{i}")
    return eng, measurements, effect_log


def trigger_json(t) -> Optional[Dict]:
    if t is None:
        return None
    return {"rawTs": t.raw_ts_ns, "refinedTs": t.refined_ts_ns, "quality": t.quality,
            "uncertaintyNs": t.uncertainty_ns, "interiorCount": t.interior_count,
            "degraded": t.degraded, "texturedColumns": t.textured_columns}


def strip_vector(name: str, *, direction: int, skew_ns: Optional[int], flicker: float,
                 drop_frames: List[int], seed: int, rows_margin: int = 12,
                 speed_m_s: float = 14.0, mm_per_px: float = 6.0, noise_sigma: float = 1.5,
                 exposure_ns: int = NS_PER_SEC // 480, cross_fraction: float = 0.37,
                 tolerance_ms: float = 0.15, gamma: float = 1.0, cfg_gamma: float = 1.0,
                 tilt_px_per_row: float = 0.0, texture_amp: float = 0.0, psf_px: float = 0.0,
                 strip_width: int = 9, obj_level: int = 184) -> Dict:
    cfg = PhotocellConfig(calibration_samples=32, calibration_min_samples_for_outlier=8,
                          skew_ns=skew_ns, exposure_ns=exposure_ns, gamma=cfg_gamma)
    period = cfg.frame_period_ns
    plane_width, stride, plane_height = (24, 32, 720) if strip_width <= 9 else (32, 40, 720)
    roi = RoiRect(x=8, width=strip_width, y0=300, y1=396)     # banda de 96 linhas
    exposure = exposure_ns
    scene_skew = skew_ns if skew_ns is not None else 3_200_000   # a cena sempre tem rolling shutter
    speed_px = speed_m_s * 1000.0 / mm_per_px
    n_pre = 1 + cfg.calibration_samples + 12          # semente + calibração + parado
    t0 = 1_000_000_000_000                             # 1000 s de uptime
    # o bordo cruza a coluna central dentro do quadro n_pre+3 (fração cross_fraction do período)
    cross_frame = n_pre + 3
    t_cross = t0 + cross_frame * period + int(cross_fraction * period)
    scene = Scene(plane_width=plane_width, stride=stride, plane_height=plane_height, roi=roi,
                  skew_ns=scene_skew, exposure_ns=exposure, period_ns=period, direction=direction,
                  speed_px_per_s=speed_px, t_cross_center_ns=t_cross,
                  rows_a=roi.y0 + rows_margin, rows_b=roi.y1 - 1 - rows_margin,
                  noise_sigma=noise_sigma, flicker_amp=flicker, seed=seed, gamma=gamma,
                  tilt_px_per_row=tilt_px_per_row, texture_amp=texture_amp, psf_px=psf_px,
                  obj_level=obj_level)
    n_frames = cross_frame + 10
    frames, timestamps = [], []
    for i in range(n_frames):
        if i in drop_frames:
            continue
        ts = t0 + i * period
        frames.append(scene.frame_bytes(ts))
        timestamps.append(ts)
    user_events = {0: "user_arm"}
    eng, meas, effects = run_strip(cfg, roi, plane_width, plane_height, stride, frames,
                                   timestamps, user_events)
    # verificação física (auto-teste do gerador)
    st = eng.start
    assert st is not None, f"{name}: não disparou"
    truth = t_cross
    err_raw_ms = (st.raw_ts_ns - truth) / 1e6
    row_offset = 0 if skew_ns is not None else \
        sum(((g_ * scene_skew) // plane_height) for g_ in range(roi.y0, roi.y1)) // roi.height
    err_ref_ms = (st.refined_ts_ns + row_offset - truth) / 1e6
    print(f"  {name:30s} raw={err_raw_ms:+7.3f} ms  refinado={err_ref_ms:+7.3f} ms  "
          f"±{st.uncertainty_ns/1e6:.3f}  q={st.quality} int={st.interior_count} tex={st.textured_columns} "
          f"lag={eng.lag} T={eng.threshold:.2f} drops={eng.drops} degr={st.degraded}")
    if st.quality == 2:
        assert abs(err_ref_ms) < max(tolerance_ms, st.uncertainty_ns / 1e6 + 0.1), f"{name}: refinamento fora da tolerância"
    elif st.quality == 1:
        assert abs(err_ref_ms) * 1e6 <= st.uncertainty_ns + 1e5, f"{name}: verdade fora do intervalo"
    return {
        "kind": "strip",
        "name": name,
        "description": f"Cruzamento sintético; direção {'->' if direction > 0 else '<-'}; "
                       f"skew={'nenhum' if skew_ns is None else skew_ns}; flicker={flicker}; "
                       f"drops={drop_frames}",
        "config": cfg_to_json(cfg),
        "roi": {"x": roi.x, "width": roi.width, "y0": roi.y0, "y1": roi.y1},
        "planeWidth": plane_width, "planeHeight": plane_height, "stride": stride,
        "sentinel": SENTINEL,
        "note": "Cada quadro contém apenas as linhas y0..y1 (height*stride bytes). O harness deve "
                "construir um plano de planeHeight linhas preenchido com o sentinela e copiar "
                "essas linhas na posição y0.",
        "userEvents": {str(k): v for k, v in user_events.items()},
        "timestamps": timestamps,
        "frames": [base64.b64encode(f).decode("ascii") for f in frames],
        "expected": {
            "measurements": meas,
            "transitions": eng.transitions,
            "effects": effects,
            "finalState": eng.state,
            "threshold": eng.threshold,
            "lag": eng.lag,
            "start": trigger_json(eng.start),
            "drops": eng.drops,
        },
        "groundTruth": {"tCrossCenterNs": truth, "exposureNs": exposure, "sceneSkewNs": scene_skew,
                        "crossFraction": cross_fraction,
                        "speedPxPerS": speed_px, "rawErrorMs": err_raw_ms,
                        "refinedErrorMs": err_ref_ms, "gamma": gamma, "tiltPxPerRow": tilt_px_per_row,
                        "textureAmp": texture_amp, "psfPx": psf_px},
    }


# --------------------------------------------------------------------------- #
# Calibração
# --------------------------------------------------------------------------- #
def calibration_vector(name: str, samples: List[float], cfg: PhotocellConfig, desc: str) -> Dict:
    cal = NoiseCalibrator(cfg)
    results = [cal.add_sample(x) for x in samples]
    return {
        "kind": "calibration", "name": name, "description": desc, "config": cfg_to_json(cfg),
        "samples": samples,
        "expected": {"results": results, "threshold": cal.threshold, "retries": cal.retries,
                     "failed": cal.failed, "mean": cal.stats.mean, "sigma": cal.stats.sigma,
                     "count": cal.stats.count},
    }


# --------------------------------------------------------------------------- #
# FSM em nível de medição (RLE)
# --------------------------------------------------------------------------- #
def run_fsm(cfg: PhotocellConfig, roi: RoiRect, plane_height: int, steps: List[Dict]):
    eng = PhotocellEngine(cfg, roi, plane_height)
    effect_log: List[Dict] = []
    idx = 0

    def flush(tag: str):
        if eng.effects:
            effect_log.append({"at": tag, "effects": list(eng.effects)})
        eng.effects.clear()

    for s in steps:
        t = s["type"]
        if t == "frames":
            for k in range(s["count"]):
                ts = s["ts0"] + k * s["period"]
                rows = s.get("rows", [])
                m = FrameMeasurement(ts, ts - s["period"], s["full"], s["core"], s["bg"],
                                     list(s.get("stripPrev", [])), list(s.get("stripCur", [])),
                                     list(s.get("stripBg", [])))
                eng.frame(m)
                flush(f"frame:{idx}")
                idx += 1
        elif t == "seed":
            eng.frame(None, s["ts"])
            flush(f"seed:{idx}")
            idx += 1
        elif t == "wakeup":
            eng.wakeup(s["ts"])
            flush(f"wakeup:{s['ts']}")
        elif t == "user":
            getattr(eng, s["event"])()
            flush(f"user:{s['event']}:{idx}")
        else:
            raise ValueError(t)
    return eng, effect_log


def fsm_vector(name: str, desc: str, cfg: PhotocellConfig, steps: List[Dict]) -> Dict:
    roi = RoiRect(x=8, width=9, y0=300, y1=396)
    eng, effects = run_fsm(cfg, roi, 720, steps)
    res = eng.result
    return {
        "kind": "fsm", "name": name, "description": desc, "config": cfg_to_json(cfg),
        "roi": {"x": roi.x, "width": roi.width, "y0": roi.y0, "y1": roi.y1}, "planeHeight": 720,
        "steps": steps,
        "expected": {
            "transitions": eng.transitions, "effects": effects, "finalState": eng.state,
            "errorReason": eng.error_reason, "threshold": eng.threshold,
            "start": trigger_json(eng.start), "finish": trigger_json(eng.finish),
            "drops": eng.drops,
            "result": None if res is None else {
                "elapsedRawNs": res.elapsed_raw_ns, "elapsedRefinedNs": res.elapsed_refined_ns,
                "drops": res.drops, "degraded": res.degraded,
                "thresholdStart": res.threshold_start, "thresholdFinish": res.threshold_finish,
                "elapsedText": format_elapsed(res.elapsed_raw_ns),
            },
        },
    }


def quiet(ts0: int, count: int, period: int, full=1.2, core=1.1, bg=0.9) -> Dict:
    return {"type": "frames", "count": count, "ts0": ts0, "period": period,
            "full": full, "core": core, "bg": bg}


def crossing_rows(h: int, a: int, b: int, first_row: int, level: float) -> List[float]:
    rows = [0.4] * h
    for r in range(a, b + 1):
        if r >= first_row:
            rows[r] = level
    return rows


def strip_arrays(h: int, w: int, a: int, b: int, frac: float, bg: float = 100.0,
                 obj: float = 190.0, slope_per_px: float = 0.0) -> Dict[str, List]:
    """Faixa sintética: fundo bg; linhas [a,b] cobertas com fração frac (+ rampa por coluna)."""
    prev, cur, bgl = [], [], []
    center = (w - 1) / 2.0
    for r in range(h):
        for i in range(w):
            bgl.append(bg)
            prev.append(int(bg))
            f = frac + slope_per_px * (i - center)
            f = 0.0 if f < 0.0 else (1.0 if f > 1.0 else f)
            cur.append(int(round(bg + (obj - bg) * f)) if a <= r <= b else int(bg))
    return {"stripPrev": prev, "stripCur": cur, "stripBg": bgl}


def build_full_run(cfg: PhotocellConfig, *, with_drop: bool, interrupted: bool,
                   reject_first: bool) -> List[Dict]:
    p = cfg.frame_period_ns
    t0 = 500 * NS_PER_SEC
    steps: List[Dict] = [{"type": "user", "event": "user_arm"}, {"type": "seed", "ts": t0}]
    n = 1
    steps.append(quiet(t0 + n * p, cfg.calibration_samples, p)); n += cfg.calibration_samples
    steps.append(quiet(t0 + n * p, 20, p)); n += 20
    if reject_first:
        # pico de 1 quadro sem confirmação de fundo -> volta a ARMED
        steps.append({"type": "frames", "count": 1, "ts0": t0 + n * p, "period": p,
                      "full": 12.0, "core": 15.0, "bg": 1.0, "rows": crossing_rows(96, 12, 83, 40, 15.0)}); n += 1
        steps.append(quiet(t0 + n * p, 4, p)); n += 4
        steps.append(quiet(t0 + n * p, 10, p)); n += 10
    # largada: candidato + 4 quadros de passagem (fundo confirma)
    start_ts = t0 + n * p
    steps.append({"type": "frames", "count": 1, "ts0": start_ts, "period": p,
                  "full": 20.0, "core": 30.0, "bg": 25.0, "rows": crossing_rows(96, 12, 83, 40, 30.0),
                  **strip_arrays(96, 9, 12, 83, 0.6, slope_per_px=0.05)}); n += 1
    steps.append({"type": "frames", "count": 4, "ts0": t0 + n * p, "period": p,
                  "full": 18.0, "core": 22.0, "bg": 40.0, "rows": crossing_rows(96, 12, 83, 12, 22.0),
                  **strip_arrays(96, 9, 12, 83, 1.0)}); n += 4
    # quadros que ainda chegam antes de a entrega ser desligada: ignorados
    steps.append(quiet(t0 + n * p, 3, p, full=30.0, core=35.0, bg=50.0)); n += 3
    steps.append({"type": "wakeup", "ts": start_ts + cfg.start_lockout_ns})
    steps.append({"type": "wakeup", "ts": start_ts + 5 * NS_PER_SEC})       # nada acontece
    if interrupted:
        steps.append({"type": "user", "event": "capture_interrupted"})
        steps.append({"type": "wakeup", "ts": start_ts + cfg.frame_resume_ns})
        steps.append({"type": "user", "event": "user_reset"})
        return steps
    steps.append({"type": "wakeup", "ts": start_ts + cfg.frame_resume_ns})
    # retomada: semente + quadros parados (ignorados em RUNNING)
    resume_ts = start_ts + cfg.frame_resume_ns + p
    steps.append({"type": "seed", "ts": resume_ts})
    k = 1
    steps.append(quiet(resume_ts + k * p, 100, p)); k += 100
    # o wakeup dos 10 s é disparado pelo PTS dos quadros (não há evento de wakeup explícito)
    arm_ts = start_ts + cfg.finish_arm_ns
    frames_until_arm = int((arm_ts - (resume_ts + k * p)) // p) + 2
    steps.append(quiet(resume_ts + k * p, frames_until_arm, p)); k += frames_until_arm
    if with_drop:
        k += 3   # três quadros perdidos logo antes da chegada -> "degradada"
    steps.append(quiet(resume_ts + k * p, 2, p)); k += 2
    finish_ts = resume_ts + k * p
    steps.append({"type": "frames", "count": 1, "ts0": finish_ts, "period": p,
                  "full": 19.0, "core": 28.0, "bg": 24.0, "rows": crossing_rows(96, 12, 83, 55, 28.0),
                  **strip_arrays(96, 9, 12, 83, 0.25, slope_per_px=-0.05)}); k += 1
    steps.append({"type": "frames", "count": 4, "ts0": resume_ts + k * p, "period": p,
                  "full": 17.0, "core": 21.0, "bg": 39.0, "rows": crossing_rows(96, 12, 83, 12, 21.0),
                  **strip_arrays(96, 9, 12, 83, 1.0)}); k += 4
    steps.append({"type": "wakeup", "ts": finish_ts + cfg.finish_lockout_ns - 1})   # cedo: no-op
    steps.append({"type": "wakeup", "ts": finish_ts + cfg.finish_lockout_ns})
    steps.append({"type": "wakeup", "ts": finish_ts + cfg.finish_lockout_ns})       # duplicado: no-op
    return steps


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    vectors: List[Dict] = []
    print("Vetores de faixa (auto-teste físico):")
    vectors.append(strip_vector("strip_cross_right_skew", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=11))
    vectors.append(strip_vector("strip_cross_left_skew", direction=-1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=12))
    vectors.append(strip_vector("strip_cross_right_noskew", direction=+1, skew_ns=None,
                                flicker=0.0, drop_frames=[], seed=13))
    vectors.append(strip_vector("strip_cross_flicker", direction=+1, skew_ns=3_200_000,
                                flicker=0.12, drop_frames=[], seed=14))
    vectors.append(strip_vector("strip_cross_with_drop", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[44, 45], seed=15))
    vectors.append(strip_vector("strip_cross_noisy_night", direction=-1, skew_ns=4_000_000,
                                flicker=0.10, drop_frames=[], seed=16, noise_sigma=4.0,
                                tolerance_ms=0.25))
    vectors.append(strip_vector("strip_cross_blind_gap", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=17, cross_fraction=0.05))
    vectors.append(strip_vector("strip_cross_full_exposure", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=18,
                                exposure_ns=NS_PER_SEC // 240, cross_fraction=0.9))
    vectors.append(strip_vector("strip_cross_short_exposure_day", direction=-1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=19,
                                exposure_ns=NS_PER_SEC // 2000, cross_fraction=0.5))
    # efeitos "reais": textura no objeto, curva de tom, bordo inclinado, drop encostado no gatilho
    vectors.append(strip_vector("strip_cross_textured", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=21, texture_amp=30.0,
                                strip_width=15, tolerance_ms=0.35))
    vectors.append(strip_vector("strip_cross_gamma", direction=-1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=22, gamma=2.2, cfg_gamma=2.2,
                                strip_width=15))
    vectors.append(strip_vector("strip_cross_tilted", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=23, tilt_px_per_row=0.05,
                                strip_width=15, tolerance_ms=0.35))
    vectors.append(strip_vector("strip_cross_drop_at_trigger", direction=-1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[47], seed=24, strip_width=15,
                                cross_fraction=0.61, tolerance_ms=0.35))
    # rodada 1 do loop: platô saturado (cavalo branco ao sol), flicker forte com curva de tom, drop do
    # próprio quadro candidato (o intervalo q0 tem de cobrir o quadro perdido)
    vectors.append(strip_vector("strip_cross_saturated", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[], seed=25, strip_width=15,
                                obj_level=252, noise_sigma=3.0, tolerance_ms=0.35))
    vectors.append(strip_vector("strip_cross_flicker_strong", direction=-1, skew_ns=3_200_000,
                                flicker=0.30, drop_frames=[], seed=26, strip_width=15,
                                gamma=2.2, cfg_gamma=2.2, tolerance_ms=0.35))
    vectors.append(strip_vector("strip_cross_drop_candidate", direction=+1, skew_ns=3_200_000,
                                flicker=0.0, drop_frames=[48], seed=27, strip_width=15,
                                cross_fraction=0.4, tolerance_ms=0.35))
    # rodada 2: drop 3 quadros antes do gatilho com flicker (lag 2) — o limite inferior do intervalo
    # de qualidade 0 tem de recuar até o último quadro REALMENTE comparado, não até o quadro-semente
    vectors.append(strip_vector("strip_cross_drop_before_trigger", direction=+1, skew_ns=3_200_000,
                                flicker=0.12, drop_frames=[45], seed=28, strip_width=15,
                                cross_fraction=0.3, tolerance_ms=0.35))

    # --- calibração ----------------------------------------------------------
    cfg = PhotocellConfig()
    rng = Rng(99)
    base = [abs(1.3 + rng.gauss(0.05)) for _ in range(cfg.calibration_samples + 5)]
    vectors.append(calibration_vector("calibration_normal", base, cfg,
                                      "240 amostras estáveis: limiar = max(floor, μ+kσ, 2μ) = floor"))
    hi = [abs(6.0 + rng.gauss(0.2)) for _ in range(cfg.calibration_samples)]
    vectors.append(calibration_vector("calibration_high_noise", hi, cfg,
                                      "Ruído alto: o ramo 2μ domina"))
    wide = [abs(2.0 + rng.gauss(1.0)) for _ in range(cfg.calibration_samples)]
    vectors.append(calibration_vector("calibration_wide_sigma", wide, cfg,
                                      "σ grande: o ramo μ+kσ domina"))
    outl = [abs(1.3 + rng.gauss(0.05)) for _ in range(60)] + [40.0] + \
           [abs(1.3 + rng.gauss(0.05)) for _ in range(cfg.calibration_samples)]
    vectors.append(calibration_vector("calibration_outlier_restart", outl, cfg,
                                      "Outlier após 60 amostras reinicia a coleta uma vez"))
    fail = []
    for _ in range(cfg.calibration_max_retries + 1):
        fail += [abs(1.3 + rng.gauss(0.05)) for _ in range(40)] + [50.0]
    vectors.append(calibration_vector("calibration_fail", fail, cfg,
                                      "Outliers repetidos esgotam as tentativas -> failed"))

    # --- FSM -----------------------------------------------------------------
    vectors.append(fsm_vector("fsm_full_run", "Percurso completo IDLE→…→FINISHED com refinamento sub-quadro",
                              PhotocellConfig(skew_ns=3_200_000),
                              build_full_run(PhotocellConfig(skew_ns=3_200_000), with_drop=False,
                                             interrupted=False, reject_first=False)))
    vectors.append(fsm_vector("fsm_full_run_noskew", "Percurso completo sem skew (modo quadro)",
                              PhotocellConfig(),
                              build_full_run(PhotocellConfig(), with_drop=False,
                                             interrupted=False, reject_first=False)))
    vectors.append(fsm_vector("fsm_reject_then_run", "Pico de um quadro rejeitado, depois prova válida",
                              PhotocellConfig(skew_ns=3_200_000),
                              build_full_run(PhotocellConfig(skew_ns=3_200_000), with_drop=False,
                                             interrupted=False, reject_first=True)))
    vectors.append(fsm_vector("fsm_drop_degraded", "Drops logo antes da chegada marcam a prova como degradada",
                              PhotocellConfig(skew_ns=3_200_000),
                              build_full_run(PhotocellConfig(skew_ns=3_200_000), with_drop=True,
                                             interrupted=False, reject_first=False)))
    vectors.append(fsm_vector("fsm_interrupted", "Interrupção da captura em RUNNING → ERROR → reset",
                              PhotocellConfig(skew_ns=3_200_000),
                              build_full_run(PhotocellConfig(skew_ns=3_200_000), with_drop=False,
                                             interrupted=True, reject_first=False)))
    # janelas curtas (mínimo permitido por PhotocellConfig.validate: retomada 0,5 s após o lockout e
    # chegada armada 0,5 s após a retomada): a retomada acontece em RUNNING logo após o lockout
    cfg_short = PhotocellConfig(skew_ns=3_200_000, start_lockout_ns=1_500_000_000,
                                frame_resume_ns=2_000_000_000, finish_arm_ns=2_500_000_000)
    vectors.append(fsm_vector("fsm_short_windows",
                              "Janelas mínimas: lockout 1,5 s, retomada 2,0 s, chegada armada 2,5 s",
                              cfg_short, build_full_run(cfg_short, with_drop=False,
                                                        interrupted=False, reject_first=False)))

    # --- formatação ------------------------------------------------------------
    cases = [0, 999_999, 1_000_000, 12_345_000_000, 12_344_500_000, 12_344_499_999,
             60_000_000_000, 125_678_900_000, -5]
    vectors.append({"kind": "format", "name": "format_elapsed",
                    "description": "nanos -> 'S.mmm' com arredondamento half-up",
                    "cases": [{"ns": c, "text": format_elapsed(c)} for c in cases]})

    index = []
    for v in vectors:
        path = os.path.join(OUT_DIR, v["name"] + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(v, fh, ensure_ascii=False, separators=(",", ":"))
        index.append({"name": v["name"], "kind": v["kind"], "file": v["name"] + ".json",
                      "description": v.get("description", "")})
        print(f"  gravado {os.path.relpath(path)} ({os.path.getsize(path)//1024} KB)")
    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as fh:
        json.dump({"vectors": index}, fh, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
