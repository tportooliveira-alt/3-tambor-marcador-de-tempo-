/**
 * Visor ao vivo: mirar o tripé, achar a altura da banda e conferir a luz — ANTES de gravar.
 *
 * Por que não cronometra: pelo navegador a câmera entrega 30 ou 60 quadros por segundo, então cada
 * gatilho valeria ±8 a ±17 ms. O tempo de prova continua saindo do arquivo em câmera lenta, onde há
 * 240 quadros por segundo e o refinamento sub-quadro funciona. Aqui 30 quadros bastam: ninguém
 * precisa de milésimo para apontar um tripé.
 *
 * O que ele resolve de verdade: hoje a linha é posicionada DEPOIS, num quadro congelado, com a
 * gravação já feita. O visor usa o MESMO objeto `roi` da análise, então mirar ao vivo já deixa a
 * faixa no lugar certo para o vídeo que vem a seguir.
 */
import { NoiseCalibrator } from "./core/noiseCalibrator.ts";
import { PhotocellEngine, PhotocellState, type RunResult } from "./core/photocellEngine.ts";
import { defaultConfig, type PhotocellConfig } from "./core/photocellConfig.ts";
import { RoiRect } from "./core/roiRect.ts";
import { StripDifferencer } from "./core/stripDifferencer.ts";

export interface VisorRoi {
  lineXFraction: number;
  bandTopFraction: number;
  bandBottomFraction: number;
  stripWidthPx: number;
}

export interface VisorCallbacks {
  /** Chamado a cada quadro medido: taxa real, ΔY do quadro e se passou do limiar. */
  onQuadro: (fps: number, delta: number, limiar: number | null, cruzando: boolean) => void;
  /** Estado da máquina e o cronômetro correndo, em nanossegundos desde a largada. */
  onCronometro: (estado: string, decorridoNs: number | null, resultado: RunResult | null) => void;
  onErro: (mensagem: string) => void;
}

