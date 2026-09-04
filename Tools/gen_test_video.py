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


def _render_barra(args) -> dict:
    """Caminho original, intocado: barra vertical em fundo parado. Rápido e já validado."""
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


# ---------------------------------------------------------------------------- cena de arena
# Até aqui todo o teste foi uma BARRA VERTICAL num fundo parado. Isso prova o estimador, não prova
# que o app enxerga um cavalo: um cavalo tem focinho na frente do peito, pernas, cavaleiro em cima e
# rabo atrás — vários bordos verticais em alturas diferentes —, levanta poeira, projeta sombra, e
# atrás dele a arquibancada se mexe. Nada disso existia em nenhum teste.

class Parte:
    """
    Um pedaço do cavalo, visto pela faixa vertical.

    `frente` e `tras` são deslocamentos em pixels A PARTIR DO PEITO, medidos no sentido do
    movimento: positivo = à frente do peito. É por isso que o focinho tem `frente` positivo — e é
    por isso que, numa fotocélula de verdade, quem costuma cortar o feixe primeiro é a cabeça, não
    o peito. Qual parte dispara depende de onde a banda está na altura da imagem, e essa é
    exatamente a pergunta que este gerador existe para responder.
    """

    def __init__(self, nome, linha_a, linha_b, frente, tras, luma):
        self.nome = nome
        self.linha_a = linha_a      # fração da altura (0 = topo)
        self.linha_b = linha_b
        self.frente = frente        # px à frente do peito
        self.tras = tras            # px à frente do peito (menor que `frente`)
        self.luma = luma            # nível de cinza da parte


def perfil(silhueta, L, obj):
    """Silhueta em partes. `L` é o comprimento do corpo em px; `obj` o nível de luma do animal."""
    if silhueta == "barra":
        return [Parte("barra", 0.20, 0.80, 0.0, -L, obj)]
    escuro = max(0.0, obj * 0.55)          # cavaleiro e sela: tecido escuro
    return [
        Parte("cabeca",   0.06, 0.26,  0.45 * L,  0.16 * L, obj),
        Parte("pescoco",  0.26, 0.42,  0.22 * L, -0.06 * L, obj),
        Parte("cavaleiro",0.00, 0.40, -0.30 * L, -0.72 * L, escuro),
        Parte("peito",    0.42, 0.76,  0.0,      -1.00 * L, obj),
        Parte("rabo",     0.44, 0.66, -1.00 * L, -1.28 * L, escuro),
        Parte("dianteira",0.76, 1.00, -0.02 * L, -0.22 * L, obj),
        Parte("traseira", 0.76, 1.00, -0.74 * L, -0.94 * L, obj),
    ]


