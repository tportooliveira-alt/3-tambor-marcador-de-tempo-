/**
 * Lê um vídeo quadro a quadro e entrega SÓ a faixa (ROI) de luma de cada quadro — o equivalente
 * web do GlStripReader do Android.
 *
 * Como funciona: `requestVideoFrameCallback` avisa a cada quadro APRESENTADO, com o `mediaTime` do
 * contêiner (o relógio do arquivo). Tocando devagar (`playbackRate`), o navegador apresenta todos os
 * quadros de um clipe de 240 FPS mesmo num display de 60 Hz. Cada quadro é desenhado recortado num
 * canvas do tamanho da faixa e convertido para luma BT.709.
 *
 * O contador de quadros é parte do produto, não diagnóstico: se o navegador não apresentar todos os
 * quadros, a passada tem de sair marcada — não silenciosamente errada.
 */
export interface StripFrame {
  /** Relógio do arquivo, em nanossegundos. */
  tsNs: number;
  /** Faixa em luma 0..255, linha a linha (width × height). */
  luma: Uint8Array;
}

export interface ReaderStats {
  /** Quadros efetivamente entregues. */
  received: number;
  /** Quadros esperados pelo tempo do clipe e pela taxa medida. */
  expected: number;
  /** Maior intervalo entre quadros consecutivos, em períodos. */
  worstGapPeriods: number;
  /** Período mediano entre quadros (ns) — de onde sai a taxa real do arquivo. */
  medianPeriodNs: number;
}

export interface ReaderOptions {
  /** Retângulo da faixa em pixels do vídeo. */
  x: number;
  width: number;
  y0: number;
  y1: number;
  /**
   * Período entre quadros (ns), medido antes por `probeFramePeriod`. É ele que vira o relógio: o
   * `mediaTime` do contêiner é arredondado (1 ms no WebM), o que arruinaria o milésimo; o índice do
   * quadro, não. Clipe de câmera lenta é de taxa constante — o índice É o relógio.
   */
  periodNs?: number;
  /** Velocidade de reprodução; mais devagar = menos risco de o navegador pular quadros. */
  playbackRate?: number;
  onProgress?: (fraction: number, received: number) => void;
  signal?: AbortSignal;
}

