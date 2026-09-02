#!/usr/bin/env python3
"""
Harness de cenários adversariais para o estimador (referência Python).

Uso (linha de comando):
    python3 Tools/scenario_harness.py '{"speed_m_s": 12, "texture_amp": 20, "dark_object": true}'
    python3 Tools/scenario_harness.py --sweep '[{"noise_sigma": 3}, {"psf_px": 4, "frac": 0.9}]'

Cada cenário roda o pipeline inteiro (differencer → calibração → engine → estimador) numa cena
sintética com rolling shutter, exposição integrada, ruído e os efeitos "reais" opcionais, e devolve:
    triggered, quality, error_ms (refinado − verdade), unc_ms (3σ), inside (verdade dentro de ±unc),
    raw_error_ms, textured_columns, drops, degraded, finding (None ou o motivo da falha).

Critérios de achado (os mesmos do loop de agentes):
    - q2 com |erro| > 0,5 ms (precisão falsa);
    - q1 com a verdade fora do intervalo;
    - q0 com |erro| > P/2 + 0,1 ms;
    - sem disparo (com o objeto cruzando a faixa) ou disparo antes do cruzamento.
    Objetos finos (object_width_px menor que ~3 quadros de deslocamento, ex.: rédea, chicote) saem da
    faixa antes da confirmação e NÃO disparam — é o comportamento desejado; use expect_trigger=false.
    Envelope de operação (o que o produto promete): bordo a ≥ 800 px/s (velocidade/mm_per_px), bordo
    inclinado ≤ 0,05 px/linha (celular nivelado), desfoque ≤ 4 px. Fora dele um achado é relatado como
    "fora do envelope" e não conta.

Parâmetros (todos opcionais; unidades no nome):
    speed_m_s (14), mm_per_px (6), exposure_ns (1/480 s), fps (240), noise_sigma (1.5), direction (+1/−1),
    frac (0.37: fase do cruzamento dentro do período), obj_level (184), bg_level (96), dark_object (False:
    troca obj/fundo), flicker (0.0 amplitude 120 Hz), flicker_integrated (False), gamma (1.0) e cfg_gamma (1.0),
    tilt_px_per_row (0), texture_amp (0), psf_px (0), strip_width (15), band_rows (96), object_rows_margin (12),
    object_width_px (None = infinito; largura finita mostra o bordo de saída), occluded_rows (0: linhas do
    meio da banda sem objeto), drop_frames ([]: índices relativos ao quadro candidato, ex. [-1, 0, 1]),
    skew_ns (3,2 ms), cfg_skew (True: o engine conhece o skew), seed (1), second_object_delay_ms (None:
    segundo bordo entrando depois do primeiro, dentro da faixa).
"""
import json
import math
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from photocell_reference import PhotocellConfig, RoiRect, NS_PER_SEC  # noqa: E402
from gen_test_vectors import Scene, run_strip  # noqa: E402


