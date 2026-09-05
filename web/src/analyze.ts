/**
 * Analisa uma passada gravada: alimenta a máquina de estados com os quadros do vídeo, exatamente
 * como o app nativo faz com os quadros da câmera, e devolve o tempo da prova.
 *
 * A diferença para o app nativo é só a fonte do relógio: lá é o sensor, aqui é o `mediaTime` do
 * arquivo. Dentro de um mesmo clipe os dois têm a mesma qualidade para medir ΔT — e é ΔT que a prova
 * mede. O algoritmo (differencer, calibração, estimador sub-quadro, FSM) é o mesmo núcleo
 * compartilhado, conferido pelos 31 vetores.
 */
import { MEAN_ABS_DIFF_TO_SIGMA } from "./core/nanos.ts";
import { computeThreshold, NoiseCalibrator } from "./core/noiseCalibrator.ts";
import type { PhotocellConfig } from "./core/photocellConfig.ts";
import { framePeriodNs } from "./core/photocellConfig.ts";
import { PhotocellEngine, PhotocellState, type RunResult } from "./core/photocellEngine.ts";
import { RoiRect } from "./core/roiRect.ts";
import { StripDifferencer } from "./core/stripDifferencer.ts";
import { decodeStrips, supportsWebCodecs } from "./videoDecoderReader.ts";
import { probeFramePeriod, readStrips, type ReaderStats } from "./videoStripReader.ts";

export interface AnalysisRoi {
  /** Centro da linha, em fração da largura do vídeo. */
  lineXFraction: number;
  /** Banda, em fração da altura. */
  bandTopFraction: number;
  bandBottomFraction: number;
  /** Largura da faixa em pixels do vídeo. */
  stripWidthPx: number;
}

export interface AnalysisOptions {
  videoWidth: number;
  videoHeight: number;
  roi: AnalysisRoi;
  config: PhotocellConfig;
  /** Período entre quadros medido por `probeFramePeriod` (o relógio do clipe). */
  periodNs: number;
  playbackRate?: number;
  onProgress?: (fraction: number, received: number) => void;
  /** Progresso da leitura do arquivo em bytes — o único sinal de vida em vídeo grande. */
  onRead?: (bytesLidos: number, bytesTotal: number) => void;
  signal?: AbortSignal;
}

export interface AnalysisResult {
  run: RunResult | null;
  /** Como os quadros foram lidos: "decodificador" (exato) ou "reprodução" (pode pular quadros). */
  leitura: "decodificador" | "reprodução";
  /** Codec do arquivo, quando conhecido. */
  codec: string;
  /** Estado em que a máquina parou (diz onde o vídeo ficou curto). */
  finalState: string;
  threshold: number | null;
  lag: number;
  reader: ReaderStats;
  /** Taxa real medida no arquivo. */
  measuredFps: number;
  /** Quadros que o navegador deixou de apresentar (não é o mesmo que quadro perdido na gravação). */
  missedFrames: number;
  /** Trecho do vídeo usado para calibrar (segundos), para o cartão explicar de onde veio o limiar. */
  calibracao: { inicioS: number; fimS: number } | null;
  /**
   * Instante de cada disparo em segundos desde o primeiro quadro — é o que permite ao usuário
   * VER o quadro do gatilho e conferir se ele foi no cavalo ou em poeira. Sem isso o app afirma um
   * número sem mostrar a evidência que o produziu.
   */
  largadaS: number | null;
  chegadaS: number | null;
  /** Mensagem em pt-BR quando não deu para medir. */
  problem: string | null;
}