def _render_arena(args) -> dict:
    """
    Cena de arena: silhueta de cavalo, poeira, arquibancada em movimento, sombra e rolling shutter.

    Mais caro que o caminho da barra porque a geometria passa a depender da LINHA (é o que permite
    silhueta e rolling shutter), então a cobertura é (H, W) em vez de (1, W).
    """
    import numpy as np

    W, H = args.width, args.height
    xc = (W - 1) / 2.0
    v = args.speed / NS
    periodo = NS // args.fps
    E = int(args.exposure_frac * periodo)
    rng = np.random.default_rng(args.seed)
    n_frames = int(args.duration_s * args.fps)
    L = args.object_px

    partes = perfil(args.silhueta, L, args.obj)
    passagens = [] if args.sem_objeto else [
        (int(args.start_s * NS), +1),
        (int(args.finish_s * NS), -1),
    ]

    ys = np.arange(H).reshape(H, 1)
    xs = np.arange(W).reshape(1, W)
    # Mesma fórmula do fundo da `Scene` dos vetores — uma convenção só, senão o teste cruzado
    # mede diferença de padrão em vez de diferença de física.
    base0 = (args.bg + (xs * 7 + ys * 3) % 11).astype(np.float64)
    # A arquibancada é a faixa de cima: mais contraste, para ser um distrator honesto.
    arq_ate = int(H * 0.22)
    arquibancada = (args.bg * 0.8 + ((xs * 13) % 37) + ((ys * 5) % 9)).astype(np.float64)

    # Integração da exposição em forma FECHADA, não por amostragem: a fração coberta de um pixel é
    # `clip((t_leitura + E - t_do_bordo) / E, 0, 1)`, exatamente como a `Scene` dos vetores. Amostrar
    # a exposição em N instantes transformaria a rampa em N degraus — e a rampa É o sinal que o
    # estimador sub-quadro lê para achar o sub-milésimo. Com 8 amostras o erro chegava a 11 níveis
    # de luma, medido pelo `Tools/test_cena.py`.
    #
    # No espaço, a mesma quadratura da `Scene`: trapézio de 5 pontos sobre a abertura do pixel
    # (somada em quadratura com a PSF óptica pedida).
    psf = math.sqrt(args.psf * args.psf + 1.0)
    xk_off = (np.arange(5) - 2) * psf / 4.0
    peso = np.array([0.5, 1.0, 1.0, 1.0, 0.5])
    xx = np.arange(W).reshape(1, W, 1) + xk_off.reshape(1, 1, 5)        # (1, W, 5)
    linhas = np.arange(H).reshape(H, 1)
    # rolling shutter: cada linha é lida num instante diferente
    t_linha = (linhas * args.skew_ns / max(1, H)).astype(np.float64)     # (H,1)

    faixas = [(int(p.linha_a * H), int(p.linha_b * H), p) for p in partes]

    # poeira: partículas nascendo atrás dos cascos e subindo. É a fonte clássica de disparo falso.
    poeira = []
    if args.poeira > 0 and passagens:
        for tc, d in passagens:
            for _ in range(args.poeira):
                nasce = tc + int(rng.uniform(-0.05, 0.55) * NS)
                poeira.append({
                    "t": nasce,
                    "x": xc - d * rng.uniform(0.2 * L, 1.3 * L),
                    "y": rng.uniform(0.72 * H, 0.98 * H),
                    "vx": -d * rng.uniform(20, 120) / NS,
                    "vy": -rng.uniform(30, 160) / NS,
                    "r": rng.uniform(1.5, 5.0),
                    "a": rng.uniform(8.0, 34.0),
                    "vida": rng.uniform(0.25, 0.9) * NS,
                })

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

    amostra = None
    wf = 2.0 * math.pi * 120.0 / NS      # flicker de rede a 120 Hz

    for i in range(n_frames):
        t0 = i * periodo
        cob = np.zeros((H, W), dtype=np.float64)
        lum = np.zeros((H, W), dtype=np.float64)

        for tc, d in passagens:
            # instante de leitura de cada linha (rolling shutter)
            treal = (t0 + t_linha).astype(np.float64)                 # (H,1)
            for (ga, gb, parte) in faixas:
                if gb <= ga:
                    continue
                tr = treal[ga:gb].reshape(-1, 1, 1)                   # (linhas,1,1)
                # instante em que cada bordo da parte alcança cada amostra espacial
                t_ini = tc + (xx - xc - d * parte.frente) / (d * v)    # bordo dianteiro
                t_fim = tc + (xx - xc - d * parte.tras) / (d * v)      # bordo traseiro
                f_in = np.clip((tr + E - t_ini) / E, 0.0, 1.0)
                f_out = np.clip((tr + E - t_fim) / E, 0.0, 1.0)
                dentro = ((f_in - f_out) * peso).sum(axis=2) / 4.0     # (linhas, W)
                np.maximum(cob[ga:gb], dentro, out=cob[ga:gb])
                np.maximum(lum[ga:gb], dentro * parte.luma, out=lum[ga:gb])
        frac = np.clip(cob, 0.0, 1.0)

        # fundo: arquibancada deslizando (distrator com movimento real)
        base = base0.copy()
        if args.fundo_movel and arq_ate > 0:
            desloc = int((t0 / NS) * args.fundo_vel) % W
            base[:arq_ate] = np.roll(arquibancada, desloc, axis=1)[:arq_ate]

        # pelagem: textura presa ao objeto (a mesma ideia do simulador dos vetores)
        if args.textura > 0 and passagens:
            tc, d = passagens[0]
            rel = (xs - xc) * d - (t0 + E / 2 - tc) * v
            lum = lum + args.textura * np.sin(rel * 0.9 + ys * 0.3) * (frac > 0)

        # `lum` acumulou luma×cobertura; dividir devolve o nível da parte que mais cobre o pixel
        with np.errstate(divide="ignore", invalid="ignore"):
            obj_map = np.where(frac > 1e-6, lum / np.maximum(frac, 1e-6), args.obj)
        lin = base + (obj_map - base) * frac

        # sombra projetada, viajando com o animal
        if args.sombra and passagens:
            for tc, d in passagens:
                cx = xc + d * v * (t0 - tc) - d * 0.5 * L
                elipse = (((xs - cx) / (0.9 * L)) ** 2 + ((ys - H * 0.93) / (0.06 * H + 1)) ** 2) <= 1.0
                lin = np.where(elipse, lin * 0.72, lin)

        # poeira
        if poeira:
            for pt in poeira:
                dt_ns = t0 - pt["t"]
                if dt_ns < 0 or dt_ns > pt["vida"]:
                    continue
                px = pt["x"] + pt["vx"] * dt_ns
                py = pt["y"] + pt["vy"] * dt_ns
                if px < -10 or px > W + 10:
                    continue
                fade = 1.0 - dt_ns / pt["vida"]
                d2 = ((xs - px) ** 2 + (ys - py) ** 2) / (pt["r"] ** 2)
                lin = lin + pt["a"] * fade * np.exp(-d2)

        if args.flicker > 0:
            treal = t0 + t_linha
            flick = 1.0 + args.flicker * (np.cos(wf * treal) - np.cos(wf * (treal + E))) / (wf * E)
            lin = lin * flick

        val = 255.0 * np.power(np.clip(lin, 0.0, None) / 255.0, 1.0 / args.gamma)
        val += rng.normal(0.0, args.noise, size=val.shape)
        quadro = np.clip(np.floor(val + 0.5), 0, 255).astype(np.uint8)
        if amostra is None and passagens and t0 >= passagens[0][0]:
            amostra = quadro.copy()
        proc.stdin.write(quadro.tobytes())
        if args.progress and i % 240 == 0:
            print(f"  quadro {i}/{n_frames}", file=sys.stderr)

    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg falhou")

    if args.png_amostra and amostra is not None:
        try:
            from PIL import Image
            Image.fromarray(amostra, mode="L").save(args.png_amostra)
        except Exception as e:                                        # pragma: no cover
            print(f"  (não deu para gravar o PNG: {e})", file=sys.stderr)

    # A verdade por PARTE: quando o bordo dianteiro de cada uma cruza o centro da faixa. Uma parte
    # `frente` px à frente do peito cruza `frente/v` nanossegundos ANTES dele.
    def cruzamentos(tc):
        return {p.nome: int(round(tc - p.frente / v)) for p in partes}

    verdade = {
        "arquivo": args.out,
        "fps": args.fps,
        "width": W,
        "height": H,
        "silhueta": args.silhueta,
        "frames": n_frames,
        "speedPxPerS": args.speed,
        "exposureNs": E,
        "semObjeto": bool(args.sem_objeto),
        "distratores": {
            "poeira": args.poeira, "fundoMovel": bool(args.fundo_movel),
            "sombra": bool(args.sombra), "skewNs": args.skew_ns, "flicker": args.flicker,
        },
    }
    if passagens:
        # o tempo da prova é medido pelo PEITO — a referência do modelo
        verdade["startNs"] = passagens[0][0]
        verdade["finishNs"] = passagens[1][0]
        verdade["elapsedNs"] = passagens[1][0] - passagens[0][0]
        verdade["elapsedText"] = f"{(passagens[1][0] - passagens[0][0]) / NS:.4f}"
        verdade["partesLargada"] = cruzamentos(passagens[0][0])
        verdade["partesChegada"] = cruzamentos(passagens[1][0])
    return verdade


