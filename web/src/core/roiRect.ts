/**
 * Faixa vertical (Região de Interesse) em coordenadas de pixel do plano de luma.
 * `y1` é exclusivo. Endereço(x, y) = base + y*stride + x.
 */
export class RoiRect {
  readonly x: number;
  readonly width: number;
  readonly y0: number;
  readonly y1: number;

  constructor(x: number, width: number, y0: number, y1: number) {
    this.x = x;
    this.width = width;
    this.y0 = y0;
    this.y1 = y1;
  }

  get height(): number {
    return this.y1 - this.y0;
  }

  coreX0(coreWidth: number): number {
    return this.x + Math.floor((this.width - coreWidth) / 2);
  }

  validate(planeWidth: number, planeHeight: number, coreWidth: number): void {
    if (!(this.width >= 1 && this.height >= 1)) throw new Error("ROI vazia");
    if (!(this.x >= 0 && this.x + this.width <= planeWidth)) throw new Error("ROI fora do plano em x");
    if (!(this.y0 >= 0 && this.y1 <= planeHeight)) throw new Error("ROI fora do plano em y");
    if (!(coreWidth >= 1 && coreWidth <= this.width)) throw new Error("coreWidth inválido");
  }
}