/** Converte a ROI em fração para pixels do vídeo, com a mesma disciplina do app nativo. */
export function roiPixels(o: AnalysisOptions): RoiRect {
  const { videoWidth: vw, videoHeight: vh, roi } = o;
  const halfW = Math.max(1, Math.floor(roi.stripWidthPx / 2));
  const cx = Math.round(roi.lineXFraction * vw);
  const x = Math.max(0, Math.min(vw - roi.stripWidthPx, cx - halfW));
  const yA = Math.round(Math.min(roi.bandTopFraction, roi.bandBottomFraction) * vh);
  const yB = Math.round(Math.max(roi.bandTopFraction, roi.bandBottomFraction) * vh);
  const y0 = Math.max(0, Math.min(vh - 2, yA));
  const y1 = Math.max(y0 + 1, Math.min(vh, yB));
  return new RoiRect(x, Math.min(roi.stripWidthPx, vw - x), y0, y1);
}

export async function analyzeVideo(file: Blob, opts: AnalysisOptions): Promise<AnalysisResult> {
  const roi = roiPixels(opts);
  const cfg = { ...opts.config };
  // O leitor já entrega a faixa recortada: para o differencer e o estimador, a faixa É o plano.
  // (O offset por linha do rolling shutter não existe aqui — o arquivo não informa o skew —, então
  // roi.y0 não entra em nenhuma conta.)
  const localRoi = new RoiRect(0, roi.width, 0, roi.height);
  const stride = roi.width;
  const janela = { x: roi.x, width: roi.width, y0: roi.y0, y1: roi.y1 };

  // ---------------------------------------------------------------- passada 1: ler o clipe
  // As faixas ficam na memória (≈1 KB por quadro; 20 s a 240 FPS ≈ 5 MB). É isso que permite
  // procurar o trecho parado em QUALQUER ponto do vídeo em vez de exigir que ele esteja no começo.
  const quadros: { tsNs: number; luma: Uint8Array }[] = [];
  const guardar = (f: { tsNs: number; luma: Uint8Array }): void => {
    quadros.push(f);
  };

  let stats: ReaderStats;
  let leitura: "decodificador" | "reprodução" = "decodificador";
  let codec = "";
  try {
    // caminho principal: demultiplexar + decodificar. Entrega TODOS os quadros, com o carimbo de
    // tempo do próprio arquivo.
    if (!supportsWebCodecs()) throw new Error("navegador sem WebCodecs");
    const d = await decodeStrips(
      file,
      { ...janela, onProgress: opts.onProgress, onRead: opts.onRead, signal: opts.signal },
      guardar,
    );
    stats = { received: d.received, expected: d.expected, worstGapPeriods: d.worstGapPeriods, medianPeriodNs: d.medianPeriodNs };
    codec = d.codec;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // reserva: reproduzir devagar e pegar cada quadro apresentado (pode pular quadros — e a passada
    // sai marcada quando pula)
    leitura = "reprodução";
    quadros.length = 0;
    stats = await readStrips(
      file,
      { ...janela, periodNs: opts.periodNs, playbackRate: opts.playbackRate, onProgress: opts.onProgress, signal: opts.signal },
      guardar,
    );
  }

  const measuredFps = stats.medianPeriodNs > 0 ? 1e9 / stats.medianPeriodNs : 0;
  const missedFrames = Math.max(0, stats.expected - stats.received);
  const vazio: AnalysisResult = {
    run: null, leitura, codec, finalState: PhotocellState.IDLE, threshold: null, lag: 1,
    reader: stats, measuredFps, missedFrames, calibracao: null, largadaS: null, chegadaS: null,
    problem: "O navegador entregou pouquíssimos quadros deste vídeo.",
  };
  if (quadros.length < 30) return vazio;

  // ---------------------------------------------------------------- passada 2: medir a cena
  const cal = medirCena(quadros, cfg, localRoi, stride);
  if (cal === null) {
    return {
      ...vazio,
      problem:
        "A cena nunca fica parada neste vídeo: não achei um trecho calmo para calibrar. O celular " +
        "estava na mão, o tripé foi esbarrado ou alguém passou na frente?",
    };
  }

  // ---------------------------------------------------------------- passada 3: medir a prova
  const diff = new StripDifferencer(localRoi, roi.width, roi.height, cfg.coreWidth);
  const eng = new PhotocellEngine(cfg, localRoi, roi.height);
  let deliveryOn = true;
  const applyEffects = (): void => {
    for (const e of eng.effects) {
      if (e.kind === "resetDifferencer") diff.reset();
      else if (e.kind === "updateBackground") diff.updateBackground(cfg.backgroundEmaAlpha);
      else if (e.kind === "setReferenceLag") diff.setLag(e.lag);
      else if (e.kind === "setFrameDelivery") deliveryOn = e.enabled;
    }
    eng.effects.length = 0;
  };
  // limiar já medido no trecho mais parado: a máquina entra armada
  eng.seedCalibration(cal.threshold, cal.noiseSigmaPx, cal.lag);
  applyEffects();

  for (const f of quadros) {
    if (opts.signal?.aborted) throw new DOMException("cancelado", "AbortError");
    if (deliveryOn) {
      const m = diff.process(f.luma, stride, f.tsNs);
      if (m === null) eng.frame(null, f.tsNs);
      else eng.frame(m);
    } else {
      // pipeline suspenso pela FSM (janela cega): os prazos ainda correm pelo relógio do arquivo
      eng.wakeup(f.tsNs);
    }
    applyEffects();
  }

  const t0 = quadros[0].tsNs;
  let problem: string | null = null;
  if (eng.state !== PhotocellState.FINISHED) {
    problem =
      eng.state === PhotocellState.ARMED
        ? "Nenhum cruzamento foi detectado na faixa. Confira a posição da linha e da banda."
        : "O vídeo terminou antes da chegada (só a largada foi detectada).";
  }
  return {
    run: eng.result,
    leitura,
    codec,
    finalState: eng.state,
    threshold: eng.threshold,
    lag: eng.lag,
    reader: stats,
    measuredFps,
    missedFrames,
    calibracao: { inicioS: (cal.inicioNs - t0) / 1e9, fimS: (cal.fimNs - t0) / 1e9 },
    // O timestamp BRUTO (o do quadro), não o refinado: é o quadro que o usuário vai ver na tela.
    largadaS: eng.result ? (eng.result.start.rawTsNs - t0) / 1e9 : null,
    chegadaS: eng.result ? (eng.result.finish.rawTsNs - t0) / 1e9 : null,
    problem,
  };
}