class AdversarialScene(Scene):
    """Scene do gerador + objeto de largura finita, oclusão de linhas, objeto escuro e segundo bordo."""

    def __init__(self, *a, object_width_px=None, occluded_rows=0, second_object_delay_ns=None, **kw):
        super().__init__(*a, **kw)
        self.object_width_px = object_width_px
        self.occluded_rows = occluded_rows
        self.second_delay = second_object_delay_ns

    def _coverage(self, t_row, xe):
        """fração da exposição em que o pixel (coluna efetiva xe) esteve coberto pelo objeto."""
        tx = self._edge_time_at_x(xe)
        f_in = (t_row + self.E - tx) / self.E
        f_in = 0.0 if f_in < 0.0 else (1.0 if f_in > 1.0 else f_in)
        if self.object_width_px is not None:
            # bordo de saída: o objeto deixa o pixel width/v depois de entrar
            t_out = tx + self.object_width_px / self.v
            f_out = (t_row + self.E - t_out) / self.E
            f_out = 0.0 if f_out < 0.0 else (1.0 if f_out > 1.0 else f_out)
            f_in -= f_out
        if self.second_delay is not None:
            # segundo objeto (mesma luma) entrando `second_delay` depois: soma sem passar de 1
            t2 = tx + self.second_delay
            f2 = (t_row + self.E - t2) / self.E
            f2 = 0.0 if f2 < 0.0 else (1.0 if f2 > 1.0 else f2)
            f_in = min(1.0, f_in + f2)
        return f_in

    def frame_bytes(self, t_frame):
        from gen_test_vectors import SENTINEL
        buf = bytearray([SENTINEL]) * (self.stride * self.roi.height)
        r = self.roi
        mid = (self.ra + self.rb) / 2
        occ_a = mid - self.occluded_rows / 2
        occ_b = mid + self.occluded_rows / 2
        for row in range(r.height):
            g = r.y0 + row
            t_row = t_frame + (g * self.skew) // self.ph
            if self.fint and self.flicker > 0:
                w = 2 * math.pi * 120.0 / NS_PER_SEC
                flick = 1.0 + self.flicker * (math.cos(w * t_row) - math.cos(w * (t_row + self.E))) / (w * self.E)
            else:
                flick = 1.0 + self.flicker * math.sin(2.0 * math.pi * 120.0 * (t_row / NS_PER_SEC))
            covered_row = self.ra <= g <= self.rb and not (self.occluded_rows > 0 and occ_a <= g <= occ_b)
            for x in range(self.pw):
                base = self.bg + ((x * 7 + g * 3) % 11)
                frac = 0.0
                if covered_row:
                    xe = x - (g - mid) * self.tilt
                    if self.psf > 0:
                        n = 5
                        acc = 0.0
                        for k in range(n):
                            xk = xe + (k - (n - 1) / 2) * self.psf / (n - 1)
                            acc += self._coverage(t_row, xk)
                        frac = acc / n
                    else:
                        frac = self._coverage(t_row, xe)
                obj = self.obj
                if self.tex > 0:
                    rel = (x - self.xc) * self.d - (t_row + self.E / 2 - self.tc) * self.v
                    obj = self.obj + self.tex * math.sin(rel * 0.9 + g * 0.3)
                lin = (base + (obj - base) * frac) * flick      # flicker modula a luz, antes da curva de tom
                val = 255.0 * ((max(lin, 0) / 255.0) ** (1.0 / self.gamma)) if self.gamma != 1.0 else lin
                val = val + self.rng.gauss(self.sigma)
                iv = int(math.floor(val + 0.5))
                iv = 0 if iv < 0 else (255 if iv > 255 else iv)
                buf[row * self.stride + x] = iv
        return bytes(buf)


