/**
 * Leitura EXATA dos quadros: demultiplexa o arquivo (MP4/MOV — o que o iPhone grava) e decodifica
 * com WebCodecs, sem depender da reprodução.
 *
 * Por que existe: o caminho por `requestVideoFrameCallback` depende de o navegador APRESENTAR cada
 * quadro, e ele pula quadros quando a máquina aperta — medido aqui: ~3% de perda num clipe de 240
 * FPS. Perder um quadro perto do gatilho derruba o refinamento sub-quadro. O decodificador entrega
 * todos os quadros, com o carimbo de tempo que está no arquivo (resolução do `timescale`, não
 * arredondado em milissegundos como no WebM), e ainda por cima roda mais rápido que a reprodução.
 *
 * O plano de leitura fica assim: este caminho primeiro; o da reprodução como reserva.
 */
import { createFile, DataStream, type MP4ArrayBuffer, type MP4File, type MP4Info, type Sample } from "mp4box";

import type { StripFrame } from "./videoStripReader.ts";

export interface DecodeStats {
  received: number;
  expected: number;
  worstGapPeriods: number;
  medianPeriodNs: number;
  /** Codec do arquivo (para o diagnóstico honesto na tela). */
  codec: string;
}

export interface DecodeOptions {
  x: number;
  width: number;
  y0: number;
  y1: number;
  onProgress?: (fraction: number, received: number) => void;
  signal?: AbortSignal;
}

export function supportsWebCodecs(): boolean {
  return typeof VideoDecoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/** Descrição do codec (avcC/hvcC) exigida pelo VideoDecoder para H.264/HEVC. */
function descricao(arquivo: MP4File, trackId: number): Uint8Array | undefined {
  const trak = (arquivo as unknown as { getTrackById: (id: number) => any }).getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (!box) continue;
    if (!entry.avcC && !entry.hvcC) return undefined; // VP9/AV1 dispensam descrição
    const fluxo = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    box.write(fluxo);
    return new Uint8Array(fluxo.buffer, 8); // sem o cabeçalho do box
  }
  return undefined;
}

/**
 * Decodifica o vídeo inteiro entregando SÓ a faixa de luma de cada quadro.
 * Lança se o arquivo não for MP4/MOV ou se o navegador não tiver WebCodecs — quem chama cai para o
 * caminho da reprodução.
 */
export async function decodeStrips(
  file: Blob,
  opts: DecodeOptions,
  onFrame: (f: StripFrame) => void,
): Promise<DecodeStats> {
  if (!supportsWebCodecs()) throw new Error("navegador sem WebCodecs");
  const largura = opts.width;
  const altura = opts.y1 - opts.y0;
  if (largura < 1 || altura < 1) throw new Error("faixa vazia");

  const arquivo = createFile();
  const amostras: Sample[] = [];
  let info: MP4Info | null = null;
  let timescale = 0;
  let codec = "";
  let trackId = 0;

  await new Promise<void>((resolve, reject) => {
    arquivo.onError = (e: string) => reject(new Error(`não consegui ler o arquivo: ${e}`));
    arquivo.onReady = (i: MP4Info) => {
      info = i;
      const trilha = i.videoTracks?.[0];
      if (!trilha) {
        reject(new Error("o arquivo não tem trilha de vídeo"));
        return;
      }
      trackId = trilha.id;
      timescale = trilha.timescale;
      codec = trilha.codec;
      arquivo.setExtractionOptions(trilha.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
      arquivo.start();
    };
    arquivo.onSamples = (_id: number, _user: unknown, s: Sample[]) => {
      amostras.push(...s);
    };
    file
      .arrayBuffer()
      .then((buf) => {
        const mp4 = buf as MP4ArrayBuffer;
        mp4.fileStart = 0;
        arquivo.appendBuffer(mp4);
        arquivo.flush();
        resolve();
      })
      .catch(reject);
  });

  if (amostras.length === 0) throw new Error("nenhum quadro encontrado no arquivo");
  const trilha = info!.videoTracks![0];
  const config: VideoDecoderConfig = {
    codec,
    codedWidth: trilha.video.width,
    codedHeight: trilha.video.height,
    description: descricao(arquivo, trackId),
    hardwareAcceleration: "no-preference",
  };
  const suporte = await VideoDecoder.isConfigSupported(config);
  if (!suporte.supported) throw new Error(`este navegador não decodifica ${codec}`);

  // canvas de apoio: recorta a faixa do quadro decodificado
  const canvas = document.createElement("canvas");
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false })!;

  const tempos: number[] = [];
  let recebidos = 0;
  let erro: Error | null = null;

  const decoder = new VideoDecoder({
    output: (quadro: VideoFrame) => {
      try {
        if (opts.signal?.aborted) return;
        ctx.drawImage(quadro, opts.x, opts.y0, largura, altura, 0, 0, largura, altura);
        const img = ctx.getImageData(0, 0, largura, altura).data;
        const luma = new Uint8Array(largura * altura);
        for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
          luma[i] = (0.2126 * img[p] + 0.7152 * img[p + 1] + 0.0722 * img[p + 2] + 0.5) | 0;
        }
        // `timestamp` vem em microssegundos do próprio arquivo
        const tsNs = Math.round(quadro.timestamp * 1000);
        tempos.push(tsNs);
        recebidos += 1;
        onFrame({ tsNs, luma });
        if (recebidos % 30 === 0) opts.onProgress?.(recebidos / amostras.length, recebidos);
      } finally {
        quadro.close();
      }
    },
    error: (e: DOMException) => {
      erro = new Error(`falha ao decodificar: ${e.message}`);
    },
  });
  decoder.configure(config);

  for (const s of amostras) {
    if (opts.signal?.aborted) break;
    decoder.decode(
      new EncodedVideoChunk({
        type: s.is_sync ? "key" : "delta",
        timestamp: (s.cts * 1e6) / s.timescale,
        duration: (s.duration * 1e6) / s.timescale,
        data: s.data,
      }),
    );
    // não deixar a fila crescer sem limite (memória do celular)
    if (decoder.decodeQueueSize > 120) {
      await new Promise<void>((r) => {
        const esperar = () => (decoder.decodeQueueSize <= 60 ? r() : setTimeout(esperar, 4));
        esperar();
      });
    }
  }
  await decoder.flush();
  decoder.close();
  if (erro) throw erro;
  if (opts.signal?.aborted) throw new DOMException("cancelado", "AbortError");

  const deltas: number[] = [];
  for (let i = 1; i < tempos.length; i++) deltas.push(tempos[i] - tempos[i - 1]);
  deltas.sort((a, b) => a - b);
  const medianPeriodNs = deltas.length > 0 ? deltas[Math.floor(deltas.length / 2)] : 0;
  let worstGapPeriods = 1;
  if (medianPeriodNs > 0) {
    for (const d of deltas) {
      const g = d / medianPeriodNs;
      if (g > worstGapPeriods) worstGapPeriods = g;
    }
  }
  return {
    received: recebidos,
    expected: amostras.length,
    worstGapPeriods,
    medianPeriodNs,
    codec,
  };
}