interface Calibragem {
  threshold: number;
  noiseSigmaPx: number;
  lag: number;
  inicioNs: number;
  fimNs: number;
}

/**
 * Acha o trecho MAIS PARADO do clipe e calibra nele.
 *
 * A calibragem mede o quanto a imagem treme sozinha — grão da câmera, luz variando, grama ao vento —
 * e isso vira o limite entre "cena parada" e "alguma coisa passou". Ela precisa de um trecho sem
 * ninguém cruzando; exigir que esse trecho esteja no COMEÇO do vídeo é o que fazia o operador perder
 * a passada por ter apertado o gravar tarde. Como o clipe inteiro já está na memória, o trecho pode
 * estar em qualquer lugar: antes da largada, entre a ida e a volta, ou depois da chegada.
 *
 * Devolve null quando a cena nunca fica parada (celular na mão, tripé esbarrado).
 */
function medirCena(
  quadros: { tsNs: number; luma: Uint8Array }[],
  cfg: PhotocellConfig,
  roi: RoiRect,
  stride: number,
): Calibragem | null {
  const n = quadros.length;
  const amostras = Math.max(15, Math.min(cfg.calibrationSamples, Math.floor(n / 3)));
  // série de ΔY do clipe inteiro (lag 1) e de ΔY contra o quadro c−2 (para detectar flicker)
  const diff = new StripDifferencer(roi, roi.width, roi.height, cfg.coreWidth);
  const dy = new Float64Array(n);
  const dy2 = new Float64Array(n);
  const valido = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = diff.process(quadros[i].luma, stride, quadros[i].tsNs);
    if (m === null) continue;
    dy[i] = m.deltaFull;
    dy2[i] = m.deltaFullLag2 ?? m.deltaFull;
    valido[i] = m.deltaFullLag2 === null ? 1 : 2;   // 2 = também tem ΔY de lag 2
  }

  // média móvel: a janela de menor média é a mais parada. Empate fica com a mais próxima do início.
  let melhorInicio = -1;
  let melhorMedia = Infinity;
  let soma = 0;
  let contados = 0;
  const fila: number[] = [];
  for (let i = 0; i < n; i++) {
    if (valido[i]) {
      fila.push(i);
      soma += dy[i];
      contados += 1;
    }
    while (contados > amostras) {
      const saiu = fila.shift()!;
      soma -= dy[saiu];
      contados -= 1;
    }
    if (contados === amostras) {
      const media = soma / amostras;
      if (media < melhorMedia - 1e-12) {
        melhorMedia = media;
        melhorInicio = fila[0];
      }
    }
  }
  if (melhorInicio < 0) return null;

  // reunir os índices válidos da janela escolhida
  const idx: number[] = [];
  for (let i = melhorInicio; i < n && idx.length < amostras; i++) if (valido[i]) idx.push(i);
  if (idx.length < amostras) return null;

  // A cena nunca fica parada? Compara o trecho mais calmo com o pico do clipe: se o "calmo" já for
  // metade do movimento máximo, não existe fundo estável — calibrar ali seria calibrar em cima do
  // próprio movimento.
  let pico = 0;
  for (let i = 0; i < n; i++) if (valido[i] && dy[i] > pico) pico = dy[i];
  if (pico > 0 && melhorMedia > 0.5 * pico) return null;

  // limiar e σ pelo mesmo caminho do núcleo (Welford + regra do limiar), na janela escolhida
  const cal1 = new NoiseCalibrator({ ...cfg, calibrationSamples: idx.length });
  const cal2 = new NoiseCalibrator({ ...cfg, calibrationSamples: idx.length });
  for (const i of idx) {
    cal1.addSample(dy[i]);
    if (valido[i] === 2) cal2.addSample(dy2[i]);
  }
  if (cal1.threshold === null) return null;

  let stats = cal1.stats;
  let threshold = cal1.threshold;
  let lag = 1;
  // flicker de 120 Hz: se comparar com o quadro c−2 dá muito menos variação, é a lâmpada piscando
  if (cfg.flickerAuto && cal2.stats.count >= idx.length - 1 && cal2.stats.mean < cfg.flickerRatio * stats.mean) {
    stats = cal2.stats;
    threshold = computeThreshold(cfg, stats.mean, stats.sigma);
    lag = 2;
  }
  return {
    threshold,
    noiseSigmaPx: stats.mean / MEAN_ABS_DIFF_TO_SIGMA,
    lag,
    inicioNs: quadros[idx[0]].tsNs,
    fimNs: quadros[idx[idx.length - 1]].tsNs,
  };
}

/** Mede a taxa do arquivo antes de analisar (reexportado para a tela). */
export { probeFramePeriod };

/**
 * Ajusta a configuração à taxa real do arquivo. A câmera lenta do iPhone não informa a exposição:
 * assume-se E = P (a janela inteira do quadro), o caso "sem janela cega" — que na varredura de
 * 3.840 cenários dá qualidade 2 com erro médio de 0,003 ms. É a suposição honesta: nunca mais curta
 * do que a realidade, então a incerteza declarada continua cobrindo o erro.
 */
export function configForFile(base: PhotocellConfig, measuredFps: number): PhotocellConfig {
  const fps = measuredFps >= 1 ? Math.round(measuredFps) : base.frameRateHz;
  const cfg = { ...base, frameRateHz: fps };
  cfg.calibrationSamples = Math.max(30, Math.round(fps * 0.5)); // 0,5 s de pista vazia
  cfg.exposureNs = framePeriodNs(cfg);
  return cfg;
}
