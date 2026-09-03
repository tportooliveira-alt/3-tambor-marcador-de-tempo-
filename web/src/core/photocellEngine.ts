import { estimateCrossing } from "./crossingEstimator.ts";
import { CrossingInput, type FrameMeasurement } from "./frameMeasurement.ts";
import { MEAN_ABS_DIFF_TO_SIGMA, type Nanos } from "./nanos.ts";
import { computeThreshold, NoiseCalibrator } from "./noiseCalibrator.ts";
import { framePeriodNs, validateConfig, type PhotocellConfig } from "./photocellConfig.ts";
import type { RoiRect } from "./roiRect.ts";

/** Estados da máquina (nomes exatamente como na especificação, mais CONFIRMING e ERROR). */
export const PhotocellState = {
  IDLE: "idle",
  CALIBRATING: "calibrating",
  ARMED: "armed",
  CONFIRMING_START: "confirmingStart",
  DEBOUNCE_START: "debounceStart",
  RUNNING: "running",
  AWAITING_FINISH: "awaitingFinish",
  CONFIRMING_FINISH: "confirmingFinish",
  DEBOUNCE_FINISH: "debounceFinish",
  FINISHED: "finished",
  ERROR: "error",
} as const;

export type PhotocellState = (typeof PhotocellState)[keyof typeof PhotocellState];

export function isActive(s: PhotocellState): boolean {
  return (
    s === PhotocellState.ARMED ||
    s === PhotocellState.CONFIRMING_START ||
    s === PhotocellState.DEBOUNCE_START ||
    s === PhotocellState.RUNNING ||
    s === PhotocellState.AWAITING_FINISH ||
    s === PhotocellState.CONFIRMING_FINISH ||
    s === PhotocellState.DEBOUNCE_FINISH
  );
}

/**
 * Efeitos que a camada de plataforma deve executar após cada evento. A representação textual é
 * idêntica à da referência Python (é o que os vetores de teste comparam).
 */
export type Effect =
  | { kind: "setFrameDelivery"; enabled: boolean }
  | { kind: "resetDifferencer" }
  | { kind: "updateBackground" }
  | { kind: "setReferenceLag"; lag: number }
  | { kind: "scheduleWakeup"; atNs: Nanos }
  | { kind: "cancelWakeups" }
  | { kind: "feedback"; feedback: "start" | "finish" }
  | { kind: "publish" };

export function effectWire(e: Effect): string {
  switch (e.kind) {
    case "setFrameDelivery":
      return `setFrameDelivery:${e.enabled}`;
    case "resetDifferencer":
      return "resetDifferencer";
    case "updateBackground":
      return "updateBackground";
    case "setReferenceLag":
      return `setReferenceLag:${e.lag}`;
    case "scheduleWakeup":
      return `scheduleWakeup:${e.atNs}`;
    case "cancelWakeups":
      return "cancelWakeups";
    case "feedback":
      return `feedback:${e.feedback}`;
    case "publish":
      return "publish";
  }
}

export interface TriggerInfo {
  rawTsNs: Nanos;
  refinedTsNs: Nanos;
  quality: number;
  uncertaintyNs: Nanos;
  interiorCount: number;
  degraded: boolean;
  /** Colunas cuja dispersão de tempos excede o ruído (textura/inclinação do bordo). */
  texturedColumns: number;
}

export interface RunResult {
  start: TriggerInfo;
  finish: TriggerInfo;
  elapsedRawNs: Nanos;
  elapsedRefinedNs: Nanos;
  drops: number;
  degraded: boolean;
  thresholdStart: number;
  thresholdFinish: number;
}

class Candidate {
  seen = 0;
  confirmed = 0;
  inp: CrossingInput;
  degraded: boolean;

  constructor(inp: CrossingInput, degraded: boolean) {
    this.inp = inp;
    this.degraded = degraded;
  }
}

/**
 * Dono único da máquina de estados (porte fiel do núcleo Kotlin/Swift/Python).
 *
 * Eventos: `userCalibrate`, `userArm`, `userReset`, `frame`, `wakeup`, `captureInterrupted`,
 * `framesDropped`. Após cada evento, execute e limpe `effects`.
 */
export class PhotocellEngine {
  readonly cfg: PhotocellConfig;
  readonly roi: RoiRect;
  readonly planeHeight: number;

  state: PhotocellState = PhotocellState.IDLE;
  errorReason: string | null = null;
  threshold: number | null = null;
  lag = 1;
  start: TriggerInfo | null = null;
  finish: TriggerInfo | null = null;
  result: RunResult | null = null;
  drops = 0;
  noiseSigmaPx = 0.0;

  readonly effects: Effect[] = [];
  /** Histórico de estados (para testes/diagnóstico). */
  readonly transitions: PhotocellState[] = [];