/** Estado de uma sessão do visor. Só existe uma por vez. */
export class Visor {
  private stream: MediaStream | null = null;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roi: VisorRoi;
  private readonly cb: VisorCallbacks;
  private rodando = false;
  private timer = 0;
  private differencer: StripDifferencer | null = null;
  private calibrador: NoiseCalibrator | null = null;
  private limiar: number | null = null;
  private engine: PhotocellEngine | null = null;
  private cfg: PhotocellConfig = defaultConfig();
  /** Modo cronômetro: a FSM só roda quando o usuário arma. Mirar não deve disparar nada. */
  private cronometrando = false;
  private largura = 0;
  private altura = 0;
  private ultimoTs = 0;
  private fps = 0;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, roi: VisorRoi, cb: VisorCallbacks) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false })!;
    this.roi = roi;
    this.cb = cb;
  }

  get ativo(): boolean {
    return this.rodando;
  }

  /** A taxa real medida (não a pedida): é ela que diz o que o navegador está realmente entregando. */
  get taxaMedida(): number {
    return this.fps;
  }

  async abrir(): Promise<void> {
    if (this.rodando) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.cb.onErro("Este navegador não dá acesso à câmera. No iPhone, abra pelo Safari.");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (e) {
      const nome = (e as DOMException).name;
      this.cb.onErro(
        nome === "NotAllowedError"
          ? "Permissão de câmera negada. Toque no ícone ao lado do endereço e libere a câmera."
          : nome === "NotFoundError"
            ? "Nenhuma câmera encontrada neste aparelho."
            : `Não consegui abrir a câmera: ${(e as Error).message}`,
      );
      return;
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch {
      /* alguns navegadores só tocam depois de um toque; o quadro ainda aparece */
    }
    this.rodando = true;
    this.reiniciarMedicao();
    this.laco();
  }

  /**
   * Desligar a câmera ao sair NÃO é detalhe: câmera ligada aquece o aparelho, e aparelho quente é o
   * que faz o iPhone baixar a taxa de captura na hora de gravar a passada.
   */
  fechar(): void {
    this.rodando = false;
    cancelAnimationFrame(this.timer);
    this.video.srcObject = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }

  /** Recomeça a calibragem: usar quando a ROI muda ou a cena muda de lugar. */
  reiniciarMedicao(): void {
    this.differencer = null;
    this.calibrador = null;
    this.limiar = null;
    this.engine = null;
    this.cronometrando = false;
  }

  /**
   * Arma o cronômetro ao vivo.
   *
   * A PRECISÃO AQUI É OUTRA, e isso não é detalhe de rodapé: o navegador entrega 30 ou 60 quadros
   * por segundo, então cada gatilho vale ±8 a ±17 ms, contra ±0,8 ms do arquivo em câmera lenta.
   * Serve para treino e conferência; para prova valendo, o vídeo continua sendo o caminho.
   */
  armar(): void {
    if (this.differencer === null || this.limiar === null) return;
    const cfg = { ...this.cfg };
    cfg.frameRateHz = Math.max(15, Math.round(this.fps || 30));
    cfg.exposureNs = Math.round(1e9 / cfg.frameRateHz);
    this.engine = new PhotocellEngine(cfg, new RoiRect(0, this.largura, 0, this.altura), this.altura);
    this.engine.seedCalibration(this.limiar, this.calibrador?.stats.sigma ?? 1.0, 1);
    this.cronometrando = true;
  }

  desarmar(): void {
    this.engine = null;
    this.cronometrando = false;
  }

  private laco = (): void => {
    if (!this.rodando) return;
    this.timer = requestAnimationFrame(this.laco);
    const v = this.video;
    if (v.readyState < 2 || v.videoWidth === 0) return;

    // taxa real medida entre quadros apresentados
    const agora = performance.now();
    if (this.ultimoTs > 0) {
      const dt = agora - this.ultimoTs;
      if (dt > 0) this.fps = this.fps === 0 ? 1000 / dt : this.fps * 0.9 + (1000 / dt) * 0.1;
    }
    this.ultimoTs = agora;

    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const meia = Math.max(1, Math.floor(this.roi.stripWidthPx / 2));
    const cx = Math.round(this.roi.lineXFraction * vw);
    const x = Math.max(0, Math.min(vw - this.roi.stripWidthPx, cx - meia));
    const w = Math.min(this.roi.stripWidthPx, vw - x);
    const yA = Math.round(Math.min(this.roi.bandTopFraction, this.roi.bandBottomFraction) * vh);
    const yB = Math.round(Math.max(this.roi.bandTopFraction, this.roi.bandBottomFraction) * vh);
    const y0 = Math.max(0, Math.min(vh - 2, yA));
    const y1 = Math.max(y0 + 1, Math.min(vh, yB));
    const h = y1 - y0;
    if (w < 1 || h < 1) return;

    // a geometria mudou (ROI arrastada ou câmera trocou de resolução): recomeçar do zero
    if (w !== this.largura || h !== this.altura || this.differencer === null) {
      this.largura = w;
      this.altura = h;
      const cfg = defaultConfig();
      this.differencer = new StripDifferencer(new RoiRect(0, w, 0, h), w, h, cfg.coreWidth);
      this.calibrador = new NoiseCalibrator(cfg);
      this.limiar = null;
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(v, x, y0, w, h, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h).data;
    const luma = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      luma[i] = (0.2126 * img[p] + 0.7152 * img[p + 1] + 0.0722 * img[p + 2] + 0.5) | 0;
    }

    const m = this.differencer.process(luma, w, Math.round(agora * 1e6));
    if (m === null) {
      this.cb.onQuadro(this.fps, 0, this.limiar, false);
      return;
    }
    // Enquanto não há limiar, cada quadro parado alimenta a calibragem — o mesmo calibrador do app.
    if (this.limiar === null && this.calibrador !== null) {
      const estado = this.calibrador.addSample(m.deltaFull);
      if (estado === "DONE") this.limiar = this.calibrador.threshold;
    }
    const cruzando = this.limiar !== null && m.deltaCore > this.limiar;
    this.cb.onQuadro(this.fps, m.deltaCore, this.limiar, cruzando);

    if (this.cronometrando && this.engine !== null) {
      const eng = this.engine;
      eng.frame(m);
      // A engine pede tempos futuros (fim do bloqueio, rearme); aqui o relógio é o do quadro.
      eng.wakeup(m.tsNs);
      const r = eng.result;
      const decorrido =
        eng.state === PhotocellState.RUNNING || eng.state === PhotocellState.AWAITING_FINISH
          ? m.tsNs - (eng.start?.rawTsNs ?? m.tsNs)
          : null;
      this.cb.onCronometro(eng.state, decorrido, r);
    }
  };
}
