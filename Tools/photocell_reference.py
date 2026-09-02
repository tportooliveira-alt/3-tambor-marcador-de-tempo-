#!/usr/bin/env python3
"""
Implementação de REFERÊNCIA do algoritmo da fotocélula virtual.

Este arquivo é a especificação executável compartilhada pelos núcleos Swift
(ios/Packages/PhotocellCore) e Kotlin (android/core). Os vetores de teste em
shared/test-vectors/ são gerados a partir dele (Tools/gen_test_vectors.py) e as
duas implementações nativas precisam reproduzir exatamente os mesmos resultados.

Convenções:
  * Tempo sempre em nanossegundos inteiros (int64) do relógio do sensor.
  * Luminância como bytes (0..255) do plano Y (NV12 / YUV_420_888 plano 0).
  * Endereço(x, y) = base + y*stride + x.
  * Toda aritmética estatística em double (IEEE 754), na mesma ordem de operações
    nas três linguagens, para que os valores batam bit a bit.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

NS_PER_SEC = 1_000_000_000


# --------------------------------------------------------------------------- #
# Configuração
# --------------------------------------------------------------------------- #
@dataclass
class PhotocellConfig:
    frame_rate_hz: int = 240
    start_lockout_ns: int = 1_500_000_000        # DEBOUNCE_START
    frame_resume_ns: int = 8_000_000_000         # RUNNING: volta a receber quadros (só ressemeia)
    finish_arm_ns: int = 10_000_000_000          # RUNNING -> AWAITING_FINISH
    finish_lockout_ns: int = 2_000_000_000       # DEBOUNCE_FINISH
    calibration_samples: int = 240
    calibration_min_samples_for_outlier: int = 30
    calibration_outlier_sigma: float = 10.0
    calibration_max_retries: int = 3
    threshold_floor: float = 4.0
    threshold_sigma_k: float = 6.0
    threshold_mean_multiplier: float = 2.0
    confirm_window: int = 4
    confirm_required: int = 2
    background_threshold_multiplier: float = 1.0
    background_ema_alpha: float = 0.02
    drop_gap_factor: float = 1.5
    degraded_drop_window_ns: int = 50_000_000
    core_width: int = 3                          # colunas centrais usadas para o gatilho/linha
    exposure_ns: int = 2_083_333                 # duração de exposição fixa (1/480 s por padrão)
    min_contrast: float = 20.0                   # |O - B| mínimo (níveis de luma) para um pixel ser usado
    fraction_margin_min: float = 0.03            # margem mínima de classificação da fração f
    fraction_margin_sigmas: float = 4.0          # margem = max(min, k * sqrt(2) * sigma_px / |O-B|)
    fraction_margin_max: float = 0.25            # acima disso (contraste/ruído baixo) o pixel só dá limites
    speed_px_per_s_min: float = 800.0            # faixa plausível de velocidade do bordo (fallback de 1 coluna)
    speed_px_per_s_max: float = 4000.0
    min_interior_rows_per_column: int = 3        # coluna só participa do ajuste com pelo menos N linhas interiores
    min_interior_rows_fraction: float = 0.08     # ... e pelo menos esta fração das linhas da banda
    skew_ns: Optional[int] = None                # tempo de leitura do sensor (None = ignora offset por linha)
    readout_top_to_bottom: bool = True
    flicker_ratio: float = 0.5                   # se ΔY(lag 2) < ratio * ΔY(lag 1) na calibração -> lag 2
    flicker_auto: bool = True                    # detectar flicker de 120 Hz (2 quadros por ciclo a 240 FPS)
    gamma: float = 1.0                           # curva de tom a desfazer antes da fração f (1.0 = desligado)

    @property
    def frame_period_ns(self) -> int:
        return NS_PER_SEC // self.frame_rate_hz

    def validate(self) -> None:
        """Janelas coerentes: os quadros voltam depois do bloqueio e a chegada arma depois de voltarem."""
        if self.frame_rate_hz < 1:
            raise ValueError("frame_rate_hz inválido")
        if self.frame_resume_ns < self.start_lockout_ns + 500_000_000:
            raise ValueError("frame_resume_ns precisa ser >= start_lockout_ns + 0,5 s")
        if self.finish_arm_ns < self.frame_resume_ns + 500_000_000:
            raise ValueError("finish_arm_ns precisa ser >= frame_resume_ns + 0,5 s")
        if self.exposure_ns < 1 or self.gamma <= 0.0:
            raise ValueError("exposure_ns/gamma inválidos")


@dataclass(frozen=True)
class RoiRect:
    """Faixa vertical em coordenadas de pixel do plano Y. y1 é exclusivo."""
    x: int
    width: int
    y0: int
    y1: int

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    def core_x0(self, core_width: int) -> int:
        return self.x + (self.width - core_width) // 2

    def validate(self, plane_width: int, plane_height: int, core_width: int) -> None:
        if self.width < 1 or self.height < 1:
            raise ValueError("ROI vazia")
        if self.x < 0 or self.x + self.width > plane_width:
            raise ValueError("ROI fora do plano em x")
        if self.y0 < 0 or self.y1 > plane_height:
            raise ValueError("ROI fora do plano em y")
        if core_width < 1 or core_width > self.width:
            raise ValueError("core_width inválido")


# --------------------------------------------------------------------------- #
# Medição por quadro
# --------------------------------------------------------------------------- #
@dataclass
class FrameMeasurement:
    ts_ns: int
    prev_ts_ns: int            # timestamp do quadro de referência (c - lag), medido
    delta_full: float          # ΔY_f do enunciado (faixa inteira) contra o quadro de referência (lag)
    delta_core: float          # média das colunas centrais (gatilho)
    delta_background: float    # diferença contra a referência de fundo (confirmação)
    strip_prev: List[int]      # faixa inteira (W x H, linha a linha) do quadro de referência (c - lag)
    strip_cur: List[int]       # faixa inteira do quadro atual
    strip_bg: List[float]      # faixa inteira da referência de fundo (da mesma paridade, se lag 2)
    delta_full_lag2: Optional[float] = None   # ΔY contra o quadro c-2 (para detectar flicker); None se indisponível
    lag: int = 1               # atraso de referência usado nesta medição
    # Nos portes nativos as três faixas são REFERÊNCIAS aos buffers rotativos do differencer, válidas
    # só até o próximo process(); o engine copia ao criar o candidato (CrossingInput).


class StripDifferencer:
    """
    Mantém apenas as duas últimas faixas (c-1 e c-2) e as referências de fundo; nunca o quadro
    inteiro. Com `lag == 2` (flicker de 120 Hz a 240 FPS) a comparação é feita com o quadro de
    mesma fase de iluminação e a referência de fundo é separada por paridade do quadro.
    """

    def __init__(self, roi: RoiRect, plane_width: int, plane_height: int, core_width: int):
        roi.validate(plane_width, plane_height, core_width)
        self.roi = roi
        self.core_width = core_width
        self.plane_height = plane_height
        self.lag = 1
        self.prev1: Optional[List[int]] = None            # quadro c-1
        self.prev2: Optional[List[int]] = None            # quadro c-2
        self.prev1_ts = 0
        self.prev2_ts = 0
        self.background: List[Optional[List[float]]] = [None, None]   # por paridade
        self.frame_index = 0                              # quadros processados desde o reset

    def reset(self) -> None:
        self.prev1 = None
        self.prev2 = None
        self.prev1_ts = 0
        self.prev2_ts = 0
        self.background = [None, None]
        self.frame_index = 0

    def set_lag(self, lag: int) -> None:
        new_lag = 2 if lag == 2 else 1
        if new_lag != self.lag:
            # as referências de fundo acumuladas misturam fases de iluminação: ressemear por paridade
            self.background = [None, None]
        self.lag = new_lag

    def _extract(self, plane: bytes, stride: int) -> List[int]:
        r = self.roi
        out: List[int] = []
        for y in range(r.y0, r.y1):
            base = y * stride + r.x
            out.extend(plane[base:base + r.width])
        return out

    def _bg_index(self, frame_index: int) -> int:
        return (frame_index & 1) if self.lag == 2 else 0

    def process(self, plane: bytes, stride: int, ts_ns: int) -> Optional[FrameMeasurement]:
        cur = self._extract(plane, stride)
        idx_frame = self.frame_index
        self.frame_index += 1
        # referência de fundo desta paridade: semeada na primeira ocorrência
        bi = self._bg_index(idx_frame)
        if self.background[bi] is None:
            self.background[bi] = [float(v) for v in cur]
        ref = self.prev1 if self.lag == 1 else self.prev2
        ref_ts = self.prev1_ts if self.lag == 1 else self.prev2_ts
        if ref is None:
            # Quadro-semente: não há medida (1 semente com lag 1, 2 sementes com lag 2).
            self.prev2 = self.prev1
            self.prev2_ts = self.prev1_ts
            self.prev1 = cur
            self.prev1_ts = ts_ns
            return None
        r = self.roi
        w, h, cw = r.width, r.height, self.core_width
        c0 = (w - cw) // 2
        bg = self.background[bi]
        assert bg is not None
        sum_full = 0
        sum_core = 0
        sum_bg = 0.0
        for row in range(h):
            o = row * w
            row_sum_core = 0
            for i in range(w):
                d = cur[o + i] - ref[o + i]
                if d < 0:
                    d = -d
                sum_full += d
                sum_bg += abs(float(cur[o + i]) - bg[o + i])
            for i in range(c0, c0 + cw):
                d = cur[o + i] - ref[o + i]
                if d < 0:
                    d = -d
                row_sum_core += d
            sum_core += row_sum_core
        lag2: Optional[float] = None
        if self.lag == 1 and self.prev2 is not None:
            p2 = self.prev2
            s2 = 0
            for k in range(w * h):
                d = cur[k] - p2[k]
                if d < 0:
                    d = -d
                s2 += d
            lag2 = s2 / (w * h)
        strip_prev = ref
        strip_bg = bg
        self.prev2 = self.prev1
        self.prev2_ts = self.prev1_ts
        self.prev1 = cur
        self.prev1_ts = ts_ns
        return FrameMeasurement(
            ts_ns=ts_ns,
            prev_ts_ns=ref_ts,
            delta_full=sum_full / (w * h),
            delta_core=sum_core / (cw * h),
            delta_background=sum_bg / (w * h),
            strip_prev=strip_prev,
            strip_cur=cur,
            strip_bg=strip_bg,
            delta_full_lag2=lag2,
            lag=self.lag,
        )

    def update_background(self, alpha: float) -> None:
        """EMA lenta da referência de fundo (da paridade do último quadro) com a faixa atual."""
        if self.prev1 is None:
            return
        bi = self._bg_index(self.frame_index - 1)
        bg = self.background[bi]
        if bg is None:
            return
        cur = self.prev1
        for i in range(len(bg)):
            bg[i] = bg[i] + alpha * (float(cur[i]) - bg[i])


# --------------------------------------------------------------------------- #
# Calibração de ruído (Welford)
# --------------------------------------------------------------------------- #
@dataclass
class NoiseStats:
    count: int = 0
    mean: float = 0.0
    m2: float = 0.0

    def add(self, x: float) -> None:
        self.count += 1
        delta = x - self.mean
        self.mean += delta / self.count
        self.m2 += delta * (x - self.mean)

    @property
    def variance(self) -> float:
        return self.m2 / (self.count - 1) if self.count > 1 else 0.0

    @property
    def sigma(self) -> float:
        return math.sqrt(self.variance)


class NoiseCalibrator:
    """Coleta N amostras de ΔY; reinicia em outlier; produz o limiar adaptativo."""

    def __init__(self, cfg: PhotocellConfig):
        self.cfg = cfg
        self.stats = NoiseStats()
        self.retries = 0
        self.threshold: Optional[float] = None
        self.failed = False

    def reset(self) -> None:
        self.stats = NoiseStats()
        self.retries = 0
        self.threshold = None
        self.failed = False

    def add_sample(self, x: float) -> str:
        """Retorna 'collecting', 'restarted', 'done' ou 'failed'."""
        cfg = self.cfg
        if self.threshold is not None or self.failed:
            return "done" if self.threshold is not None else "failed"
        s = self.stats
        if s.count >= cfg.calibration_min_samples_for_outlier:
            if x > s.mean + cfg.calibration_outlier_sigma * s.sigma:
                self.retries += 1
                self.stats = NoiseStats()
                if self.retries > cfg.calibration_max_retries:
                    self.failed = True
                    return "failed"
                return "restarted"
        s.add(x)
        if s.count >= cfg.calibration_samples:
            self.threshold = compute_threshold(cfg, s.mean, s.sigma)
            return "done"
        return "collecting"


def compute_threshold(cfg: PhotocellConfig, mean: float, sigma: float) -> float:
    return max(cfg.threshold_floor, mean + cfg.threshold_sigma_k * sigma,
               cfg.threshold_mean_multiplier * mean)


# --------------------------------------------------------------------------- #
# Estimador sub-quadro: fração de exposição por pixel
# --------------------------------------------------------------------------- #
@dataclass
class CrossingEstimate:
    quality: int            # 0 = sem refinamento; 1 = só limites (janela cega); 2 = pontos interiores
    refined_ts_ns: int
    uncertainty_ns: int
    interior_count: int
    bound_count: int
    lower_ns: Optional[int]
    upper_ns: Optional[int]
    textured_columns: int = 0   # colunas cuja dispersão de tempos excede o ruído (textura/inclinação)


MEAN_ABS_DIFF_TO_SIGMA = 1.1283791670955126   # E|X-Y| = 2*sigma/sqrt(pi) para X,Y ~ N(., sigma)


def _median(values: List[float]) -> float:
    """Mediana deterministica (n par: media dos dois centrais) — mesma definicao em Kotlin/Swift."""
    v = sorted(values)
    n = len(v)
    if n % 2 == 1:
        return v[n // 2]
    return (v[n // 2 - 1] + v[n // 2]) / 2.0


@dataclass
class CrossingInput:
    """Dados do candidato usados pelo estimador (cópias feitas ao criar o candidato)."""
    ts_ns: int                      # quadro candidato c
    prev_ts_ns: int                 # quadro de referência c-lag (medido, não nominal)
    strip_prev: List[int]
    strip_cur: List[int]
    strip_bg: List[float]
    lag: int
    next_ts_ns: Optional[int] = None        # quadro c+lag
    next_strip: Optional[List[int]] = None
    plateau_ts_ns: Optional[int] = None     # quadro c+2·lag (faixa coberta: referência O)
    plateau_strip: Optional[List[int]] = None


def linearize(v: float, gamma: float) -> float:
    """Desfaz a curva de tom (gamma) para que V seja linear em f; gamma == 1 desliga."""
    if gamma == 1.0:
        return v
    if v <= 0.0:
        return 0.0
    return 255.0 * math.pow(v / 255.0, gamma)


def estimate_crossing(cfg: PhotocellConfig, roi: RoiRect, plane_height: int,
                      inp: CrossingInput, noise_sigma_px: float) -> CrossingEstimate:
    """
    Modelo físico: cada pixel integra a luz durante [t_ini, t_ini + E]. Se o bordo do objeto
    (luma O) cobre o pixel (fundo B) no instante t_x dentro dessa janela, o valor medido é
    V = B + (O - B) * f com f = (t_ini + E - t_x) / E  =>  t_x = t_ini + E * (1 - f).

    O bordo se move a velocidade constante, logo t_x(coluna) = t_c + s * dx, onde dx é a
    distância (px) da coluna ao plano central da faixa e s = ±1/v (s/px). Um ajuste linear
    ponderado (peso (O-B)^2) sobre as MEDIANAS por coluna dos pixels "interiores" de TRÊS quadros
    (c-lag, c, c+lag; deslocamentos de tempo MEDIDOS pelos timestamps, não nominais) devolve t_c —
    o instante em que o bordo cruzou o PLANO CENTRAL — e a velocidade, cancelando o viés de direção
    (largada e chegada cruzam a mesma linha em sentidos opostos).

    Passo 1 seleciona os pixels interiores pelo valor OBSERVADO (m < f < 1-m) usando como O o
    platô (quadro c+2·lag). Essa seleção é correlacionada com o sinal do ruído perto dos cortes e
    enviesa a mediana; por isso o passo 2 reseleciona pelo valor PREVISTO pelo ajuste e usa o f
    observado sem corte. No passo 2, O passa a ser LOCAL: a mediana dos pixels da mesma linha e do
    mesmo quadro nas 3 colunas logo atrás do bordo (previstas já cobertas) — em objetos com textura
    (pelagem, sela) o platô 40 px atrás do bordo não representa a luma que cobriu o pixel.

    A incerteza (3 sigma) é propagada do ruído por pixel através do ajuste, usando por coluna o
    MAIOR entre a variância do modelo de ruído e a variância amostral dos tempos (textura,
    inclinação do bordo e outros efeitos não modelados aparecem aí). Colunas cuja dispersão excede
    o que o ruído explica são contadas como "texturizadas". Se a incerteza é pequena (<= P/8) o
    resultado é qualidade 2; senão vira um intervalo (qualidade 1).

    Pixels já cobertos (f >= 1-m) ou ainda descobertos (f <= m) fornecem apenas limites (só as
    colunas centrais). A margem m depende do ruído por pixel medido na calibração; se m for
    grande demais (contraste/ruído baixo) o pixel só serve como limite.

    Se os pontos interiores caem numa única coluna fora do centro (exposição curta e bordo lento),
    a velocidade é desconhecida: o resultado vira um intervalo (qualidade 1) usando a faixa
    plausível de velocidades e o sentido inferido das colunas já cobertas.
    """
    P = cfg.frame_period_ns
    # Sem refinamento possível, a melhor estimativa é o meio da janela de exposição da banda
    # (offset das linhas, se o skew é conhecido, + E/2); a incerteza continua ±P/2.
    mid_row_offset = 0
    if cfg.skew_ns is not None:
        mid_row_offset = ((roi.y0 + roi.height // 2) * cfg.skew_ns) // plane_height
    none = CrossingEstimate(0, inp.ts_ns + mid_row_offset + cfg.exposure_ns // 2, P // 2, 0, 0, None, None, 0)
    n = len(inp.strip_cur)
    plateau_strip = inp.plateau_strip
    if n == 0 or plateau_strip is None or len(plateau_strip) != n \
            or len(inp.strip_prev) != n or len(inp.strip_bg) != n:
        return none
    h, w = roi.height, roi.width
    if w * h != n:
        return none
    E = float(cfg.exposure_ns)
    gamma = cfg.gamma
    k_sig = cfg.fraction_margin_sigmas
    noise_term = k_sig * math.sqrt(2.0) * noise_sigma_px
    center = (w - 1) / 2.0
    frames: List[Tuple[List[int], float]] = [(inp.strip_prev, float(inp.prev_ts_ns - inp.ts_ns)),
                                             (inp.strip_cur, 0.0)]
    if inp.next_strip is not None and len(inp.next_strip) == n and inp.next_ts_ns is not None:
        frames.append((inp.next_strip, float(inp.next_ts_ns - inp.ts_ns)))
    s_min = 1e9 / cfg.speed_px_per_s_max     # ns por px (bordo rápido)
    s_max = 1e9 / cfg.speed_px_per_s_min     # ns por px (bordo lento)
    min_rows = max(1, cfg.min_interior_rows_per_column, int(math.ceil(cfg.min_interior_rows_fraction * h)))
    unc_floor = max(1, int(E) // 50)
    unc_q2_max = P // 8                      # acima disso o ajuste vira intervalo (qualidade 1)

    def row_time(row: int) -> int:
        if cfg.skew_ns is not None:
            return inp.ts_ns + ((roi.y0 + row) * cfg.skew_ns) // plane_height
        return inp.ts_ns

    # fundo e platô linearizados uma vez
    bg_lin: List[float] = [linearize(v, gamma) for v in inp.strip_bg]
    plateau_lin: List[float] = [linearize(float(v), gamma) for v in plateau_strip]
    # Textura do objeto: variancia espacial do plato ao longo das colunas (mediana das linhas), alem
    # do ruido. Uma luma O incerta em A_tex desloca t em ate E*A_tex/C de forma COERENTE entre as
    # linhas (nao cai com sqrt(n)): entra como variancia adicional por coluna.
    row_vars: List[float] = []
    for row in range(h):
        o = row * w
        mean_p = 0.0
        for i in range(w):
            mean_p += plateau_lin[o + i]
        mean_p = mean_p / float(w)
        ss_p = 0.0
        for i in range(w):
            d = plateau_lin[o + i] - mean_p
            ss_p += d * d
        row_vars.append(ss_p / float(w))
    tex_var_px = _median(row_vars) - noise_sigma_px * noise_sigma_px
    a_tex = math.sqrt(tex_var_px) if tex_var_px > 0.0 else 0.0
    # A textura tambem limita a classificacao coberto/interior de cada pixel: a margem passa a ser o
    # maior entre o ruido (k*sqrt2*sigma) e o pico da textura (~1,5*a_tex); com margem > maxima o pixel
    # so da limites, e >= 0,5 nao serve nem para isso (resultado honesto: tempo do quadro).
    tex_term = 1.5 * a_tex
    margin_term = noise_term if noise_term >= tex_term else tex_term

    interior = 0
    bounds = 0
    lower: Optional[float] = None
    upper: Optional[float] = None
    covered_cols_cand: set = set()      # colunas já cobertas no quadro candidato (f1 >= hi)

    # ---- passo 1: seleção pelo valor observado + limites ------------------------------------
    col_sum_w: Dict[int, float] = {}
    col_times: Dict[int, List[float]] = {}   # tempos t_x por coluna (mediana resiste a pixels espurios)
    col_s2: Dict[int, float] = {}            # soma das variancias de t por pixel (ruido -> tempo)
    col_n: Dict[int, int] = {}
    for row in range(h):
        t_row = row_time(row)
        for i in range(w):
            idx = row * w + i
            B = bg_lin[idx]
            O = plateau_lin[idx]
            contrast = O - B
            C = contrast if contrast >= 0.0 else -contrast
            if C < cfg.min_contrast:
                continue
            dx = i - center
            # Limites só da coluna central (dx = 0): em outra coluna o limite valeria para t_x(dx),
            # não para t_c, e a diferença dx·s é desconhecida. Com largura par (dx = ±0,5) aplica-se
            # uma folga de |dx|·s_max.
            is_center_col = abs(dx) <= 0.5
            center_slack = abs(dx) * s_max
            m = margin_term / C
            if m < cfg.fraction_margin_min:
                m = cfg.fraction_margin_min
            if m >= 0.5:
                continue
            usable_interior = m <= cfg.fraction_margin_max
            lo, hi = m, 1.0 - m
            # Limites: f_obs >= 1-m com ruido ate m implica f >= 1-2m, logo t_x <= t_ini + 2mE
            # (e simetricamente t_x >= t_ini + E(1-2m) para f_obs <= m).
            up_off = E * 2.0 * m
            lo_off = E * (1.0 - 2.0 * m)
            wgt = contrast * contrast
            st = E * m / k_sig                # sigma de t deste pixel (E * sqrt2 * sigma_px / C)
            for k, (strip, t_off) in enumerate(frames):
                f = (linearize(float(strip[idx]), gamma) - B) / contrast
                t_ini = float(t_row) + t_off
                if lo < f < hi:
                    if usable_interior:
                        t = t_ini + E * (1.0 - f)
                        col_sum_w[i] = col_sum_w.get(i, 0.0) + wgt
                        col_times.setdefault(i, []).append(t)
                        col_s2[i] = col_s2.get(i, 0.0) + st * st
                        col_n[i] = col_n.get(i, 0) + 1
                        interior += 1
                elif f >= hi:
                    if k == 1:
                        covered_cols_cand.add(i)
                    if is_center_col:
                        bounds += 1
                        u = t_ini + up_off + center_slack
                        if upper is None or u < upper:
                            upper = u
                elif f <= lo:
                    if is_center_col:
                        bounds += 1
                        lw = t_ini + lo_off - center_slack
                        if lower is None or lw > lower:
                            lower = lw
    lower_i = None if lower is None else int(math.floor(lower + 0.5))
    upper_i = None if upper is None else int(math.floor(upper + 0.5))
    textured_cols = 0

    def interval_result(lo_ns: Optional[int], hi_ns: Optional[int], quality: int) -> Optional[CrossingEstimate]:
        if lo_ns is None or hi_ns is None:
            return None
        if lo_ns > hi_ns:
            # limites contraditorios (classificacao corrompida, p.ex. textura): sem informacao honesta
            return None
        a, b = lo_ns, hi_ns
        if (b - a) // 2 > P // 2:
            # intervalo pior que a incerteza do próprio quadro: não ajuda
            return None
        mid = (a + b) // 2
        return CrossingEstimate(quality, mid, (b - a) // 2, interior, bounds, a, b, textured_cols)

    def fitted_result(t_est: float, var_t: float) -> Optional[CrossingEstimate]:
        """Qualidade 2 se a incerteza (3 sigma) propagada do ajuste e pequena; senao intervalo."""
        unc = int(math.floor(3.0 * math.sqrt(var_t) + 0.5))
        if unc < unc_floor:
            unc = unc_floor
        refined = int(math.floor(t_est + 0.5))
        if unc <= unc_q2_max:
            return CrossingEstimate(2, refined, unc, interior, bounds, lower_i, upper_i, textured_cols)
        a0, b0 = refined - unc, refined + unc
        a, b = a0, b0
        if lower_i is not None and lower_i > a:
            a = lower_i
        if upper_i is not None and upper_i < b:
            b = upper_i
        if a > b:
            a, b = a0, b0
        return interval_result(a, b, 1)

    def column_stats(sum_w: Dict[int, float], times: Dict[int, List[float]], s2: Dict[int, float],
                     cnt: Dict[int, int]) -> Tuple[List[int], Dict[int, float], Dict[int, float], int, Dict[int, float]]:
        """
        Colunas confiáveis (>= min_rows pixels), mediana, variância da mediana por coluna, número de
        colunas "texturizadas" (dispersão dos tempos maior do que o ruído explica) e contraste RMS.
        """
        good = sorted(c for c in sum_w if cnt.get(c, 0) >= min_rows)
        # Tempo por coluna = MEDIANA dos t_x dos pixels interiores: um unico pixel saturado que o ruido
        # classificou como interior (erro ~P) nao desloca a coluna, ao contrario da media ponderada.
        col_t = {c: _median(times[c]) for c in times}
        col_var: Dict[int, float] = {}
        col_crms: Dict[int, float] = {}
        textured = 0
        for c in sorted(times):
            nc = cnt[c]
            fn = float(nc)
            # variancia da mediana da coluna ~ (pi/2) * variancia da media (modelo de ruido)
            var_model = (math.pi / 2.0) * s2[c] / (fn * fn)
            # variancia amostral dos tempos da coluna (dois passos, ordem de insercao)
            ts_list = times[c]
            mean = 0.0
            for t in ts_list:
                mean += t
            mean = mean / fn
            ss = 0.0
            for t in ts_list:
                d = t - mean
                ss += d * d
            var_s = ss / (fn - 1.0) if nc >= 2 else 0.0
            var_emp = (math.pi / 2.0) * var_s / fn
            col_var[c] = var_model if var_model >= var_emp else var_emp
            # contraste RMS da coluna (sum_w = soma de contrast^2), para o termo coerente de textura
            col_crms[c] = math.sqrt(sum_w[c] / fn)
            if nc >= min_rows:
                sigma_model_px = math.sqrt(s2[c] / fn)
                if math.sqrt(var_s) > 3.0 * sigma_model_px + E / 10.0:
                    textured += 1
        return good, col_t, col_var, textured, col_crms

    def tex_var(crms: float) -> float:
        """Variancia COERENTE (nao cai com o numero de pixels/colunas) de t causada pela textura do objeto."""
        t_tex = E * a_tex / crms
        return t_tex * t_tex

    def fit_line(good: List[int], sum_w: Dict[int, float], col_t: Dict[int, float],
                 col_var: Dict[int, float], textured: int,
                 col_crms: Dict[int, float]) -> Optional[Tuple[float, float, float]]:
        """
        Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
        fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou None.
        """
        fit_cols = list(good)
        for _ in range(3):
            gw = gx = gt = gxx = gxt = 0.0
            for c in fit_cols:
                wc = sum_w[c]
                tc = col_t[c]
                dxc = c - center
                gw += wc; gx += wc * dxc; gt += wc * tc; gxx += wc * dxc * dxc; gxt += wc * dxc * tc
            spread = fit_cols[-1] - fit_cols[0]
            denom = gw * gxx - gx * gx
            if not (spread >= 1 and denom > 1e-9 * gw * gxx and denom > 0.0):
                return None
            slope = (gw * gxt - gx * gt) / denom
            t_c = (gt - slope * gx) / gw
            worst = None
            worst_res = 0.0
            for c in fit_cols:
                res = abs(col_t[c] - (t_c + slope * (c - center)))
                if res > worst_res:
                    worst_res = res
                    worst = c
            if worst is not None and worst_res > E + P / 4.0 and len(fit_cols) > 2:
                fit_cols.remove(worst)
                continue
            if worst_res <= E + P / 4.0 and s_min <= abs(slope) <= s_max:
                # propagacao: t_c = sum_c a_c * t_col(c), a_c = w_c/gw - gx*w_c*(gw*dx_c - gx)/(denom*gw)
                var_t = 0.0
                chi2 = 0.0
                res_ss = 0.0
                for c in fit_cols:
                    wc = sum_w[c]
                    dxc = c - center
                    a_c = wc / gw - gx * wc * (gw * dxc - gx) / (denom * gw)
                    var_t += a_c * a_c * col_var[c]
                    res = col_t[c] - (t_c + slope * dxc)
                    chi2 += res * res / col_var[c] if col_var[c] > 0.0 else 0.0
                    res_ss += res * res
                # residuos entre colunas maiores do que as variancias explicam (textura, inclinacao):
                # escala a variancia pelo chi-quadrado reduzido
                dof = len(fit_cols) - 2
                if dof >= 1:
                    chi2r = chi2 / float(dof)
                    if chi2r > 1.0:
                        var_t = var_t * chi2r
                # com colunas texturizadas os erros sao COERENTES (nao caem com o numero de colunas):
                # a incerteza nao pode ser menor que a dispersao residual entre colunas
                if textured > 0:
                    res_ms2 = res_ss / float(len(fit_cols))
                    if res_ms2 > var_t:
                        var_t = res_ms2
                # textura do objeto: erro coerente, somado DEPOIS da propagacao (nao e reduzido pelo ajuste)
                crms = 0.0
                for c in fit_cols:
                    crms += col_crms[c]
                crms = crms / float(len(fit_cols))
                var_t += tex_var(crms)
                return t_c, slope, var_t
            return None
        return None

    good_cols, col_t, col_var, textured_cols, col_crms = column_stats(col_sum_w, col_times, col_s2, col_n)
    if textured_cols > 0 or tex_term > noise_term:
        # os limites foram classificados com o plato como O: com textura (detectada no plato ou na
        # dispersao das colunas) nao sao confiaveis
        lower_i = None
        upper_i = None
    if good_cols:
        fit = fit_line(good_cols, col_sum_w, col_t, col_var, textured_cols, col_crms)
        # ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO, O local ------------------
        for _ in range(2):
            if fit is None:
                break
            t_c1, slope1, _v = fit
            behind = -1 if slope1 > 0.0 else 1     # bordo vindo da esquerda (s > 0): atras = colunas menores
            sum_w2: Dict[int, float] = {}
            times2: Dict[int, List[float]] = {}
            s2_2: Dict[int, float] = {}
            n2: Dict[int, int] = {}
            for row in range(h):
                t_row = row_time(row)
                for i in range(w):
                    idx = row * w + i
                    B = bg_lin[idx]
                    t_pred = t_c1 + slope1 * (i - center)
                    for strip, t_off in frames:
                        t_ini = float(t_row) + t_off
                        f_pred = (t_ini + E - t_pred) / E
                        if not (0.0 < f_pred < 1.0):
                            continue
                        # O local: mediana das ate 3 colunas logo atras do bordo, mesma linha e quadro,
                        # previstas totalmente cobertas (t_x(j) <= t_ini); senao o plato.
                        neigh: List[float] = []
                        for d in (1, 2, 3):
                            j = i + behind * d
                            if j < 0 or j >= w:
                                break
                            t_pred_j = t_c1 + slope1 * (j - center)
                            if t_pred_j > t_ini:
                                continue
                            # vizinho tem de estar coberto tambem na OBSERVACAO (o bordo pode estar
                            # inclinado: a previsao e a media das linhas)
                            vj = linearize(float(strip[row * w + j]), gamma)
                            Bj = bg_lin[row * w + j]
                            Cj = plateau_lin[row * w + j] - Bj
                            if Cj == 0.0:
                                continue
                            mj = margin_term / (Cj if Cj >= 0.0 else -Cj)
                            if mj < cfg.fraction_margin_min:
                                mj = cfg.fraction_margin_min
                            if (vj - Bj) / Cj >= 1.0 - mj:
                                neigh.append(vj)
                        O = _median(neigh) if neigh else plateau_lin[idx]
                        contrast = O - B
                        C = contrast if contrast >= 0.0 else -contrast
                        if C < cfg.min_contrast:
                            continue
                        m = margin_term / C
                        if m < cfg.fraction_margin_min:
                            m = cfg.fraction_margin_min
                        if m > cfg.fraction_margin_max:
                            continue
                        if not (m < f_pred < 1.0 - m):
                            continue
                        f = (linearize(float(strip[idx]), gamma) - B) / contrast
                        t = t_ini + E * (1.0 - f)
                        wgt = contrast * contrast
                        st = E * m / k_sig
                        sum_w2[i] = sum_w2.get(i, 0.0) + wgt
                        times2.setdefault(i, []).append(t)
                        s2_2[i] = s2_2.get(i, 0.0) + st * st
                        n2[i] = n2.get(i, 0) + 1
            good2, col_t2, col_var2, textured2, col_crms2 = column_stats(sum_w2, times2, s2_2, n2)
            fit2 = fit_line(good2, sum_w2, col_t2, col_var2, textured2, col_crms2) if good2 else None
            if fit2 is None:
                break
            fit = fit2
            textured_cols = textured2
        if fit is not None:
            r = fitted_result(fit[0], fit[2])
            if r is not None:
                return r
        # uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
        col = max(good_cols, key=lambda c: col_sum_w[c])
        dx0 = col - center
        t_int = col_t[col]
        if abs(dx0) < 0.5:
            r = fitted_result(t_int, col_var[col] + tex_var(col_crms[col]))
            if r is not None:
                return r
        # sentido: colunas já cobertas no candidato ficam do lado de onde o bordo veio
        left_cov = any(c < col for c in covered_cols_cand)
        right_cov = any(c > col for c in covered_cols_cand)
        cands: List[float] = []
        if left_cov or not right_cov:
            cands += [t_int - dx0 * s_min, t_int - dx0 * s_max]     # bordo vindo da esquerda (s > 0)
        if right_cov or not left_cov:
            cands += [t_int + dx0 * s_min, t_int + dx0 * s_max]     # bordo vindo da direita (s < 0)
        # incerteza da coluna: o maior entre ±E·m/sqrt(n) (ruído por pixel) e 3 sigma da variância da
        # coluna (inclui textura/dispersão amostral)
        m_col = noise_term / max(cfg.min_contrast, 1.0)
        col_unc = E * min(m_col, 0.5) / math.sqrt(max(1, col_n.get(col, 1)))
        col_unc3 = 3.0 * math.sqrt(col_var[col] + tex_var(col_crms[col]))
        if col_unc3 > col_unc:
            col_unc = col_unc3
        a0 = int(math.floor(min(cands) - col_unc + 0.5))
        b0 = int(math.floor(max(cands) + col_unc + 0.5))
        a, b = a0, b0
        if lower_i is not None and lower_i > a:
            a = lower_i
        if upper_i is not None and upper_i < b:
            b = upper_i
        if a > b:
            # limites inconsistentes com a coluna interior (ruído): fica só com a faixa de velocidades
            a, b = a0, b0
        r = interval_result(a, b, 1)
        if r is not None:
            return r
    r = interval_result(lower_i, upper_i, 1)
    return r if r is not None else none


# --------------------------------------------------------------------------- #
# Máquina de estados / engine
# --------------------------------------------------------------------------- #
IDLE = "idle"
CALIBRATING = "calibrating"
ARMED = "armed"
CONFIRMING_START = "confirmingStart"
DEBOUNCE_START = "debounceStart"
RUNNING = "running"
AWAITING_FINISH = "awaitingFinish"
CONFIRMING_FINISH = "confirmingFinish"
DEBOUNCE_FINISH = "debounceFinish"
FINISHED = "finished"
ERROR = "error"

ACTIVE_STATES = {ARMED, CONFIRMING_START, DEBOUNCE_START, RUNNING,
                 AWAITING_FINISH, CONFIRMING_FINISH, DEBOUNCE_FINISH}


@dataclass
class TriggerInfo:
    raw_ts_ns: int
    refined_ts_ns: int
    quality: int
    uncertainty_ns: int
    interior_count: int
    degraded: bool
    textured_columns: int = 0


@dataclass
class RunResult:
    start: TriggerInfo
    finish: TriggerInfo
    elapsed_raw_ns: int
    elapsed_refined_ns: int
    drops: int
    degraded: bool
    threshold_start: float
    threshold_finish: float


@dataclass
class Candidate:
    inp: CrossingInput          # cópias das faixas do candidato (os buffers do differencer rotacionam)
    seen: int = 0
    confirmed: int = 0
    degraded: bool = False


class PhotocellEngine:
    """
    Dono único da FSM. Eventos: user_calibrate, user_arm, user_reset, frame(m|None),
    wakeup(now), capture_interrupted. Efeitos (strings) acumulados em self.effects:
      setFrameDelivery:true|false, resetDifferencer, updateBackground, scheduleWakeup:<ns>,
      cancelWakeups, feedback:start|finish, publish
    """

    def __init__(self, cfg: PhotocellConfig, roi: RoiRect, plane_height: int):
        cfg.validate()
        self.cfg = cfg
        self.roi = roi
        self.plane_height = plane_height
        self.state = IDLE
        self.error_reason: Optional[str] = None
        self.calibrator = NoiseCalibrator(cfg)
        self.calibrator_lag2 = NoiseCalibrator(cfg)
        self.lag = 1
        self.threshold: Optional[float] = None
        self.after_calibration = IDLE
        self.candidate: Optional[Candidate] = None
        self.start: Optional[TriggerInfo] = None
        self.finish: Optional[TriggerInfo] = None
        self.result: Optional[RunResult] = None
        self.threshold_start: float = 0.0
        self.noise_sigma_px: float = 0.0
        self.wakeups: List[int] = []
        self.last_frame_ts: Optional[int] = None
        self.drops = 0
        self.last_drop_ts: Optional[int] = None
        self.drop_pending = False     # a plataforma avisou de quadros perdidos sem timestamp
        self.effects: List[str] = []
        self.transitions: List[str] = []

    # --- utilitários -------------------------------------------------------
    def _emit(self, e: str) -> None:
        self.effects.append(e)

    def _go(self, state: str) -> None:
        self.state = state
        self.transitions.append(state)
        self._emit("publish")

    def _schedule(self, at_ns: int) -> None:
        self.wakeups.append(at_ns)
        self.wakeups.sort()
        self._emit(f"scheduleWakeup:{at_ns}")

    def _cancel_wakeups(self) -> None:
        self.wakeups = []
        self._emit("cancelWakeups")

    def _process_deadlines(self, now_ns: int) -> None:
        while self.wakeups and self.wakeups[0] <= now_ns:
            at = self.wakeups.pop(0)
            self._on_deadline(at)

    # --- eventos do usuário --------------------------------------------------
    def user_calibrate(self) -> None:
        if self.state in (IDLE, FINISHED, ERROR, ARMED):
            self._begin_calibration(IDLE)

    def user_arm(self) -> None:
        if self.state in (IDLE, FINISHED):
            self._begin_calibration(ARMED)

    def user_reset(self) -> None:
        self._cancel_wakeups()
        self._emit("setFrameDelivery:false")
        if self.lag != 1:
            self.lag = 1
            self._emit("setReferenceLag:1")
        self.candidate = None
        self.start = None
        self.finish = None
        self.result = None
        self.error_reason = None
        self.drops = 0
        self.last_drop_ts = None
        self.drop_pending = False
        self.last_frame_ts = None
        self._go(IDLE)

    def capture_interrupted(self) -> None:
        if self.state in ACTIVE_STATES or self.state == CALIBRATING:
            self._fail("captureInterrupted")

    def frames_dropped(self) -> None:
        """
        A plataforma soube de quadros perdidos (TN2445 'Discontinuity', ImageReader estourado) sem
        conhecer os timestamps: o candidato em confirmação perde a base de tempo e é descartado, o
        próximo quadro conta como drop (passada 'degradada' se estiver perto do gatilho) e a
        referência do differencer é ressemeada.
        """
        self.drops += 1
        self.drop_pending = True
        self.last_frame_ts = None
        if self.state == CONFIRMING_START:
            self.candidate = None
            self._go(ARMED)
        elif self.state == CONFIRMING_FINISH:
            self.candidate = None
            self._go(AWAITING_FINISH)
        if self.state in (CALIBRATING, ARMED, AWAITING_FINISH):
            self._emit("resetDifferencer")

    def _fail(self, reason: str) -> None:
        self._cancel_wakeups()
        self._emit("setFrameDelivery:false")
        self.candidate = None
        self.error_reason = reason
        self._go(ERROR)

    def _begin_calibration(self, next_state: str) -> None:
        self.after_calibration = next_state
        self.calibrator.reset()
        self.calibrator_lag2.reset()
        self.candidate = None
        self.last_frame_ts = None
        if self.lag != 1:
            self.lag = 1
            self._emit("setReferenceLag:1")
        self._emit("setFrameDelivery:true")
        self._emit("resetDifferencer")
        self._go(CALIBRATING)

    # --- tempo ----------------------------------------------------------------
    def wakeup(self, now_ns: int) -> None:
        self._process_deadlines(now_ns)

    def _on_deadline(self, at_ns: int) -> None:
        assert self.start is not None
        s = self.start.raw_ts_ns
        cfg = self.cfg
        if self.state == DEBOUNCE_START and at_ns == s + cfg.start_lockout_ns:
            self._go(RUNNING)
        elif self.state in (RUNNING, AWAITING_FINISH) and at_ns == s + cfg.frame_resume_ns:
            # retomada dos quadros (também vale se a chegada já foi armada antes, por configuração)
            self.last_frame_ts = None
            self._emit("setFrameDelivery:true")
            self._emit("resetDifferencer")
        elif self.state == RUNNING and at_ns == s + cfg.finish_arm_ns:
            self.candidate = None
            self._go(AWAITING_FINISH)
        elif self.state == DEBOUNCE_FINISH and self.finish is not None \
                and at_ns == self.finish.raw_ts_ns + cfg.finish_lockout_ns:
            self._finish_run()

    # --- quadros ---------------------------------------------------------------
    def frame(self, m: Optional[FrameMeasurement], ts_ns: Optional[int] = None) -> None:
        """m == None significa quadro-semente (o differencer acabou de ressemear)."""
        ts = m.ts_ns if m is not None else ts_ns
        if ts is not None:
            self._track_gaps(ts)
            self._process_deadlines(ts)
        if m is None:
            return
        st = self.state
        if st == CALIBRATING:
            self._calibration_frame(m)
        elif st == ARMED:
            self._armed_frame(m, CONFIRMING_START)
        elif st == CONFIRMING_START:
            self._confirming_frame(m, ARMED, is_start=True)
        elif st == AWAITING_FINISH:
            self._armed_frame(m, CONFIRMING_FINISH)
        elif st == CONFIRMING_FINISH:
            self._confirming_frame(m, AWAITING_FINISH, is_start=False)
        else:
            # RUNNING (após retomada), DEBOUNCE_*, FINISHED, IDLE, ERROR: ignorar.
            return

    def _track_gaps(self, ts_ns: int) -> None:
        cfg = self.cfg
        if self.drop_pending:
            self.drop_pending = False
            self.last_drop_ts = ts_ns
        if self.last_frame_ts is not None:
            gap = ts_ns - self.last_frame_ts
            if gap > cfg.drop_gap_factor * cfg.frame_period_ns:
                missed = int(math.floor(gap / cfg.frame_period_ns + 0.5)) - 1
                if missed > 0:
                    self.drops += missed
                    self.last_drop_ts = ts_ns
        self.last_frame_ts = ts_ns

    def _calibration_frame(self, m: FrameMeasurement) -> None:
        cfg = self.cfg
        if m.delta_full_lag2 is not None:
            self.calibrator_lag2.add_sample(m.delta_full_lag2)
        r = self.calibrator.add_sample(m.delta_full)
        if r == "restarted":
            # as duas janelas precisam cobrir as mesmas amostras para a decisão de flicker valer
            self.calibrator_lag2.reset()
        if r == "done":
            stats = self.calibrator.stats
            threshold = self.calibrator.threshold
            s2 = self.calibrator_lag2.stats
            if cfg.flicker_auto and s2.count >= cfg.calibration_samples - 1 \
                    and s2.mean < cfg.flicker_ratio * stats.mean:
                stats = s2
                threshold = compute_threshold(cfg, s2.mean, s2.sigma)
                self.lag = 2
                self._emit("setReferenceLag:2")
            self.threshold = threshold
            self.noise_sigma_px = stats.mean / MEAN_ABS_DIFF_TO_SIGMA
            self._emit("updateBackground")
            self._go(self.after_calibration)
        elif r == "failed":
            self._fail("calibrationUnstable")

    def _armed_frame(self, m: FrameMeasurement, confirming_state: str) -> None:
        assert self.threshold is not None
        if m.delta_core > self.threshold:
            degraded = self.last_drop_ts is not None and \
                abs(m.ts_ns - self.last_drop_ts) < self.cfg.degraded_drop_window_ns
            inp = CrossingInput(ts_ns=m.ts_ns, prev_ts_ns=m.prev_ts_ns, strip_prev=list(m.strip_prev),
                                strip_cur=list(m.strip_cur), strip_bg=list(m.strip_bg), lag=m.lag)
            self.candidate = Candidate(inp=inp, degraded=degraded)
            self._go(confirming_state)
        elif m.delta_full <= self.threshold:
            self._emit("updateBackground")

    def _confirming_frame(self, m: FrameMeasurement, back_state: str, is_start: bool) -> None:
        cfg = self.cfg
        c = self.candidate
        assert c is not None and self.threshold is not None
        c.seen += 1
        if c.seen == self.lag:
            c.inp.next_strip = list(m.strip_cur)
            c.inp.next_ts_ns = m.ts_ns
        if c.seen == 2 * self.lag:
            c.inp.plateau_strip = list(m.strip_cur)
            c.inp.plateau_ts_ns = m.ts_ns
        if m.delta_background > self.threshold * cfg.background_threshold_multiplier:
            c.confirmed += 1
        if c.confirmed >= cfg.confirm_required and c.seen >= 2 * self.lag:
            est = estimate_crossing(cfg, self.roi, self.plane_height, c.inp, self.noise_sigma_px)
            info = TriggerInfo(raw_ts_ns=c.inp.ts_ns, refined_ts_ns=est.refined_ts_ns,
                               quality=est.quality, uncertainty_ns=est.uncertainty_ns,
                               interior_count=est.interior_count, degraded=c.degraded,
                               textured_columns=est.textured_columns)
            self.candidate = None
            if is_start:
                self._trigger_start(info)
            else:
                self._trigger_finish(info)
        elif c.seen >= cfg.confirm_window:
            self.candidate = None
            self._go(back_state)

    def _trigger_start(self, info: TriggerInfo) -> None:
        cfg = self.cfg
        self.start = info
        self.threshold_start = self.threshold or 0.0
        self._emit("feedback:start")
        self._emit("setFrameDelivery:false")
        self._go(DEBOUNCE_START)
        s = info.raw_ts_ns
        self._schedule(s + cfg.start_lockout_ns)
        self._schedule(s + cfg.frame_resume_ns)
        self._schedule(s + cfg.finish_arm_ns)

    def _trigger_finish(self, info: TriggerInfo) -> None:
        cfg = self.cfg
        self.finish = info
        self._emit("feedback:finish")
        self._emit("setFrameDelivery:false")
        self._go(DEBOUNCE_FINISH)
        self._schedule(info.raw_ts_ns + cfg.finish_lockout_ns)

    def _finish_run(self) -> None:
        assert self.start is not None and self.finish is not None
        s, f = self.start, self.finish
        self.result = RunResult(
            start=s, finish=f,
            elapsed_raw_ns=f.raw_ts_ns - s.raw_ts_ns,
            elapsed_refined_ns=f.refined_ts_ns - s.refined_ts_ns,
            drops=self.drops,
            degraded=s.degraded or f.degraded,
            threshold_start=self.threshold_start,
            threshold_finish=self.threshold or 0.0,
        )
        self._go(FINISHED)


def format_elapsed(ns: int) -> str:
    """nanos -> 'SS.mmm' (arredondamento half-up para milésimos). Negativo vira '0.000'."""
    if ns < 0:
        ns = 0
    ms = (ns + 500_000) // 1_000_000
    return f"{ms // 1000}.{ms % 1000:03d}"