  private calibrator: NoiseCalibrator;
  private calibratorLag2: NoiseCalibrator;
  private afterCalibration: PhotocellState = PhotocellState.IDLE;
  private candidate: Candidate | null = null;
  private thresholdStart = 0.0;
  private wakeups: Nanos[] = [];
  private lastFrameTs: Nanos | null = null;
  private deliveryOn = false;
  private lastMeasuredTs: Nanos | null = null;
  private seedTs: Nanos | null = null;
  private lastDropTs: Nanos | null = null;
  private dropPending = false;

  constructor(cfg: PhotocellConfig, roi: RoiRect, planeHeight: number) {
    validateConfig(cfg);
    this.cfg = cfg;
    this.roi = roi;
    this.planeHeight = planeHeight;
    this.calibrator = new NoiseCalibrator(cfg);
    this.calibratorLag2 = new NoiseCalibrator(cfg);
  }

  // ---- utilitários ----------------------------------------------------------
  /** Efeito só na transição: o contrato é "ligado/desligado alterna", não "reafirma". */
  private setDelivery(on: boolean): void {
    if (this.deliveryOn === on) return;
    this.deliveryOn = on;
    this.emit({ kind: "setFrameDelivery", enabled: on });
  }

  private emit(e: Effect): void {
    this.effects.push(e);
  }

  private go(s: PhotocellState): void {
    this.state = s;
    this.transitions.push(s);
    this.emit({ kind: "publish" });
  }

  private schedule(atNs: Nanos): void {
    this.wakeups.push(atNs);
    this.wakeups.sort((a, b) => a - b);
    this.emit({ kind: "scheduleWakeup", atNs });
  }

  private cancelWakeups(): void {
    this.wakeups = [];
    this.emit({ kind: "cancelWakeups" });
  }

  private processDeadlines(nowNs: Nanos): void {
    while (this.wakeups.length > 0 && this.wakeups[0] <= nowNs) {
      const at = this.wakeups.shift()!;
      this.onDeadline(at);
    }
  }

  // ---- eventos do usuário ---------------------------------------------------
  userCalibrate(): void {
    if (
      this.state === PhotocellState.IDLE ||
      this.state === PhotocellState.FINISHED ||
      this.state === PhotocellState.ERROR ||
      this.state === PhotocellState.ARMED
    ) {
      this.beginCalibration(PhotocellState.IDLE);
    }
  }

  userArm(): void {
    if (this.state === PhotocellState.IDLE || this.state === PhotocellState.FINISHED) {
      this.beginCalibration(PhotocellState.ARMED);
    }
  }

  userReset(): void {
    this.cancelWakeups();
    this.setDelivery(false);
    if (this.lag !== 1) {
      this.lag = 1;
      this.emit({ kind: "setReferenceLag", lag: 1 });
    }
    this.candidate = null;
    this.start = null;
    this.finish = null;
    this.result = null;
    this.errorReason = null;
    this.drops = 0;
    this.lastDropTs = null;
    this.dropPending = false;
    this.lastFrameTs = null;
    this.lastMeasuredTs = null;
    this.seedTs = null;
    this.go(PhotocellState.IDLE);
  }

  captureInterrupted(): void {
    if (isActive(this.state) || this.state === PhotocellState.CALIBRATING) this.fail("captureInterrupted");
  }

  /**
   * A plataforma soube de quadros perdidos sem conhecer os timestamps: o candidato em confirmação
   * perde a base de tempo e é descartado, o próximo quadro conta como drop e a referência do
   * differencer é ressemeada.
   */
  framesDropped(): void {
    this.drops += 1;
    this.dropPending = true;
    this.lastFrameTs = null;
    this.seedTs = null;
    if (this.state === PhotocellState.CONFIRMING_START) {
      this.candidate = null;
      this.go(PhotocellState.ARMED);
    } else if (this.state === PhotocellState.CONFIRMING_FINISH) {
      this.candidate = null;
      this.go(PhotocellState.AWAITING_FINISH);
    }
    if (
      this.state === PhotocellState.CALIBRATING ||
      this.state === PhotocellState.ARMED ||
      this.state === PhotocellState.AWAITING_FINISH
    ) {
      this.emit({ kind: "resetDifferencer" });
    }
  }

  private fail(reason: string): void {
    this.cancelWakeups();
    this.setDelivery(false);
    this.candidate = null;
    this.errorReason = reason;
    this.go(PhotocellState.ERROR);
  }