interface RVFCMetadata {
  mediaTime: number;
  presentedFrames: number;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: RVFCMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function supportsFrameCallback(): boolean {
  return typeof (HTMLVideoElement.prototype as unknown as RVFCVideo).requestVideoFrameCallback === "function";
}

/**
 * Mede a taxa real do arquivo tocando os primeiros quadros (sem desenhar nada): o iPhone grava
 * câmera lenta a 240 FPS, mas o mesmo app grava 120 e 30 — e a análise inteira depende de saber
 * qual é. Devolve o período mediano em nanossegundos (0 se não deu para medir).
 */
export async function probeFramePeriod(file: Blob, samples = 24): Promise<number> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video") as RVFCVideo;
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  const times: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("não consegui abrir o vídeo")), { once: true });
    });
    if (!supportsFrameCallback()) return 0;
    video.playbackRate = 0.1;
    await video.play();
    await new Promise<void>((resolve) => {
      let last = -1;
      const step = (_now: number, meta: RVFCMetadata) => {
        if (meta.mediaTime > last) {
          last = meta.mediaTime;
          times.push(Math.round(meta.mediaTime * 1e9));
        }
        if (times.length >= samples || video.ended) {
          resolve();
          return;
        }
        video.requestVideoFrameCallback!(step);
      };
      video.addEventListener("ended", () => resolve(), { once: true });
      video.requestVideoFrameCallback!(step);
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
  if (times.length < 3) return 0;
  // O `mediaTime` vem arredondado pelo contêiner (o WebM guarda em milissegundos) e o navegador pode
  // não apresentar TODOS os quadros nem nesta sondagem — então nem a mediana dos intervalos nem o
  // span dividido pela contagem servem. O que serve: cada intervalo é um número INTEIRO de períodos.
  // Estima-se o período pelo menor intervalo, classifica-se cada intervalo em quantos períodos ele
  // vale, e o período final é o span dividido pelo total de períodos — imune ao arredondamento e a
  // quadros que faltem.
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  let p = Math.min(...deltas);
  if (!(p > 0)) return 0;
  for (let iter = 0; iter < 3; iter++) {
    let total = 0;
    for (const d of deltas) total += Math.max(1, Math.round(d / p));
    const novo = (times[times.length - 1] - times[0]) / total;
    if (!(novo > 0)) break;
    p = novo;
  }
  return p;
}

/**
 * Percorre o vídeo inteiro chamando `onFrame` para cada quadro apresentado. Devolve as estatísticas
 * de quadros — quem chama decide se a leitura foi confiável.
 */
export async function readStrips(
  file: Blob,
  opts: ReaderOptions,
  onFrame: (f: StripFrame) => void,
): Promise<ReaderStats> {
  const width = opts.width;
  const height = opts.y1 - opts.y0;
  if (width < 1 || height < 1) throw new Error("faixa vazia");

  const url = URL.createObjectURL(file);
  const video = document.createElement("video") as RVFCVideo;
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // sem isso o iOS pode recusar a reprodução programática
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error("canvas 2D indisponível");

  const indices: number[] = [];
  let received = 0;
  let duration = 0;
  const periodNs = opts.periodNs && opts.periodNs > 0 ? opts.periodNs : 0;

  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("não consegui abrir o vídeo")), { once: true });
    });
    duration = video.duration;
    if (!(duration > 0)) throw new Error("vídeo sem duração conhecida");
    if (!supportsFrameCallback()) {
      throw new Error("este navegador não entrega os quadros do vídeo (requestVideoFrameCallback)");
    }

    video.playbackRate = opts.playbackRate ?? 0.1;
    await video.play();

    await new Promise<void>((resolve, reject) => {
      let lastMedia = -1;
      let lastMediaNs = -1;
      let idx = 0;
      const step = (_now: number, meta: RVFCMetadata) => {
        if (opts.signal?.aborted) {
          video.pause();
          reject(new DOMException("cancelado", "AbortError"));
          return;
        }
        // o mesmo quadro pode ser reapresentado (pausa, buffering): só conta o que avança
        if (meta.mediaTime > lastMedia) {
          lastMedia = meta.mediaTime;
          ctx.drawImage(video, opts.x, opts.y0, width, height, 0, 0, width, height);
          const img = ctx.getImageData(0, 0, width, height).data;
          const luma = new Uint8Array(width * height);
          for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
            // luma BT.709 sobre os valores já decodificados pelo navegador
            luma[i] = (0.2126 * img[p] + 0.7152 * img[p + 1] + 0.0722 * img[p + 2] + 0.5) | 0;
          }
          // Índice do quadro, avançado pelo intervalo LOCAL: cada passo só precisa acertar se
          // andou 1, 2 ou 3 períodos — decisão folgada com quantização de 1 ms contra 4,17 ms — e
          // por ser incremental o arredondamento nunca se acumula ao longo do clipe.
          const mediaNs = meta.mediaTime * 1e9;
          if (periodNs > 0) {
            idx = lastMediaNs < 0 ? Math.round(mediaNs / periodNs) : idx + Math.max(1, Math.round((mediaNs - lastMediaNs) / periodNs));
          } else {
            idx = received;
          }
          lastMediaNs = mediaNs;
          const tsNs = periodNs > 0 ? Math.round(idx * periodNs) : Math.round(mediaNs);
          indices.push(idx);
          received += 1;
          onFrame({ tsNs, luma });
          opts.onProgress?.(Math.min(1, meta.mediaTime / duration), received);
        }
        if (video.ended) {
          resolve();
          return;
        }
        video.requestVideoFrameCallback!(step);
      };
      video.addEventListener("ended", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("erro ao ler o vídeo")), { once: true });
      video.requestVideoFrameCallback!(step);
    });
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }

  // quantos quadros o navegador deixou de apresentar: buracos na sequência de índices
  let worstGapPeriods = 1;
  for (let i = 1; i < indices.length; i++) {
    const g = indices[i] - indices[i - 1];
    if (g > worstGapPeriods) worstGapPeriods = g;
  }
  const span = indices.length > 1 ? indices[indices.length - 1] - indices[0] + 1 : received;
  const porDuracao = periodNs > 0 ? Math.round((duration * 1e9) / periodNs) : received;
  // o esperado é o maior entre o alcance dos índices vistos e o que a duração promete
  const expected = Math.max(span, porDuracao);
  return { received, expected, worstGapPeriods, medianPeriodNs: periodNs };
}
