import type { PhotocellConfig } from "./photocellConfig.ts";

/** Média/variância incremental (Welford). */
export class NoiseStats {
  count = 0;
  mean = 0;
  private m2 = 0;

  add(x: number): void {
    this.count += 1;
    const delta = x - this.mean;
    this.mean += delta / this.count;
    this.m2 += delta * (x - this.mean);
  }

  get variance(): number {
    return this.count > 1 ? this.m2 / (this.count - 1) : 0;
  }

  get sigma(): number {
    return Math.sqrt(this.variance);
  }
}

export type CalibrationStep = "COLLECTING" | "RESTARTED" | "DONE" | "FAILED";

export function computeThreshold(cfg: PhotocellConfig, mean: number, sigma: number): number {
  return Math.max(cfg.thresholdFloor, mean + cfg.thresholdSigmaK * sigma, cfg.thresholdMeanMultiplier * mean);
}

/**
 * Coleta N amostras de ΔY com a pista vazia; um outlier (> μ + kσ) reinicia a coleta
 * (até `calibrationMaxRetries` vezes) e o limiar adaptativo é max(piso, μ + kσ, m·μ).
 */
export class NoiseCalibrator {
  stats = new NoiseStats();
  retries = 0;
  threshold: number | null = null;
  failed = false;

  private cfg: PhotocellConfig;

  constructor(cfg: PhotocellConfig) {
    this.cfg = cfg;
  }

  reset(): void {
    this.stats = new NoiseStats();
    this.retries = 0;
    this.threshold = null;
    this.failed = false;
  }

  addSample(x: number): CalibrationStep {
    if (this.threshold !== null) return "DONE";
    if (this.failed) return "FAILED";
    const s = this.stats;
    if (s.count >= this.cfg.calibrationMinSamplesForOutlier) {
      if (x > s.mean + this.cfg.calibrationOutlierSigma * s.sigma) {
        this.retries += 1;
        this.stats = new NoiseStats();
        if (this.retries > this.cfg.calibrationMaxRetries) {
          this.failed = true;
          return "FAILED";
        }
        return "RESTARTED";
      }
    }
    s.add(x);
    if (s.count >= this.cfg.calibrationSamples) {
      this.threshold = computeThreshold(this.cfg, s.mean, s.sigma);
      return "DONE";
    }
    return "COLLECTING";
  }
}
