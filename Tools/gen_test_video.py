#!/usr/bin/env python3
"""
Gera um VÍDEO sintético de uma prova completa, para testar a versão web ponta a ponta.

    python3 Tools/gen_test_video.py --out /tmp/prova.webm

A física é a mesma do simulador dos vetores: um objeto de bordo vertical cruza a faixa a velocidade
constante, cada pixel INTEGRA a luz durante a exposição (é daí que sai o refinamento sub-quadro), há
ruído de sensor e curva de tom. A diferença é que aqui o resultado vira um arquivo de vídeo de 240
FPS — o mesmo que o iPhone entrega em câmera lenta — para o app web ler com o próprio navegador.

Imprime a VERDADE (instantes de cruzamento e ΔT) em JSON, que o teste compara com o que o app mediu.
"""
import argparse
import json
import math
import os
import subprocess
import sys

NS = 1_000_000_000


class Rng:
    """Gerador determinístico (mesmo algoritmo do simulador dos vetores)."""

    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFF or 1

    def next_u32(self) -> int:
        x = self.s
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        self.s = x & 0xFFFFFFFF
        return self.s

    def gauss(self, sigma: float) -> float:
        u1 = (self.next_u32() + 1) / 4294967297.0
        u2 = (self.next_u32() + 1) / 4294967297.0
        return sigma * math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


class Passagem:
    """Uma passagem do objeto: barra vertical de `largura` px cruzando a `t_cross` no centro."""

    def __init__(self, t_cross_ns: int, v_px_por_ns: float, direcao: int, largura_px: float):
        self.t = t_cross_ns
        self.v = v_px_por_ns
        self.d = direcao
        self.largura = largura_px

    def borda_dianteira(self, t_ns: float, xc: float) -> float:
        """Posição da borda que dispara o gatilho, no instante t."""
        return xc + self.d * self.v * (t_ns - self.t)

    def cobre(self, x: float, t_ns: float, xc: float) -> bool:
        frente = self.borda_dianteira(t_ns, xc)
        # a barra ocupa [frente - largura, frente] no sentido do movimento
        return (frente - self.largura <= x <= frente) if self.d > 0 else (frente <= x <= frente + self.largura)


def render(args) -> dict:
    import numpy as np

    W, H = args.width, args.height
    xc = (W - 1) / 2.0
    v = args.speed / NS                     # px por ns
    periodo = NS // args.fps
    E = int(args.exposure_frac * periodo)   # exposição
    rng = np.random.default_rng(args.seed)

    passagens = [
        Passagem(int(args.start_s * NS), v, +1, args.object_px),
        Passagem(int(args.finish_s * NS), v, -1, args.object_px),
    ]
    n_frames = int(args.duration_s * args.fps)
    linha_a, linha_b = int(H * 0.20), int(H * 0.80)   # o objeto cobre a banda inteira

    # fundo com padrão espacial fixo (o mesmo estilo do simulador dos vetores)
    ys = np.arange(H).reshape(H, 1)
    xs = np.arange(W).reshape(1, W)
    base = (args.bg + (ys * 3) % 7 + (xs * 7) % 11).astype(np.float64)
    dentro = ((ys >= linha_a) & (ys <= linha_b)).astype(np.float64)     # (H,1)

    sub_t, sub_x = 8, 4       # amostras no tempo (exposição) e dentro do pixel (abertura de 1 px)
    dt = (np.arange(sub_t) + 0.5) * E / sub_t
    dx = -0.5 + (np.arange(sub_x) + 0.5) / sub_x
    xx = np.arange(W).reshape(W, 1) + dx.reshape(1, sub_x)              # (W, sub_x)

    # MP4 com VP9 sem perdas: o MP4 é o mesmo tipo de contêiner do .MOV do iPhone (o demuxer do app
    # é o mesmo), e o VP9 é o codec sem perdas que o Chromium desta máquina decodifica — o H.264 e o
    # HEVC do iPhone só existem no aparelho, e é lá que essa parte se confirma.
    codec = ["-c:v", "libvpx-vp9", "-lossless", "1", "-cpu-used", "4", "-row-mt", "1", "-threads", "4"]
    if args.out.endswith(".webm"):
        codec = ["-c:v", "libvpx", "-lossless", "1", "-cpu-used", "5", "-threads", "4"]
    proc = subprocess.Popen(
        [args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(args.fps), "-i", "pipe:0",
         *codec, "-pix_fmt", "yuv420p", "-color_range", "pc",
         "-vf", "scale=in_range=full:out_range=full",
         "-video_track_timescale", str(args.fps * 100), args.out],
        stdin=subprocess.PIPE)
    assert proc.stdin is not None

    for i in range(n_frames):
        t0 = i * periodo
        # fração coberta de cada coluna, integrando a exposição no tempo e a abertura no espaço
        cob = np.zeros((W, sub_x), dtype=np.float64)
        for t in t0 + dt:
            for p in passagens:
                frente = p.borda_dianteira(t, xc)
                if p.d > 0:
                    cob += (xx >= frente - p.largura) & (xx <= frente)
                else:
                    cob += (xx >= frente) & (xx <= frente + p.largura)
        frac = np.clip(cob.mean(axis=1) / sub_t, 0.0, 1.0).reshape(1, W)   # (1,W)

        lin = base + (args.obj - base) * (frac * dentro)
        # curva de tom da câmera (o app desfaz com gamma 2.2 antes de calcular a fração)
        val = 255.0 * np.power(np.clip(lin, 0.0, None) / 255.0, 1.0 / args.gamma)
        val += rng.normal(0.0, args.noise, size=val.shape)
        quadro = np.clip(np.floor(val + 0.5), 0, 255).astype(np.uint8)
        proc.stdin.write(quadro.tobytes())
        if args.progress and i % 240 == 0:
            print(f"  quadro {i}/{n_frames}", file=sys.stderr)
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg falhou")

    return {
        "arquivo": args.out,
        "fps": args.fps,
        "width": W,
        "height": H,
        "startNs": passagens[0].t,
        "finishNs": passagens[1].t,
        "elapsedNs": passagens[1].t - passagens[0].t,
        "elapsedText": f"{(passagens[1].t - passagens[0].t) / NS:.4f}",
        "speedPxPerS": args.speed,
        "exposureNs": E,
        "frames": n_frames,
    }


def main() -> None:
    import imageio_ffmpeg
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="/tmp/prova-sintetica.webm")
    ap.add_argument("--width", type=int, default=320)
    ap.add_argument("--height", type=int, default=180)
    ap.add_argument("--fps", type=int, default=240)
    ap.add_argument("--duration-s", type=float, default=4.2)
    ap.add_argument("--start-s", type=float, default=1.0)
    ap.add_argument("--finish-s", type=float, default=3.5)
    ap.add_argument("--speed", type=float, default=900.0, help="px/s do bordo")
    ap.add_argument("--object-px", type=float, default=90.0, help="largura do objeto em px")
    ap.add_argument("--exposure-frac", type=float, default=1.0, help="E/P (câmera lenta usa ~1)")
    ap.add_argument("--bg", type=float, default=96.0)
    ap.add_argument("--obj", type=float, default=184.0)
    ap.add_argument("--noise", type=float, default=1.5)
    ap.add_argument("--gamma", type=float, default=2.2)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--ffmpeg", default=None)
    ap.add_argument("--progress", action="store_true")
    args = ap.parse_args()
    if args.ffmpeg is None:
        args.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    verdade = render(args)
    with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump(verdade, fh, indent=2)
    print(json.dumps(verdade, indent=2))


if __name__ == "__main__":
    main()
