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
 *
 * MEMÓRIA (o que faz um vídeo de verdade caber num celular): um clipe de câmera lenta tem centenas
 * de megabytes, e o Safari mata a aba muito antes disso caber num ArrayBuffer só. Então nada aqui
 * lê o arquivo inteiro: primeiro mapeamos as caixas do contêiner lendo 16 bytes de cada uma
 * (`mapearCaixas`), entregamos ao mp4box só as caixas de índice (`ftyp`/`moov`/`moof`, que são
 * pequenas), e só então os dados (`mdat`) entram em fatias de 4 MB. Cada fatia é decodificada na
 * hora e devolvida (`releaseUsedSamples`), de modo que o pico de memória é o tamanho da fatia mais
 * a fila do decodificador — não o tamanho do arquivo.
 */
import { createFile, DataStream, type MP4ArrayBuffer, type MP4File, type MP4Info, type Sample } from "mp4box";

import type { StripFrame } from "./videoStripReader.ts";

/** Tamanho de cada pedaço lido do arquivo. Pequeno o bastante para caber num celular. */
const FATIA_BYTES = 4 * 1024 * 1024;

/** Uma caixa de índice maior que isto não é índice: é arquivo estranho, melhor recusar. */
const MAX_CAIXA_INDICE = 64 * 1024 * 1024;

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
  /** Progresso da decodificação: fração de quadros já entregues. */
  onProgress?: (fraction: number, received: number) => void;
  /** Progresso da LEITURA do arquivo, em bytes — é o que dá sinal de vida em vídeo grande. */
  onRead?: (bytesLidos: number, bytesTotal: number) => void;
  signal?: AbortSignal;
}

/** O que dá para saber do arquivo só pelo cabeçalho, sem decodificar nada (rápido). */
export interface FileInfo {
  width: number;
  height: number;
  fps: number;
  durationS: number;
  codec: string;
  frames: number;
}

interface Caixa {
  inicio: number;
  fim: number;
  tipo: string;
  /** Tamanho do cabeçalho da caixa (8 ou 16 bytes). */
  cabecalho: number;
}

/**
 * Percorre as caixas de primeiro nível do arquivo lendo só 16 bytes de cada uma.
 *
 * É isto que permite tratar um `.MOV` de iPhone, onde o índice (`moov`) fica NO FIM do arquivo:
 * em vez de ler tudo até chegar lá, saltamos por cima do `mdat` usando o tamanho declarado.
 * Devolve `null` quando o arquivo não tem estrutura de MP4/MOV (aí quem chama cai para o leitor
 * por reprodução).
 */
async function mapearCaixas(file: Blob): Promise<Caixa[] | null> {
  const caixas: Caixa[] = [];
  let p = 0;
  while (p + 8 <= file.size) {
    const cab = new DataView(await file.slice(p, Math.min(p + 16, file.size)).arrayBuffer());
    if (cab.byteLength < 8) break;
    const tipo = String.fromCharCode(cab.getUint8(4), cab.getUint8(5), cab.getUint8(6), cab.getUint8(7));
    if (!/^[\x20-\x7e]{4}$/.test(tipo)) return null;
    let tamanho = cab.getUint32(0);
    let cabecalho = 8;
    if (tamanho === 1) {
      if (cab.byteLength < 16) return null;
      tamanho = cab.getUint32(8) * 4294967296 + cab.getUint32(12);
      cabecalho = 16;
    } else if (tamanho === 0) {
      tamanho = file.size - p; // caixa até o fim do arquivo
    }
    if (tamanho < cabecalho) return null;
    const fim = Math.min(p + tamanho, file.size);
    if (tipo !== "mdat" && fim - p > MAX_CAIXA_INDICE) return null;
    caixas.push({ inicio: p, fim, tipo, cabecalho });
    p = fim;
  }
  return caixas.length > 0 ? caixas : null;
}

/**
 * Onde termina o que o 1º passe entrega ao mp4box: uma caixa de índice inteira, ou só o cabeçalho
 * de um `mdat` (o bastante para o mp4box saber o tamanho e saltar por cima).
 */
function fimDoIndice(c: Caixa): number {
  return c.tipo === "mdat" ? Math.min(c.inicio + c.cabecalho, c.fim) : c.fim;
}

/** Entrega ao mp4box um trecho do arquivo, já com a posição absoluta que ele exige. */
async function anexar(arquivo: MP4File, file: Blob, inicio: number, fim: number): Promise<number> {
  if (fim <= inicio) return 0;
  const buf = (await file.slice(inicio, fim).arrayBuffer()) as MP4ArrayBuffer;
  buf.fileStart = inicio;
  arquivo.appendBuffer(buf);
  return fim - inicio;
}

/**
 * Lê só os cabeçalhos do MP4/MOV e devolve a taxa REAL de quadros do arquivo. É instantâneo (não
 * decodifica nada) e é o que permite avisar o usuário ANTES de analisar que ele gravou em velocidade
 * normal em vez de câmera lenta — a diferença entre o milésimo e ±17 ms por gatilho.
 */