def render(args) -> dict:
    """Caminho rápido quando a cena é a antiga; caminho de arena quando há qualquer coisa a mais."""
    simples = (
        args.silhueta == "barra" and args.skew_ns == 0 and args.poeira == 0
        and not args.fundo_movel and not args.sombra and not args.sem_objeto
        and args.flicker == 0.0 and args.textura == 0.0 and args.psf == 0.0
        and not args.png_amostra
    )
    return _render_barra(args) if simples else _render_arena(args)


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
    ap.add_argument("--silhueta", choices=["barra", "cavalo"], default="barra",
                    help="barra = a cena antiga; cavalo = focinho, pescoço, cavaleiro, pernas e rabo")
    ap.add_argument("--sem-objeto", action="store_true",
                    help="cena SEM animal: só os distratores. Serve para medir disparo falso.")
    ap.add_argument("--poeira", type=int, default=0, help="número de partículas de poeira por passagem")
    ap.add_argument("--fundo-movel", action="store_true", help="arquibancada deslizando ao fundo")
    ap.add_argument("--fundo-vel", type=float, default=12.0, help="px/s da arquibancada")
    ap.add_argument("--sombra", action="store_true", help="sombra projetada viajando com o animal")
    ap.add_argument("--skew-ns", type=int, default=0, help="rolling shutter: leitura do topo à base")
    ap.add_argument("--flicker", type=float, default=0.0, help="amplitude do flicker de rede (120 Hz)")
    ap.add_argument("--psf", type=float, default=0.0, help="desfoque óptico em px")
    ap.add_argument("--textura", type=float, default=0.0, help="pelagem: variação de luma presa ao objeto")
    ap.add_argument("--png-amostra", default="", help="grava um quadro da passagem em PNG")
    args = ap.parse_args()
    if args.ffmpeg is None:
        args.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    verdade = render(args)
    with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as fh:
        json.dump(verdade, fh, indent=2)
    print(json.dumps(verdade, indent=2))


if __name__ == "__main__":
    main()
