/**
 * Analisa uma passada gravada: alimenta a máquina de estados com os quadros do vídeo, exatamente
 * como o app nativo faz com os quadros da câmera, e devolve o tempo da prova.
 *
 * A diferença para o app nativo é só a fonte do relógio: lá é o sensor, aqui é o `mediaTime` do
 * arquivo. Dentro de um mesmo clipe os dois têm a mesma qualidade para medir ΔT — e é ΔT que a prova
 * mede. O algoritmo (differencer, calibração, estimador sub-quadro, FSM) é o mesmo núcleo
 * compartilhado, conferido pelos 30 vetores.
 */
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
  const diff = new StripDifferencer(localRoi, roi.width, roi.height, cfg.coreWidth);
  const eng = new PhotocellEngine(cfg, localRoi, roi.height);
  // a análise começa "armando": os primeiros quadros do clipe (pista vazia) calibram o ruído e o
  // limiar, exatamente como o operador faz na arena antes de armar
  eng.userArm();
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
  applyEffects();

  const stride = roi.width;

  const alimentar = (f: { tsNs: number; luma: Uint8Array }): void => {
    if (deliveryOn) {
      const m = diff.process(f.luma, stride, f.tsNs);
      if (m === null) eng.frame(null, f.tsNs);
      else eng.frame(m);
    } else {
      // pipeline suspenso pela FSM (janela cega): os prazos ainda correm pelo relógio do arquivo
      eng.wakeup(f.tsNs);
    }
    applyEffects();
  };

  const janela = { x: roi.x, width: roi.width, y0: roi.y0, y1: roi.y1 };
  let stats: ReaderStats;
  let leitura: "decodificador" | "reprodução" = "decodificador";
  let codec = "";
  try {
    // caminho principal: demultiplexar + decodificar. Entrega TODOS os quadros, com o carimbo de
    // tempo do próprio arquivo.
    if (!supportsWebCodecs()) throw new Error("navegador sem WebCodecs");
    const d = await decodeStrips(
      file,
      { ...janela, onProgress: opts.onProgress, signal: opts.signal },
      alimentar,
    );
    stats = { received: d.received, expected: d.expected, worstGapPeriods: d.worstGapPeriods, medianPeriodNs: d.medianPeriodNs };
    codec = d.codec;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    // reserva: reproduzir devagar e pegar cada quadro apresentado (pode pular quadros — e a passada
    // sai marcada quando pula)
    leitura = "reprodução";
    diff.reset();
    eng.userReset();
    eng.userArm();
    deliveryOn = true;
    applyEffects();
    stats = await readStrips(
      file,
      { ...janela, periodNs: opts.periodNs, playbackRate: opts.playbackRate, onProgress: opts.onProgress, signal: opts.signal },
      alimentar,
    );
  }

  const measuredFps = stats.medianPeriodNs > 0 ? 1e9 / stats.medianPeriodNs : 0;
  const missedFrames = Math.max(0, stats.expected - stats.received);
  let problem: string | null = null;
  if (stats.received < 10) {
    problem = "O navegador entregou pouquíssimos quadros deste vídeo.";
  } else if (eng.state !== PhotocellState.FINISHED) {
    problem =
      eng.state === PhotocellState.CALIBRATING
        ? "O vídeo é curto demais para calibrar: precisa de cerca de 1 s de pista vazia no começo."
        : eng.state === PhotocellState.ARMED
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
    problem,
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