def run_scenario(**p):
    speed = float(p.get("speed_m_s", 14.0))
    mm_per_px = float(p.get("mm_per_px", 6.0))
    fps = int(p.get("fps", 240))
    expo = int(p.get("exposure_ns", NS_PER_SEC // 480))
    noise = float(p.get("noise_sigma", 1.5))
    d = int(p.get("direction", 1))
    frac = float(p.get("frac", 0.37))
    obj = int(p.get("obj_level", 184))
    bg = int(p.get("bg_level", 96))
    if p.get("dark_object", False):
        obj, bg = bg, obj
    flicker = float(p.get("flicker", 0.0))
    strip = int(p.get("strip_width", 15))
    band = int(p.get("band_rows", 96))
    margin = int(p.get("object_rows_margin", 12))
    skew = int(p.get("skew_ns", 3_200_000))
    seed = int(p.get("seed", 1))
    if band <= 2 * margin + 2:
        raise ValueError(f"cenário inválido: band_rows={band} não comporta object_rows_margin={margin} "
                         f"(o objeto não cobriria nenhuma linha); use band_rows > {2 * margin + 2}")
    cfg = PhotocellConfig(frame_rate_hz=fps, calibration_samples=32, calibration_min_samples_for_outlier=8,
                          skew_ns=skew if p.get("cfg_skew", True) else None, exposure_ns=expo,
                          gamma=float(p.get("cfg_gamma", 1.0)))
    P = cfg.frame_period_ns
    pw = max(24, strip + 16)
    stride = pw + 8
    ph = 720
    roi = RoiRect(x=8, width=strip, y0=300, y1=300 + band)
    speed_px = speed * 1000.0 / mm_per_px
    n_pre = 1 + cfg.calibration_samples + 12
    t0 = 1_000_000_000_000
    cf = n_pre + 3
    tc = t0 + cf * P + int(frac * P)
    sd = p.get("second_object_delay_ms")
    sc = AdversarialScene(plane_width=pw, stride=stride, plane_height=ph, roi=roi, skew_ns=skew, exposure_ns=expo,
                          period_ns=P, direction=d, speed_px_per_s=speed_px, t_cross_center_ns=tc,
                          rows_a=roi.y0 + margin, rows_b=roi.y1 - 1 - margin, bg_level=bg, obj_level=obj,
                          noise_sigma=noise, flicker_amp=flicker, seed=seed, gamma=float(p.get("gamma", 1.0)),
                          tilt_px_per_row=float(p.get("tilt_px_per_row", 0.0)), texture_amp=float(p.get("texture_amp", 0.0)),
                          flicker_integrated=bool(p.get("flicker_integrated", False)), psf_px=float(p.get("psf_px", 0.0)),
                          object_width_px=p.get("object_width_px"), occluded_rows=int(p.get("occluded_rows", 0)),
                          second_object_delay_ns=None if sd is None else int(float(sd) * 1e6))
    drops = set(int(i) + cf for i in p.get("drop_frames", []))
    frames, ts = [], []
    for i in range(cf + 12):
        if i in drops:
            continue
        t = t0 + i * P
        frames.append(sc.frame_bytes(t))
        ts.append(t)
    eng, meas, eff = run_strip(cfg, roi, pw, ph, stride, frames, ts, {0: "user_arm"})
    st = eng.start
    out = {"params": p, "triggered": st is not None, "state": eng.state, "drops": eng.drops,
           "threshold": eng.threshold, "period_ms": P / 1e6}
    if st is None:
        expect = bool(p.get("expect_trigger", True))
        out.update(quality=None, error_ms=None, unc_ms=None, inside=None,
                   finding="sem disparo" if expect else None)
        return out
    # Skew desconhecido pelo engine (iPhone): todas as linhas são tratadas como t_ini = ts, um offset
    # constante de (linha média/H)·skew que cancela em ΔT; o erro é avaliado descontando-o.
    row_offset_ns = 0.0
    if not p.get("cfg_skew", True):
        row_offset_ns = (roi.y0 + roi.height / 2.0) * skew / ph
    err = (st.refined_ts_ns + row_offset_ns - tc) / 1e6
    unc = st.uncertainty_ns / 1e6
    raw_err = (st.raw_ts_ns - tc) / 1e6
    # O gatilho vem da primeira coluna do núcleo (largura/2 px antes do centro) e de qualquer linha da
    # banda; a referência do differencer está `lag` quadros atrás (lag 2 sob flicker de 120 Hz), então
    # a mudança acumulada nesses quadros dispara até lag·P + E antes do cruzamento do CENTRO.
    lag = eng.lag
    core_half_px = cfg.core_width / 2.0 + 1.0
    # bordo inclinado: a primeira linha da banda chega (banda/2)·tilt px antes da linha média
    tilt_lead_px = abs(float(p.get("tilt_px_per_row", 0.0))) * (roi.height / 2.0)
    earliest_ok_ms = -(lag * P + expo + (core_half_px + tilt_lead_px) / speed_px * 1e9) / 1e6 - 0.05
    in_envelope = speed_px >= 800.0 and abs(float(p.get("tilt_px_per_row", 0.0))) <= 0.05 \
        and float(p.get("psf_px", 0.0)) <= 4.0
    out.update(quality=st.quality, error_ms=round(err, 4), unc_ms=round(unc, 4), inside=abs(err) <= unc,
               row_offset_ms=round(row_offset_ns / 1e6, 4),
               raw_error_ms=round(raw_err, 4), textured_columns=st.textured_columns, degraded=st.degraded,
               interior=st.interior_count)
    finding = None
    if raw_err < earliest_ok_ms:
        finding = "disparo antes do cruzamento (falso positivo)"
    elif st.quality == 2 and abs(err) > max(0.5, unc):
        # a 240 fps a qualidade 2 exige 3σ ≤ 0,52 ms; em taxas menores o limiar (P/8) cresce e o erro
        # só é "falso" se sair da incerteza declarada
        finding = "q2 com |erro| > max(0,5 ms, incerteza) (precisão falsa)"
    elif st.quality == 1 and abs(err) > unc + 0.05:
        finding = "q1 com a verdade fora do intervalo"
    elif st.quality == 0 and abs(err) > unc + 0.1:
        finding = "q0 com a verdade fora do intervalo"
    if finding is not None and not in_envelope:
        out["out_of_envelope"] = finding
        finding = None
    out["finding"] = finding
    return out


def main(argv):
    if len(argv) >= 2 and argv[1] == "--sweep":
        scenarios = json.loads(argv[2]) if len(argv) > 2 else json.load(sys.stdin)
    elif len(argv) >= 2:
        scenarios = [json.loads(argv[1])]
    else:
        scenarios = [{}]
    results = [run_scenario(**s) for s in scenarios]
    for r in results:
        p = r["params"]
        print(json.dumps({k: v for k, v in r.items() if k != "params"}, ensure_ascii=False), "<-", json.dumps(p, ensure_ascii=False))
    n_find = sum(1 for r in results if r["finding"])
    print(f"cenários={len(results)} achados={n_find}")
    return 1 if n_find else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