export async function probeFileInfo(file: Blob): Promise<FileInfo | null> {
  try {
    const caixas = await mapearCaixas(file);
    if (!caixas) return null;
    const arquivo = createFile();
    let info: MP4Info | null = null;
    let falhou = false;
    arquivo.onError = () => {
      falhou = true;
    };
    arquivo.onReady = (i: MP4Info) => {
      info = i;
    };
    for (const caixa of caixas) {
      if (info || falhou) break;
      await anexar(arquivo, file, caixa.inicio, fimDoIndice(caixa));
    }
    arquivo.flush();
    const t = (info as MP4Info | null)?.videoTracks?.[0];
    if (!t) return null;
    const durationS = t.duration / t.timescale;
    return {
      width: t.video.width,
      height: t.video.height,
      fps: durationS > 0 ? t.nb_samples / durationS : 0,
      durationS,
      codec: t.codec,
      frames: t.nb_samples,
    };
  } catch {
    return null;
  }
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

  const caixas = await mapearCaixas(file);
  if (!caixas) throw new Error("o arquivo não parece ser MP4/MOV");

  const arquivo = createFile();
  let info: MP4Info | null = null;
  let falha: Error | null = null;
  let trackId = 0;
  let codec = "";
  let esperados = 0;

  arquivo.onError = (e: string) => {
    falha = new Error(`não consegui ler o arquivo: ${e}`);
  };
  arquivo.onReady = (i: MP4Info) => {
    info = i;
  };

  // ── 1º passe: só o índice (ftyp/moov/moof + cabeçalhos dos mdat). São poucos kilobytes.
  // Vai até o fim da lista se preciso: num `.MOV` de iPhone o `moov` fica DEPOIS do `mdat`.
  let lidos = 0;
  const entregue = new Array<number>(caixas.length).fill(0);
  for (let i = 0; i < caixas.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelado", "AbortError");
    const ate = fimDoIndice(caixas[i]);
    lidos += await anexar(arquivo, file, caixas[i].inicio, ate);
    entregue[i] = ate;
    if (falha) throw falha;
    if (info) break;
  }
  if (!info) {
    arquivo.flush();
    if (falha) throw falha;
  }
  const trilha = (info as MP4Info | null)?.videoTracks?.[0];
  if (!trilha) throw new Error("o arquivo não tem trilha de vídeo");
  trackId = trilha.id;
  codec = trilha.codec;
  esperados = trilha.nb_samples;

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
        if (recebidos % 30 === 0 && esperados > 0) opts.onProgress?.(recebidos / esperados, recebidos);
      } finally {
        quadro.close();
      }
    },
    error: (e: DOMException) => {
      erro = new Error(`falha ao decodificar: ${e.message}`);
    },
  });
  decoder.configure(config);

  // As amostras são decodificadas DENTRO do callback e devolvidas ao mp4box na mesma hora: nada de
  // acumular o arquivo comprimido inteiro numa lista.
  arquivo.onSamples = (id: number, _user: unknown, amostras: Sample[]) => {
    if (amostras.length === 0) return;
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
    }
    arquivo.releaseUsedSamples(id, amostras[amostras.length - 1].number);
  };
  arquivo.setExtractionOptions(trackId, null, { nbSamples: 60 });
  arquivo.start();

  const esperarFila = async (teto: number, piso: number): Promise<void> => {
    if (decoder.decodeQueueSize <= teto) return;
    await new Promise<void>((r) => {
      const esperar = () => (decoder.decodeQueueSize <= piso || opts.signal?.aborted ? r() : setTimeout(esperar, 4));
      esperar();
    });
  };

  // ── 2º passe: tudo o que ficou faltando, na ordem do arquivo e em fatias. Cada fatia vira
  // quadros e é liberada antes da seguinte. Percorrer TODAS as caixas (não só os `mdat`) é o que
  // faz o MP4 fragmentado funcionar: ali os índices de cada trecho (`moof`) ficam espalhados pelo
  // arquivo, depois do `moov` que disparou o 1º passe.
  opts.onRead?.(lidos, file.size);
  for (let i = 0; i < caixas.length; i++) {
    const caixa = caixas[i];
    for (let p = Math.max(caixa.inicio, entregue[i] || caixa.inicio); p < caixa.fim; p += FATIA_BYTES) {
      if (opts.signal?.aborted) throw new DOMException("cancelado", "AbortError");
      if (falha) throw falha;
      if (erro) throw erro;
      lidos += await anexar(arquivo, file, p, Math.min(p + FATIA_BYTES, caixa.fim));
      opts.onRead?.(lidos, file.size);
      await esperarFila(120, 60);
    }
  }
  arquivo.flush();
  await esperarFila(0, 0);
  await decoder.flush();
  decoder.close();
  arquivo.stop();
  if (erro) throw erro;
  if (falha) throw falha;
  if (opts.signal?.aborted) throw new DOMException("cancelado", "AbortError");
  if (recebidos === 0) throw new Error("nenhum quadro encontrado no arquivo");

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
    expected: esperados > 0 ? esperados : recebidos,
    worstGapPeriods,
    medianPeriodNs,
    codec,
  };
}
