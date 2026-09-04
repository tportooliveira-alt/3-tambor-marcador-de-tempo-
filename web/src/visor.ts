/**
 * Visor ao vivo: mirar o tripé, achar a altura da banda, conferir a luz — e cronometrar na hora.
 *
 * Duas coisas moram aqui, e é bom não confundi-las:
 *
 * 1. **Mirar.** O visor usa o MESMO objeto `roi` da análise, então apontar ao vivo já deixa a faixa
 *    no lugar certo para o vídeo que vem a seguir — em vez de posicionar a linha depois, num quadro
 *    congelado, adivinhando por onde o cavalo passou.
 * 2. **Cronometrar ao vivo.** A máquina de estados é a mesma do arquivo; o que muda é a física da
 *    captura: pelo navegador a câmera entrega 30 ou 60 quadros por segundo, contra 240 do arquivo em
 *    câmera lenta. Quanto isso custa em milésimos NÃO se supõe aqui — cada passada sai com a
 *    incerteza que o próprio estimador calculou, e a conferência contra a fotocélula oficial é que
 *    diz se o caminho ao vivo serve.
 *
 * O relógio dos quadros é o do quadro, não o do monitor: `requestVideoFrameCallback` dispara uma vez
 * por quadro da câmera e traz o carimbo daquele quadro. Com `requestAnimationFrame` (o laço antigo)
 * uma câmera de 30 quadros num monitor de 60 Hz era processada DUAS vezes por quadro — a repetição
 * entrava na calibragem de ruído como se a cena estivesse parada, e a "taxa medida" era a do monitor,
 * que ia direto para o período do estimador.
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

/** O que o `requestVideoFrameCallback` entrega — só os campos que interessam aqui. */
interface QuadroMeta {
  mediaTime: number;
  presentationTime: number;
  presentedFrames: number;
}

type VideoComCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (agora: number, meta: QuadroMeta) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Calibragem mais curta que a do arquivo (240 amostras), de propósito: a 30 quadros por segundo,
 * 240 amostras são 8 segundos de tela dizendo "medindo a cena parada…", o que parece travamento.
 * 60 amostras são 2 s a 30 quadros e 1 s a 60 — o bastante para média e desvio-padrão do ruído.
 */
const AMOSTRAS_CALIBRACAO = 60;

/** Intervalo plausível entre dois quadros de câmera, em ms. Fora disso houve buraco. */
const DT_MIN_MS = 0.5;
const DT_MAX_MS = 500;