  private beginCalibration(next: PhotocellState): void {
    this.afterCalibration = next;
    this.calibrator.reset();
    this.calibratorLag2.reset();
    this.candidate = null;
    // nova prova: nada da anterior pode vazar
    this.start = null;
    this.finish = null;
    this.result = null;
    this.errorReason = null;
    this.drops = 0;
    this.lastDropTs = null;
    this.dropPending = false;
    this.lastFrameTs = null;
    this.lastMeasuredTs = null;
    this.seedTs = null;
    if (this.lag !== 1) {
      this.lag = 1;
      this.emit({ kind: "setReferenceLag", lag: 1 });
    }
    this.setDelivery(true);
    this.emit({ kind: "resetDifferencer" });
    this.go(PhotocellState.CALIBRATING);
  }

  // ---- tempo ----------------------------------------------------------------
  wakeup(nowNs: Nanos): void {
    this.processDeadlines(nowNs);
  }

  private onDeadline(atNs: Nanos): void {
    const s = this.start?.rawTsNs;
    if (s === undefined) return;
    const cfg = this.cfg;
    if (this.state === PhotocellState.DEBOUNCE_START && atNs === s + cfg.startLockoutNs) {
      this.go(PhotocellState.RUNNING);
    } else if (
      (this.state === PhotocellState.RUNNING || this.state === PhotocellState.AWAITING_FINISH) &&
      atNs === s + cfg.frameResumeNs
    ) {
      this.lastFrameTs = null;
      this.seedTs = null;
      this.setDelivery(true);
      this.emit({ kind: "resetDifferencer" });
    } else if (this.state === PhotocellState.RUNNING && atNs === s + cfg.finishArmNs) {
      this.candidate = null;
      this.go(PhotocellState.AWAITING_FINISH);
    } else if (
      this.state === PhotocellState.DEBOUNCE_FINISH &&
      this.finish !== null &&
      atNs === this.finish.rawTsNs + cfg.finishLockoutNs
    ) {
      this.finishRun();
    }
  }

  // ---- quadros --------------------------------------------------------------
  /** `m == null` significa quadro-semente (o differencer acabou de ressemear); passe `tsNs`. */
  frame(m: FrameMeasurement | null, tsNs: Nanos | null = null): void {
    const ts = m !== null ? m.tsNs : tsNs;
    const lastTs = this.lastFrameTs;
    if (ts !== null && lastTs !== null && ts <= lastTs) {
      // Timestamp andou para trás (troca de base de tempo, quadro repetido): não dá para medir.
      if (isActive(this.state)) this.fail("timestampGlitch");
      return;
    }
    if (ts !== null) {
      this.trackGaps(ts);
      this.processDeadlines(ts);
    }
    if (m === null) return;
    switch (this.state) {
      case PhotocellState.CALIBRATING:
        this.calibrationFrame(m);
        break;
      case PhotocellState.ARMED:
        this.armedFrame(m, PhotocellState.CONFIRMING_START);
        break;
      case PhotocellState.CONFIRMING_START:
        this.confirmingFrame(m, PhotocellState.ARMED, true);
        break;
      case PhotocellState.AWAITING_FINISH:
        this.armedFrame(m, PhotocellState.CONFIRMING_FINISH);
        break;
      case PhotocellState.CONFIRMING_FINISH:
        this.confirmingFrame(m, PhotocellState.AWAITING_FINISH, false);
        break;
      default:
        break; // RUNNING (após retomada), DEBOUNCE_*, FINISHED, IDLE, ERROR: ignorar
    }
    // depois do despacho: o candidato criado neste quadro precisa do quadro medido ANTERIOR
    this.lastMeasuredTs = m.tsNs;
  }

  private trackGaps(tsNs: Nanos): void {
    if (this.dropPending) {
      this.dropPending = false;
      this.lastDropTs = tsNs;
    }
    const last = this.lastFrameTs;
    if (last !== null) {
      const gap = tsNs - last;
      if (gap > this.cfg.dropGapFactor * framePeriodNs(this.cfg)) {
        const missed = Math.floor(gap / framePeriodNs(this.cfg) + 0.5) - 1;
        if (missed > 0) {
          this.drops += missed;
          this.lastDropTs = tsNs;
        }
      }
    }
    if (this.seedTs === null) this.seedTs = tsNs;
    this.lastFrameTs = tsNs;
  }

  private calibrationFrame(m: FrameMeasurement): void {
    if (m.deltaFullLag2 !== null) this.calibratorLag2.addSample(m.deltaFullLag2);
    const step = this.calibrator.addSample(m.deltaFull);
    if (step === "RESTARTED") {
      // as duas janelas precisam cobrir as mesmas amostras para a decisão de flicker valer
      this.calibratorLag2.reset();
    } else if (step === "DONE") {
      let stats = this.calibrator.stats;
      let th = this.calibrator.threshold!;
      const s2 = this.calibratorLag2.stats;
      if (
        this.cfg.flickerAuto &&
        s2.count >= this.cfg.calibrationSamples - 1 &&
        s2.mean < this.cfg.flickerRatio * stats.mean
      ) {
        stats = s2;
        th = computeThreshold(this.cfg, s2.mean, s2.sigma);
        this.lag = 2;
        this.emit({ kind: "setReferenceLag", lag: 2 });
      }
      this.threshold = th;
      this.noiseSigmaPx = stats.mean / MEAN_ABS_DIFF_TO_SIGMA;
      this.emit({ kind: "updateBackground" });
      this.go(this.afterCalibration);
    } else if (step === "FAILED") {
      this.fail("calibrationUnstable");
    }
  }

