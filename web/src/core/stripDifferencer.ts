import type { FrameMeasurement } from "./frameMeasurement.ts";
import type { Nanos } from "./nanos.ts";
import type { RoiRect } from "./roiRect.ts";

/**
 * Calcula a variação de luminância na faixa (ROI) a partir do plano de luma de cada quadro.
 *
 * Mantém apenas as duas últimas faixas (c-1 e c-2) e as referências de fundo — nunca o quadro
 * inteiro. Todos os arrays são alocados uma vez no construtor e reutilizados: NÃO há alocação por
 * quadro. A FrameMeasurement devolvida referencia os buffers rotativos (válidos até o próximo
 * `process()`); quem precisa guardar as faixas copia (o engine, no candidato).
 *
 * Com `lag == 2` (flicker de 120 Hz a 240 FPS) a comparação é feita com o quadro de mesma fase de
 * iluminação e a referência de fundo é separada por paridade do quadro.
 */
export class StripDifferencer {
  private readonly w: number;
  private readonly h: number;
  private readonly n: number;
  private readonly c0: number;

  lag = 1;

  private prev1: Int32Array | null = null;
  private prev2: Int32Array | null = null;
  private prev1Ts: Nanos = 0;
  private prev2Ts: Nanos = 0;
  private background: (Float64Array | null)[] = [null, null];
  private frameIndex = 0;

  // buffers rotativos para evitar alocação por quadro
  private readonly bufA: Int32Array;
  private readonly bufB: Int32Array;
  private readonly bufC: Int32Array;
  private nextBuf = 0;

  readonly roi: RoiRect;
  readonly planeHeight: number;
  readonly coreWidth: number;

  constructor(roi: RoiRect, planeWidth: number, planeHeight: number, coreWidth: number) {
    this.roi = roi;
    this.planeHeight = planeHeight;
    this.coreWidth = coreWidth;
    roi.validate(planeWidth, planeHeight, coreWidth);
    this.w = roi.width;
    this.h = roi.height;
    this.n = this.w * this.h;
    this.c0 = Math.floor((this.w - coreWidth) / 2);
    this.bufA = new Int32Array(this.n);
    this.bufB = new Int32Array(this.n);
    this.bufC = new Int32Array(this.n);
  }

  reset(): void {
    this.prev1 = null;
    this.prev2 = null;
    this.prev1Ts = 0;
    this.prev2Ts = 0;
    this.background[0] = null;
    this.background[1] = null;
    this.frameIndex = 0;
  }

  setLag(newLag: number): void {
    const l = newLag === 2 ? 2 : 1;
    if (l !== this.lag) {
      // as referências acumuladas misturam fases de iluminação: ressemear por paridade
      this.background[0] = null;
      this.background[1] = null;
    }
    this.lag = l;
  }

  private bgIndex(frameIdx: number): number {
    return this.lag === 2 ? frameIdx & 1 : 0;
  }

  private takeBuffer(): Int32Array {
    const b = this.nextBuf === 0 ? this.bufA : this.nextBuf === 1 ? this.bufB : this.bufC;
    this.nextBuf = (this.nextBuf + 1) % 3;
    return b;
  }

  /**
   * Extrai a faixa do plano de luma. `plane` é o buffer do plano (posição absoluta),
   * `stride` = bytes por linha; Endereço(x, y) = y*stride + x.
   */
  private extract(plane: Uint8Array, stride: number, out: Int32Array): void {
    let k = 0;
    const { y0, y1, x } = this.roi;
    for (let y = y0; y < y1; y++) {
      const base = y * stride + x;
      for (let i = 0; i < this.w; i++) out[k++] = plane[base + i];
    }
  }

  /** Retorna null para quadros-semente (1 com lag 1, 2 com lag 2). */
  process(plane: Uint8Array, stride: number, tsNs: Nanos): FrameMeasurement | null {
    const cur = this.takeBuffer();
    this.extract(plane, stride, cur);
    const idxFrame = this.frameIndex;
    this.frameIndex += 1;
    const bi = this.bgIndex(idxFrame);
    if (this.background[bi] === null) {
      const bg = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) bg[i] = cur[i];
      this.background[bi] = bg;
    }
    const ref = this.lag === 1 ? this.prev1 : this.prev2;
    const refTs = this.lag === 1 ? this.prev1Ts : this.prev2Ts;
    if (ref === null) {
      this.prev2 = this.prev1;
      this.prev2Ts = this.prev1Ts;
      this.prev1 = cur;
      this.prev1Ts = tsNs;
      return null;
    }
    const bg = this.background[bi]!;
    let sumFull = 0;
    let sumCore = 0;
    let sumBg = 0;
    for (let row = 0; row < this.h; row++) {
      const o = row * this.w;
      let rowSumCore = 0;
      for (let i = 0; i < this.w; i++) {
        let d = cur[o + i] - ref[o + i];
        if (d < 0) d = -d;
        sumFull += d;
        sumBg += Math.abs(cur[o + i] - bg[o + i]);
      }
      for (let i = this.c0; i < this.c0 + this.coreWidth; i++) {
        let d = cur[o + i] - ref[o + i];
        if (d < 0) d = -d;
        rowSumCore += d;
      }
      sumCore += rowSumCore;
    }
    let lag2: number | null = null;
    const p2 = this.prev2;
    if (this.lag === 1 && p2 !== null) {
      let s2 = 0;
      for (let k = 0; k < this.n; k++) {
        let d = cur[k] - p2[k];
        if (d < 0) d = -d;
        s2 += d;
      }
      lag2 = s2 / this.n;
    }
    const m: FrameMeasurement = {
      tsNs,
      prevTsNs: refTs,
      deltaFull: sumFull / this.n,
      deltaCore: sumCore / (this.coreWidth * this.h),
      deltaBackground: sumBg / this.n,
      stripPrev: ref,
      stripCur: cur,
      stripBg: bg,
      deltaFullLag2: lag2,
      lag: this.lag,
    };
    this.prev2 = this.prev1;
    this.prev2Ts = this.prev1Ts;
    this.prev1 = cur;
    this.prev1Ts = tsNs;
    return m;
  }

  /** EMA lenta da referência de fundo (da paridade do último quadro) com a faixa atual. */
  updateBackground(alpha: number): void {
    const cur = this.prev1;
    if (cur === null) return;
    const bg = this.background[this.bgIndex(this.frameIndex - 1)];
    if (!bg) return;
    for (let i = 0; i < this.n; i++) bg[i] = bg[i] + alpha * (cur[i] - bg[i]);
  }
}
