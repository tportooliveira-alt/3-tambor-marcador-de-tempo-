import type { Nanos } from "./nanos.ts";

/**
 * Resultado do processamento de um quadro na faixa.
 *
 * ATENÇÃO: `stripPrev`, `stripCur` e `stripBg` são REFERÊNCIAS aos buffers rotativos do
 * StripDifferencer, válidas só até o próximo `process()`. Quem precisar guardá-las (o engine, ao
 * criar um candidato) copia — ver CrossingInput.
 */
export interface FrameMeasurement {
  tsNs: Nanos;
  /** Timestamp do quadro de referência (c - lag), medido — não o nominal ts - lag·P. */
  prevTsNs: Nanos;
  /** ΔY_f: média de |Y_f - Y_ref| na faixa inteira. */
  deltaFull: number;
  /** Média de |Y_f - Y_ref| nas colunas centrais (gatilho). */
  deltaCore: number;
  /** Média de |Y_f - fundo| na faixa inteira (confirmação). */
  deltaBackground: number;
  /** Faixa inteira (W x H, linha a linha) do quadro de referência (c - lag), valores 0..255. */
  stripPrev: Int32Array;
  /** Faixa inteira do quadro atual. */
  stripCur: Int32Array;
  /** Faixa inteira da referência de fundo (mesma paridade quando lag == 2). */
  stripBg: Float64Array;
  /** ΔY contra o quadro c-2 (para detectar flicker); null se indisponível. */
  deltaFullLag2: number | null;
  /** Atraso de referência usado nesta medição (1 ou 2). */
  lag: number;
}

/**
 * Dados do candidato usados pelo estimador sub-quadro: cópias feitas ao criar o candidato mais os
 * quadros c+lag e c+2·lag com seus timestamps medidos.
 */
export class CrossingInput {
  nextTsNs: Nanos | null = null;
  nextStrip: Int32Array | null = null;
  plateauTsNs: Nanos | null = null;
  plateauStrip: Int32Array | null = null;
  /** Último quadro VISTO antes do candidato (c−1, ou antes se houve drop): intervalo honesto de q0. */
  lastSeenTsNs: Nanos | null = null;

  readonly tsNs: Nanos;
  readonly prevTsNs: Nanos;
  readonly stripPrev: Int32Array;
  readonly stripCur: Int32Array;
  readonly stripBg: Float64Array;
  readonly lag: number;

  constructor(
    tsNs: Nanos,
    prevTsNs: Nanos,
    stripPrev: Int32Array,
    stripCur: Int32Array,
    stripBg: Float64Array,
    lag: number,
  ) {
    this.tsNs = tsNs;
    this.prevTsNs = prevTsNs;
    this.stripPrev = stripPrev;
    this.stripCur = stripCur;
    this.stripBg = stripBg;
    this.lag = lag;
  }
}
