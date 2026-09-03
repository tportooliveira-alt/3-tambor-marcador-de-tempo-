import { NS_PER_SEC, type Nanos } from "./nanos.ts";

/**
 * Todos os parâmetros ajustáveis do algoritmo — os mesmos nomes e valores do núcleo Kotlin, do
 * núcleo Swift e da referência Python (`Tools/photocell_reference.py`). Manter os quatro em sincronia.
 */
export interface PhotocellConfig {
  frameRateHz: number;
  /** DEBOUNCE_START: janela de bloqueio após a largada. */
  startLockoutNs: Nanos;
  /** RUNNING: instante (relativo à largada) em que o pipeline volta a receber quadros. */
  frameResumeNs: Nanos;
  /** RUNNING -> AWAITING_FINISH: instante em que a detecção da chegada é armada. */
  finishArmNs: Nanos;
  /** DEBOUNCE_FINISH: janela de bloqueio após a chegada. */
  finishLockoutNs: Nanos;
  calibrationSamples: number;
  calibrationMinSamplesForOutlier: number;
  calibrationOutlierSigma: number;
  calibrationMaxRetries: number;
  thresholdFloor: number;
  thresholdSigmaK: number;
  thresholdMeanMultiplier: number;
  confirmWindow: number;
  confirmRequired: number;
  backgroundThresholdMultiplier: number;
  backgroundEmaAlpha: number;
  dropGapFactor: number;
  degradedDropWindowNs: Nanos;
  /** Colunas centrais da faixa usadas para o gatilho (o "plano" da fotocélula). */
  coreWidth: number;
  /** Duração de exposição do quadro. Na câmera lenta do iPhone não é informada: usa-se E = P. */
  exposureNs: Nanos;
  /** |O - B| mínimo (níveis de luma) para um pixel participar do refinamento sub-quadro. */
  minContrast: number;
  fractionMarginMin: number;
  fractionMarginSigmas: number;
  /** Acima desta margem (contraste/ruído baixo) o pixel só fornece limites. */
  fractionMarginMax: number;
  /** Piso da incerteza reportada em qualidade 2 (erro de modelo: gamma desconhecida, desfoque). */
  systematicUncNs: Nanos;
  /** Pixels saturados (ou pretos) não seguem V = B + (O−B)f: ficam fora do ajuste e dos limites. */
  saturationLow: number;
  saturationHigh: number;
  /** Bordo inclinado (celular fora de nível): folga do limite superior do intervalo de qualidade 0. */
  q0TiltAllowancePxPerRow: number;
  /** Abertura efetiva de um pixel de luma: enquanto o bordo a atravessa, a resposta não é linear em f. */
  aperturePx: number;
  /** Faixa plausível de velocidade do bordo, em px/s. */
  speedPxPerSMin: number;
  speedPxPerSMax: number;
  /** Uma coluna só participa do ajuste com pelo menos N linhas interiores... */
  minInteriorRowsPerColumn: number;
  /** ... e pelo menos esta fração das linhas da banda. */
  minInteriorRowsFraction: number;
  /** Tempo de leitura do sensor (rolling shutter). null = ignora o offset por linha (cancela em ΔT). */
  skewNs: Nanos | null;
  readoutTopToBottom: boolean;
  /** Se ΔY(lag 2) < ratio * ΔY(lag 1) na calibração, usa o quadro c-2 como referência (flicker 120 Hz). */
  flickerRatio: number;
  flickerAuto: boolean;
  /** Curva de tom a desfazer antes da fração f (1.0 = desligado; ~2.2 para vídeo com tone curve padrão). */
  gamma: number;
}

export const defaultConfig = (): PhotocellConfig => ({
  frameRateHz: 240,
  startLockoutNs: 1_500_000_000,
  frameResumeNs: 8_000_000_000,
  finishArmNs: 10_000_000_000,
  finishLockoutNs: 2_000_000_000,
  calibrationSamples: 240,
  calibrationMinSamplesForOutlier: 30,
  calibrationOutlierSigma: 10.0,
  calibrationMaxRetries: 3,
  thresholdFloor: 4.0,
  thresholdSigmaK: 6.0,
  thresholdMeanMultiplier: 2.0,
  confirmWindow: 4,
  confirmRequired: 2,
  backgroundThresholdMultiplier: 1.0,
  backgroundEmaAlpha: 0.02,
  dropGapFactor: 1.5,
  degradedDropWindowNs: 50_000_000,
  coreWidth: 3,
  exposureNs: 2_083_333,
  minContrast: 20.0,
  fractionMarginMin: 0.03,
  fractionMarginSigmas: 4.0,
  fractionMarginMax: 0.25,
  systematicUncNs: 100_000,
  saturationLow: 5,
  saturationHigh: 250,
  q0TiltAllowancePxPerRow: 0.05,
  aperturePx: 1.5,
  speedPxPerSMin: 400.0,
  speedPxPerSMax: 12000.0,
  minInteriorRowsPerColumn: 3,
  minInteriorRowsFraction: 0.08,
  skewNs: null,
  readoutTopToBottom: true,
  flickerRatio: 0.5,
  flickerAuto: true,
  gamma: 1.0,
});

export const framePeriodNs = (cfg: PhotocellConfig): Nanos =>
  Math.floor(NS_PER_SEC / cfg.frameRateHz);

/** Janelas coerentes: os quadros voltam depois do bloqueio e a chegada arma depois de voltarem. */
export function validateConfig(cfg: PhotocellConfig): void {
  if (!(cfg.frameRateHz >= 1)) throw new Error("frameRateHz inválido");
  if (!(cfg.frameResumeNs >= cfg.startLockoutNs + 500_000_000))
    throw new Error("frameResumeNs precisa ser >= startLockoutNs + 0,5 s");
  if (!(cfg.finishArmNs >= cfg.frameResumeNs + 500_000_000))
    throw new Error("finishArmNs precisa ser >= frameResumeNs + 0,5 s");
  if (!(cfg.exposureNs >= 1 && cfg.gamma > 0)) throw new Error("exposureNs/gamma inválidos");
  // sob flicker de 120 Hz a referência vai para o quadro c−2 e o platô só chega em seen == 4
  if (!(cfg.confirmWindow >= 4)) throw new Error("confirmWindow precisa ser >= 4 (platô do estimador com lag 2)");
  if (!(cfg.confirmRequired >= 1 && cfg.confirmRequired <= cfg.confirmWindow))
    throw new Error("confirmRequired precisa estar entre 1 e confirmWindow");
}