/** Estado de uma sessão do visor. Só existe uma por vez. */
export class Visor {
  private stream: MediaStream | null = null;
  private readonly video: VideoComCallback;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roi: VisorRoi;
  private readonly cb: VisorCallbacks;
  private rodando = false;
  private timer = 0;
  private handleQuadro = 0;
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
  /** Verdadeiro quando os quadros chegam por `requestVideoFrameCallback` (um por quadro da câmera). */
  private porQuadro = false;
  /** Carimbo do quadro anterior, em ms, na base de tempo escolhida. */
  private ultimoQuadroMs = -1;
  /** `mediaTime` é o carimbo do próprio quadro; só se ele se mostrar inútil é que se usa o da tela. */
  private usarMediaTime = true;
  private quadrosVistos = 0;
  private ultimoPresented = -1;
  private perdidos = 0;
  /**
   * Ensaio: aceita a chegada poucos segundos depois da largada, para testar com a mão. Numa prova de
   * verdade as janelas longas é que protegem — o rabo do cavalo e a poeira passam na linha logo
   * depois da largada, e com janela curta parariam o cronômetro.
   */
  ensaio = false;

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, roi: VisorRoi, cb: VisorCallbacks) {
    this.video = video as VideoComCallback;
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

  /** Quadros que a câmera produziu e a página não recebeu. Entra no registro da passada. */
  get quadrosPerdidos(): number {
    return this.perdidos;
  }

  /** Um quadro da câmera por chamada (`true`) ou o laço da tela, que repete quadros (`false`). */
  get porQuadroDaCamera(): boolean {
    return this.porQuadro;
  }

  get armado(): boolean {
    return this.cronometrando;
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
    this.porQuadro = typeof this.video.requestVideoFrameCallback === "function";
    if (this.porQuadro) this.agendarQuadro();
    else this.timer = requestAnimationFrame(this.laco);
  }

  /**
   * Desligar a câmera ao sair NÃO é detalhe: câmera ligada aquece o aparelho, e aparelho quente é o
   * que faz o iPhone baixar a taxa de captura na hora de gravar a passada.
   */
  fechar(): void {
    this.rodando = false;
    cancelAnimationFrame(this.timer);
    this.video.cancelVideoFrameCallback?.(this.handleQuadro);
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
    this.ultimoQuadroMs = -1;
    this.quadrosVistos = 0;
    this.ultimoPresented = -1;
    this.perdidos = 0;
    this.usarMediaTime = true;
  }

  /**
   * Arma o cronômetro ao vivo.
   *
   * A precisão aqui é outra, e não se finge o contrário: a taxa é a que o navegador entregar, a
   * duração de exposição não é informada por API nenhuma (assume-se E = P, a hipótese mais
   * generosa), e o resultado sai com a incerteza que o estimador conseguir sustentar — quando a
   * hipótese não se sustenta, ele cai para qualidade 1 ou 0 com intervalo largo, que é o
   * comportamento honesto.
   */
  armar(): void {
    if (this.differencer === null || this.limiar === null) return;
    const cfg = { ...this.cfg };
    cfg.frameRateHz = Math.max(15, Math.round(this.fps || 30));
    cfg.exposureNs = Math.round(1e9 / cfg.frameRateHz);
    // vídeo de câmera traz curva de tom, como o arquivo: linearizar antes da fração de exposição
    cfg.gamma = 2.2;
    if (this.ensaio) {
      cfg.startLockoutNs = 500_000_000;
      cfg.frameResumeNs = 1_500_000_000;
      cfg.finishArmNs = 2_000_000_000;
      cfg.finishLockoutNs = 500_000_000;
    }
    this.engine = new PhotocellEngine(cfg, new RoiRect(0, this.largura, 0, this.altura), this.altura);
    this.engine.seedCalibration(this.limiar, this.calibrador?.stats.sigma ?? 1.0, 1);
    this.engine.effects.length = 0;
    this.perdidos = 0;
    this.cronometrando = true;
  }

  desarmar(): void {
    this.engine = null;
    this.cronometrando = false;
  }

  /** Um quadro da câmera. `agendarQuadro` se re-agenda antes de processar, para não perder o próximo. */
  private agendarQuadro(): void {
    this.handleQuadro = this.video.requestVideoFrameCallback!((_agora, meta) => {
      if (!this.rodando) return;
      this.agendarQuadro();
      this.processar(this.carimbo(meta), meta.presentedFrames);
    });
  }

  /**
   * O carimbo do quadro, em ms.
   *
   * `mediaTime` é o tempo do PRÓPRIO quadro na linha do tempo da mídia — o análogo do que o caminho
   * de arquivo usa. `presentationTime` é quando o navegador entregou o quadro para composição, e
   * carrega o atraso do agendamento. A escolha é feita nos primeiros quadros e depois congela: mudar
   * de base de tempo no meio de uma passada trocaria o zero do cronômetro.
   */
  private carimbo(meta: QuadroMeta): number {
    const tela = Number.isFinite(meta.presentationTime) ? meta.presentationTime : performance.now();
    if (!this.usarMediaTime) return tela;
    const t = meta.mediaTime * 1000;
    if (!Number.isFinite(t)) {
      this.usarMediaTime = false;
      return tela;
    }
    if (this.quadrosVistos < 8 && this.ultimoQuadroMs >= 0) {
      const dt = t - this.ultimoQuadroMs;
      if (!(dt > DT_MIN_MS && dt < DT_MAX_MS)) {
        this.usarMediaTime = false;
        return tela;
      }
    }
    return t;
  }

  /** O laço da tela: só quando o navegador não tem `requestVideoFrameCallback`. */
  private laco = (): void => {
    if (!this.rodando) return;
    this.timer = requestAnimationFrame(this.laco);
    this.processar(performance.now(), -1);
  };

  private processar(quadroMs: number, presented: number): void {
    const v = this.video;
    if (v.readyState < 2 || v.videoWidth === 0) return;

    // Taxa real medida entre quadros DA CÂMERA (ou da tela, no caminho de reserva).
    const dt = this.ultimoQuadroMs >= 0 ? quadroMs - this.ultimoQuadroMs : 0;
    if (dt > DT_MIN_MS && dt < DT_MAX_MS) {
      this.fps = this.fps === 0 ? 1000 / dt : this.fps * 0.9 + (1000 / dt) * 0.1;
    }
    this.ultimoQuadroMs = quadroMs;
    this.quadrosVistos++;

    // Quadro que a câmera produziu e a página não recebeu: o candidato em andamento não vale mais.
    if (presented >= 0) {
      if (this.ultimoPresented >= 0 && presented > this.ultimoPresented + 1) {
        this.perdidos += presented - this.ultimoPresented - 1;
        this.engine?.framesDropped();
      }
      this.ultimoPresented = presented;
    }

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
      cfg.calibrationSamples = AMOSTRAS_CALIBRACAO;
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

    const m = this.differencer.process(luma, w, Math.round(quadroMs * 1e6));
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
      // Os efeitos NÃO são decoração: ao (re)armar a chegada a engine manda zerar o differencer, e
      // sem isso a primeira diferença depois do bloqueio compara quadros distantes e dispara sozinha.
      for (const e of eng.effects) if (e.kind === "resetDifferencer") this.differencer.reset();
      eng.effects.length = 0;
      const r = eng.result;
      const decorrido =
        eng.state === PhotocellState.RUNNING || eng.state === PhotocellState.AWAITING_FINISH
          ? m.tsNs - (eng.start?.rawTsNs ?? m.tsNs)
          : null;
      this.cb.onCronometro(eng.state, decorrido, r);
    }
  }
}