  private armedFrame(m: FrameMeasurement, confirming: PhotocellState): void {
    const th = this.threshold;
    if (th === null) return;
    // A chegada é armada por um wake-up; o tempo do QUADRO é a verdade. Sem esta guarda, um desvio
    // entre as bases aceitaria a chegada antes da janela cega e daria um tempo curto demais.
    const st = this.start;
    if (confirming === PhotocellState.CONFIRMING_FINISH && st !== null && m.tsNs < st.rawTsNs + this.cfg.finishArmNs) {
      return;
    }
    if (m.deltaCore > th) {
      const ld = this.lastDropTs;
      const degraded = ld !== null && Math.abs(m.tsNs - ld) < this.cfg.degradedDropWindowNs;
      // cópias: os buffers do differencer rotacionam no próximo quadro
      const inp = new CrossingInput(
        m.tsNs,
        m.prevTsNs,
        m.stripPrev.slice(),
        m.stripCur.slice(),
        m.stripBg.slice(),
        m.lag,
      );
      inp.lastSeenTsNs = this.lastMeasuredTs ?? this.seedTs;
      this.candidate = new Candidate(inp, degraded);
      this.go(confirming);
    } else if (m.deltaFull <= th) {
      this.emit({ kind: "updateBackground" });
    }
  }

  private confirmingFrame(m: FrameMeasurement, back: PhotocellState, isStart: boolean): void {
    const c = this.candidate;
    if (c === null) return;
    const th = this.threshold;
    if (th === null) return;
    c.seen += 1;
    if (c.seen === this.lag) {
      c.inp.nextStrip = m.stripCur.slice();
      c.inp.nextTsNs = m.tsNs;
    }
    if (c.seen === 2 * this.lag) {
      c.inp.plateauStrip = m.stripCur.slice();
      c.inp.plateauTsNs = m.tsNs;
    }
    if (m.deltaBackground > th * this.cfg.backgroundThresholdMultiplier) c.confirmed += 1;
    if (c.confirmed >= this.cfg.confirmRequired && c.seen >= 2 * this.lag) {
      const est = estimateCrossing(this.cfg, this.roi, this.planeHeight, c.inp, this.noiseSigmaPx);
      const info: TriggerInfo = {
        rawTsNs: c.inp.tsNs,
        refinedTsNs: est.refinedTsNs,
        quality: est.quality,
        uncertaintyNs: est.uncertaintyNs,
        interiorCount: est.interiorCount,
        degraded: c.degraded,
        texturedColumns: est.texturedColumns,
      };
      this.candidate = null;
      if (isStart) this.triggerStart(info);
      else this.triggerFinish(info);
    } else if (c.seen >= this.cfg.confirmWindow) {
      this.candidate = null;
      this.go(back);
    }
  }

  private triggerStart(info: TriggerInfo): void {
    this.start = info;
    this.thresholdStart = this.threshold ?? 0.0;
    this.emit({ kind: "feedback", feedback: "start" });
    this.setDelivery(false);
    this.go(PhotocellState.DEBOUNCE_START);
    const s = info.rawTsNs;
    this.schedule(s + this.cfg.startLockoutNs);
    this.schedule(s + this.cfg.frameResumeNs);
    this.schedule(s + this.cfg.finishArmNs);
  }

  private triggerFinish(info: TriggerInfo): void {
    this.finish = info;
    this.emit({ kind: "feedback", feedback: "finish" });
    this.setDelivery(false);
    this.go(PhotocellState.DEBOUNCE_FINISH);
    this.schedule(info.rawTsNs + this.cfg.finishLockoutNs);
  }

  private finishRun(): void {
    const s = this.start;
    const f = this.finish;
    if (s === null || f === null) return;
    this.result = {
      start: s,
      finish: f,
      elapsedRawNs: f.rawTsNs - s.rawTsNs,
      elapsedRefinedNs: f.refinedTsNs - s.refinedTsNs,
      drops: this.drops,
      degraded: s.degraded || f.degraded,
      thresholdStart: this.thresholdStart,
      thresholdFinish: this.threshold ?? 0.0,
    };
    this.go(PhotocellState.FINISHED);
  }
}
