/**
 * Tela do app. Sem framework de propósito: uma página, sem dependências, funciona offline e abre
 * instantaneamente num celular na arena.
 */
import { analyzeVideo, configForFile, probeFramePeriod, type AnalysisResult } from "./analyze.ts";
import { defaultConfig } from "./core/photocellConfig.ts";
import type { RunResult } from "./core/photocellEngine.ts";
import { formatElapsed } from "./core/timeFormatter.ts";
import {
  csvClassificacao,
  csvHistorico,
  lerCsvInscricoes,
  novoId,
  Store,
  type Passada,
} from "./store.ts";
import {
  comparacoes,
  erroEmMs,
  nomeOrigem,
  origemDe,
  parseTempo,
  porOrigem,
  resumoValidacao,
  textoConferencia,
} from "./validacao.ts";
import { Visor } from "./visor.ts";
import { probeFileInfo } from "./videoDecoderReader.ts";
import { supportsFrameCallback } from "./videoStripReader.ts";

/** Ligado na versão de arquivo único (página embutida): sem service worker, sem manifesto. */
declare const ARQUIVO_UNICO: boolean;
/** Carimbo da construção (data + hash do bundle), injetado pelo `build.mjs`. */
declare const VERSAO: string;
/** Quantos vetores compartilhados o núcleo passa — contado na construção, não escrito à mão. */
declare const VETORES: string;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const store = new Store();
// Gravação que falha em silêncio é o pior defeito possível numa prova: o operador acha que salvou,
// fecha o app, e o tempo não existe mais. Aqui a falha vira aviso na cara, e insistente.
store.aoFalharGravacao = (m) => {
  aviso(m);
  conferirGravacao();
};

/**
 * Enquanto a gravação estiver falhando, a faixa fica na tela — não some sozinha.
 *
 * `store.gravacaoFalhou` existia com o comentário "a tela usa isto para insistir no aviso" e não
 * era lido por ninguém: o único aviso era um toast de 6 segundos.
 */
function conferirGravacao(): void {
  $("faixa-falha").hidden = !store.gravacaoFalhou;
}

// ROI em fração (a mesma convenção do app nativo)
const roi = { lineXFraction: 0.5, bandTopFraction: 0.3, bandBottomFraction: 0.7, stripWidthPx: 15 };
// Com o tripé fixo, a linha é a mesma o dia inteiro. Perdê-la a cada recarga da página seria
// retrabalho garantido no meio da prova — e recarregar acontece (bateria, aba fechada, atualização).
Object.assign(roi, store.roi ?? {});

/**
 * Guarda a linha mirada.
 *
 * Com espera: cada gravação serializa o histórico inteiro, e o slider de largura dispara dezenas de
 * eventos por arrasto. Num dia de prova com muitas passadas salvas, gravar a cada pixel travaria o
 * arrasto justamente quando ele precisa ser preciso.
 */
let timerRoi = 0;
function guardarRoi(agora = false): void {
  clearTimeout(timerRoi);
  if (agora) return store.salvarRoi({ ...roi });
  timerRoi = window.setTimeout(() => store.salvarRoi({ ...roi }), 300);
}

/** Põe o slider de largura de acordo com a ROI em vigor (na abertura e quando ela muda de fora). */
function sincronizarLargura(): void {
  const campo = $<HTMLInputElement>("largura");
  campo.value = String(roi.stripWidthPx);
  $("larguraOut").textContent = String(roi.stripWidthPx);
}
sincronizarLargura();

let arquivo: File | null = null;
let videoW = 0;
let videoH = 0;
let analisando: AbortController | null = null;
/** Taxa de quadros lida do cabeçalho do arquivo (0 = ainda não sei). */
let fpsArquivo = 0;
let passadaAberta: Passada | null = null;

// ------------------------------------------------------------------ avisos
let avisoTimer = 0;
function aviso(texto: string, ok = false): void {
  const el = $("aviso");
  el.textContent = texto;
  el.classList.toggle("ok", ok);
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = window.setTimeout(() => (el.hidden = true), 6000);
}

// ------------------------------------------------------------------ abas
for (const b of document.querySelectorAll<HTMLButtonElement>("#abas button")) {
  b.addEventListener("click", () => {
    for (const outro of document.querySelectorAll("#abas button")) outro.classList.remove("ativa");
    for (const s of document.querySelectorAll(".aba")) s.classList.remove("ativa");
    b.classList.add("ativa");
    $(`aba-${b.dataset.aba}`).classList.add("ativa");
    if (b.dataset.aba === "prova") desenharProva();
    if (b.dataset.aba === "historico") desenharHistorico();
    // Sair da aba desliga a câmera: câmera ligada aquece o aparelho, e aparelho quente é o que faz
    // o iPhone baixar a taxa na hora de gravar a passada.
    if (b.dataset.aba !== "visor") fecharVisor();
  });
}

// ------------------------------------------------------------------ escolher o vídeo
// Dois botões para a MESMA coisa, porque os dois caminhos do iPhone são diferentes por dentro: o da
// Fototeca exporta o item antes de entregar (e trava em clipe longo de câmera lenta), o do app
// Arquivos entrega o arquivo como está.
for (const id of ["arquivo", "arquivoDoc"]) {
  $<HTMLInputElement>(id).addEventListener("change", async (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) return;
    arquivo = f;
    // Sem isto, reescolher o MESMO arquivo depois de uma falha não muda o `value` do campo e o
    // evento não vem: o botão parece morto justamente quando ele está tentando se recuperar.
    (ev.target as HTMLInputElement).value = "";
    // Limpar o cartão, e não só escondê-lo: `store.salvarPassada` guarda a REFERÊNCIA do objeto, de
    // modo que `passadaAberta` continua apontando para a passada já salva. Um toque em "+ tambor"
    // depois de trocar de vídeo alteraria uma passada do histórico sem ninguém pedir.
    $("resultado").hidden = true;
    $("resultado").innerHTML = "";
    passadaAberta = null;
    await mostrarPrimeiroQuadro(f);
  });
}

/** Mostra o primeiro quadro do vídeo para o usuário posicionar a linha e a banda. */
/**
 * O `<video>` do editor existe SÓ ENQUANTO ALGUÉM ESTÁ OLHANDO.
 *
 * Ele é o que permite percorrer o clipe e conferir o quadro de cada disparo — sem isso a linha é
 * posicionada sobre uma pista vazia, adivinhando por onde o cavalo passou, que foi o que aconteceu
 * no primeiro vídeo real. Mas mantê-lo vivo custa caro: medido aqui, um clipe de 225 MB deixa
 * **258 MB residentes** só de o arquivo estar aberto num `<video>`, antes de qualquer análise. Somado
 * ao que a análise gasta, é memória demais para uma aba de celular — e "carrega e para" é
 * exatamente o defeito que este projeto já pagou uma vez.
 *
 * Então: desenha o primeiro quadro, solta; e recria sob demanda quando o usuário arrasta o controle
 * ou pede para ver a largada. A primeira busca custa um instante a mais, e a análise roda com a
 * memória livre.
 */
let videoEditor: HTMLVideoElement | null = null;
let urlEditor: string | null = null;
let buscando = false;
/** Duração do clipe, guardada para o controle deslizante funcionar sem o `<video>` na memória. */
let duracaoEditor = 0;

function soltarVideoEditor(): void {
  if (videoEditor !== null) {
    videoEditor.removeAttribute("src");
    videoEditor.load();
    videoEditor = null;
  }
  if (urlEditor !== null) {
    URL.revokeObjectURL(urlEditor);
    urlEditor = null;
  }
}

/** Cria o `<video>` do editor se ele não estiver na memória. Devolve `null` se não der. */
async function garantirVideoEditor(): Promise<HTMLVideoElement | null> {
  if (videoEditor !== null) return videoEditor;
  if (arquivo === null) return null;
  const url = URL.createObjectURL(arquivo);
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  try {
    await new Promise<void>((res, rej) => {
      v.addEventListener("loadeddata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("não consegui reabrir o vídeo")), { once: true });
    });
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  videoEditor = v;
  urlEditor = url;
  return v;
}

/** Leva o quadro do editor a um instante do clipe e o desenha. Uma busca por vez. */
async function irParaInstante(segundos: number): Promise<void> {
  if (buscando) return;
  buscando = true;
  const v = await garantirVideoEditor();
  if (v === null) {
    buscando = false;
    return;
  }
  try {
    const alvo = Math.max(0, Math.min(v.duration || duracaoEditor || 0, segundos));
    if (Math.abs(v.currentTime - alvo) > 0.001) {
      v.currentTime = alvo;
      await new Promise<void>((res) => {
        const pronto = (): void => res();
        v.addEventListener("seeked", pronto, { once: true });
        setTimeout(pronto, 3000);
      });
    }
    const c = $<HTMLCanvasElement>("quadro");
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    $<HTMLInputElement>("instante").value = String(alvo);
    $("instanteOut").textContent = `${alvo.toFixed(2)} s`;
  } catch {
    /* buscar num vídeo que o navegador não decodifica: a tela continua no quadro anterior */
  } finally {
    buscando = false;
  }
}

async function mostrarPrimeiroQuadro(f: File): Promise<void> {
  soltarVideoEditor();
  const url = URL.createObjectURL(f);
  const v = document.createElement("video");
  v.src = url;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  try {
    await new Promise<void>((res, rej) => {
      v.addEventListener("loadeddata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("não consegui abrir esse vídeo")), { once: true });
    });
    v.currentTime = Math.min(0.1, (v.duration || 1) / 2);
    await new Promise<void>((res) => v.addEventListener("seeked", () => res(), { once: true }));
    videoW = v.videoWidth;
    videoH = v.videoHeight;
    const c = $<HTMLCanvasElement>("quadro");
    c.width = videoW;
    c.height = videoH;
    c.getContext("2d")!.drawImage(v, 0, 0);
    const o = $<HTMLCanvasElement>("overlay");
    o.width = videoW;
    o.height = videoH;
    $("editor").hidden = false;
    desenharOverlay();
    duracaoEditor = v.duration || 0;
    const faixa = $<HTMLInputElement>("instante");
    faixa.max = String(v.duration || 1);
    faixa.step = String(Math.max(0.01, (v.duration || 1) / 600));
    faixa.value = String(v.currentTime);
    $("instanteOut").textContent = `${v.currentTime.toFixed(2)} s`;
    $("linhaInstante").hidden = false;
    // ler o cabeçalho leva um instante em arquivo grande; linha em branco parece travamento
    $("info-video").textContent = "Lendo as informações do vídeo…";
    const dur = v.duration || 0;
    const tamanho = f.size >= 1048576 ? `${(f.size / 1048576).toFixed(0)} MB` : `${Math.round(f.size / 1024)} KB`;
    // A taxa vem do cabeçalho do arquivo, na hora: é a diferença entre o milésimo e ±17 ms, e o
    // usuário precisa saber ANTES de esperar a análise inteira.
    const info = await probeFileInfo(f);
    fpsArquivo = info?.fps ?? 0;
    // Duas durações, de propósito: a do CABEÇALHO (quanto de prova o arquivo guarda) e a da
    // REPRODUÇÃO (quanto tempo o vídeo leva para tocar). Num clipe de câmera lenta preservado elas
    // são diferentes — 20 s de prova que tocam por 2 min 40 s —, e é justamente essa diferença que
    // distingue o arquivo original do arquivo já "assado" pelo iPhone a 30 quadros por segundo.
    const cabecalho = info
      ? `${info.frames} quadros em ${info.durationS.toFixed(1)} s` +
        (dur > 0 && Math.abs(dur - info.durationS) > 0.5 ? ` (toca em ${dur.toFixed(0)} s)` : "")
      : `${dur.toFixed(1)} s`;
    $("info-video").innerHTML =
      `${videoW}×${videoH} · ${cabecalho} · ${tamanho}` +
      (fpsArquivo > 0 ? ` · <b>${Math.round(fpsArquivo)} quadros por segundo</b>` : "") +
      ` — arraste a linha vermelha até onde o cavalo cruza; as alças ajustam a altura da banda.`;
    mostrarAvisoTaxa();
  } catch (e) {
    // Recusar a análise é melhor que produzir um número errado em silêncio: `arquivo` já foi trocado
    // lá em cima, mas `videoW`/`videoH`/`fpsArquivo` ainda seriam os do vídeo ANTERIOR — analisar
    // assim daria um tempo com a geometria errada, sem nenhum aviso.
    arquivo = null;
    videoW = 0;
    videoH = 0;
    fpsArquivo = 0;
    $("editor").hidden = true;
    $("linhaInstante").hidden = true;
    $("aviso-taxa").hidden = true;
    aviso(`${(e as Error).message} — escolha o vídeo de novo, ou converta o arquivo antes.`);
  } finally {
    // Solto assim que o primeiro quadro está desenhado: manter o arquivo aberto num `<video>` custa
    // o tamanho do arquivo em memória residente (ver `videoEditor`). `garantirVideoEditor()` o
    // recria na primeira vez que alguém percorrer o clipe.
    videoEditor = v;
    urlEditor = url;
    soltarVideoEditor();
  }
}

/**
 * Diz, em cima da hora, o que a taxa do vídeo significa para o tempo. Gravar em velocidade normal
 * (30 fps) não impede a medição — só a limita a ±17 ms por gatilho, que não serve para prova. Melhor
 * dizer isso antes de o usuário esperar a análise e ir para a pista confiando no número.
 */
function mostrarAvisoTaxa(): void {
  const el = $("aviso-taxa");
  if (fpsArquivo <= 0) {
    el.hidden = true;
    return;
  }
  const fps = Math.round(fpsArquivo);
  el.hidden = false;
  if (fps >= 200) {
    el.className = "faixa-aviso bom";
    el.innerHTML = `<b>${fps} quadros por segundo.</b> É câmera lenta: dá para chegar ao milésimo.`;
  } else if (fps >= 100) {
    el.className = "faixa-aviso";
    el.innerHTML = `<b>${fps} quadros por segundo.</b> Serve, mas o dobro seria melhor: em Ajustes →
      Câmera → Gravar Câm. Lenta, escolha <b>1080p a 240 fps</b>.`;
  } else {
    el.className = "faixa-aviso ruim";
    el.innerHTML = `<b>${fps} quadros por segundo — isto não é câmera lenta.</b> O tempo vai sair com
      cerca de ±${(1000 / fps / 2).toFixed(0)} ms de incerteza em cada gatilho, o que não serve para
      prova. Grave de novo no app <b>Câmera → CÂM. LENTA</b> (Ajustes → Câmera → Gravar Câm. Lenta →
      1080p a 240 fps). Você pode analisar assim mesmo, só não confie no milésimo.`;
  }
}

// ------------------------------------------------------------------ overlay da ROI
function desenharOverlay(): void {
  const o = $<HTMLCanvasElement>("overlay");
  const ctx = o.getContext("2d")!;
  ctx.clearRect(0, 0, o.width, o.height);
  const x = roi.lineXFraction * o.width;
  const top = roi.bandTopFraction * o.height;
  const bot = roi.bandBottomFraction * o.height;
  const meia = Math.max(2, (roi.stripWidthPx / 2) * (o.width / Math.max(1, videoW)));
  const esc = o.width / 900;

  ctx.setLineDash([14 * esc, 14 * esc]);
  ctx.strokeStyle = "rgba(255, 214, 64, 0.5)";
  ctx.lineWidth = 2 * esc;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, o.height);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(215, 38, 61, 0.35)";
  ctx.fillRect(x - meia, top, meia * 2, bot - top);
  ctx.strokeStyle = "#d7263d";
  ctx.lineWidth = 3 * esc;
  ctx.strokeRect(x - meia, top, meia * 2, bot - top);
  for (const y of [top, bot]) {
    ctx.beginPath();
    ctx.arc(x, y, 16 * esc, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// arrastar a linha e as alças
let arrastando: "linha" | "topo" | "base" | null = null;
const palco = $("palco");
const posicao = (ev: PointerEvent): { x: number; y: number } => {
  const r = palco.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
};
palco.addEventListener("pointerdown", (ev) => {
  const p = posicao(ev);
  const perto = (a: number, b: number) => Math.abs(a - b) < 0.06;
  arrastando = perto(p.y, roi.bandTopFraction) && perto(p.x, roi.lineXFraction)
    ? "topo"
    : perto(p.y, roi.bandBottomFraction) && perto(p.x, roi.lineXFraction)
      ? "base"
      : "linha";
  palco.setPointerCapture(ev.pointerId);
  moverROI(p);
});
palco.addEventListener("pointermove", (ev) => {
  if (arrastando === null) return;
  ev.preventDefault();
  moverROI(posicao(ev));
});
for (const e of ["pointerup", "pointercancel"]) {
  palco.addEventListener(e, () => {
    if (arrastando !== null) guardarRoi(true);
    arrastando = null;
  });
}

function moverROI(p: { x: number; y: number }): void {
  const lim = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  if (arrastando === "topo") roi.bandTopFraction = lim(p.y, 0, roi.bandBottomFraction - 0.05);
  else if (arrastando === "base") roi.bandBottomFraction = lim(p.y, roi.bandTopFraction + 0.05, 1);
  else roi.lineXFraction = lim(p.x, 0.03, 0.97);
  desenharOverlay();
}

/**
 * Gancho de automação: `Tools/analisar_video.mjs` posiciona a ROI por aqui.
 *
 * Simular o arrasto do dedo seria frágil e não é o que se quer exercitar — o que interessa é rodar
 * a MESMA análise do produto sobre um vídeo real, com a linha onde eu escolher.
 */
(window as unknown as { definirROI?: (l: number, t: number, b: number, w: number) => void }).definirROI = (
  l,
  t,
  b,
  w,
) => {
  roi.lineXFraction = Math.min(0.99, Math.max(0.01, l));
  roi.bandTopFraction = Math.min(0.98, Math.max(0, Math.min(t, b)));
  roi.bandBottomFraction = Math.max(0.02, Math.min(1, Math.max(t, b)));
  roi.stripWidthPx = Math.round(Math.min(40, Math.max(5, w)));
  sincronizarLargura();
  desenharOverlay();
  guardarRoi(true);
};

$<HTMLInputElement>("instante").addEventListener("input", (ev) => {
  void irParaInstante(Number((ev.target as HTMLInputElement).value));
});

$<HTMLInputElement>("largura").addEventListener("input", (ev) => {
  roi.stripWidthPx = Number((ev.target as HTMLInputElement).value);
  $("larguraOut").textContent = String(roi.stripWidthPx);
  desenharOverlay();
  guardarRoi();
});

// ------------------------------------------------------------------ analisar
$("analisar").addEventListener("click", async () => {
  if (!arquivo) return;
  if (!supportsFrameCallback()) {
    aviso("Este navegador não entrega os quadros do vídeo. No iPhone, use o Safari.");
    return;
  }
  // A análise é o momento de pico de memória: o leitor, o decodificador e as faixas ao mesmo tempo.
  // Um `<video>` com o arquivo aberto ao lado disso é o que mata a aba num clipe grande.
  soltarVideoEditor();
  void manterTelaAcesa();
  const ctrl = new AbortController();
  analisando = ctrl;
  $("analisar").hidden = true;
  $("cancelar").hidden = false;
  $("progresso").hidden = false;
  $("resultado").hidden = true;
  const t0 = performance.now();
  let bytesLidos = 0;
  let bytesTotal = 0;
  let quadrosLidos = 0;
  const pintarProgresso = (): void => {
    const mb = (n: number): string => (n / 1048576).toFixed(0);
    if (bytesTotal > 0) {
      $<HTMLElement>("barraFill").style.width = `${((bytesLidos / bytesTotal) * 100).toFixed(1)}%`;
    }
    const lendo = bytesTotal > 0 ? `Lendo o vídeo… ${mb(bytesLidos)} MB de ${mb(bytesTotal)} MB` : "Analisando…";
    $("progressoTexto").textContent = quadrosLidos > 0 ? `${lendo} · ${quadrosLidos} quadros medidos` : lendo;
  };
  try {
    $("progressoTexto").textContent = "Abrindo o vídeo…";
    // A taxa exata já veio do cabeçalho do arquivo quando ele foi escolhido. Só quando o cabeçalho
    // não pôde ser lido é que vale tocar o vídeo para estimar o período — o que num clipe grande
    // custa caro.
    const periodo = fpsArquivo > 0 ? Math.round(1e9 / fpsArquivo) : await probeFramePeriod(arquivo);
    const fps = periodo > 0 ? 1e9 / periodo : 240;
    const cfg = configForFile(defaultConfig(), fps);
    // vídeo sempre traz curva de tom: linearizar antes da fração de exposição
    cfg.gamma = 2.2;
    // clipe de treino é curto: janelas curtas para largada e chegada caberem
    cfg.startLockoutNs = 500_000_000;
    cfg.frameResumeNs = 1_500_000_000;
    cfg.finishArmNs = 2_000_000_000;
    cfg.finishLockoutNs = 500_000_000;

    const res = await analyzeVideo(arquivo, {
      videoWidth: videoW,
      videoHeight: videoH,
      roi,
      config: cfg,
      periodNs: periodo,
      signal: ctrl.signal,
      // Leitura e decodificação andam juntas: a barra segue os bytes lidos (a medida global), e o
      // texto diz quantos quadros já saíram. Sem isso, um vídeo de 300 MB passa minutos sem nenhum
      // sinal na tela — que é exatamente o "carrega e para" relatado.
      onRead: (lidos, total) => {
        bytesLidos = lidos;
        bytesTotal = total;
        pintarProgresso();
      },
      onProgress: (frac, recebidos) => {
        quadrosLidos = recebidos;
        if (bytesTotal === 0) $<HTMLElement>("barraFill").style.width = `${(frac * 100).toFixed(1)}%`;
        pintarProgresso();
      },
    });
    // gancho de teste: o teste ponta a ponta lê daqui os números crus da análise
    (window as unknown as { ultimaAnalise?: unknown }).ultimaAnalise = res;
    mostrarResultado(res, (performance.now() - t0) / 1000);
  } catch (e) {
    if ((e as Error).name !== "AbortError") aviso((e as Error).message);
  } finally {
    if (!visor.ativo) soltarTela();
    analisando = null;
    $("analisar").hidden = false;
    $("cancelar").hidden = true;
    $("progresso").hidden = true;
  }
});

$("cancelar").addEventListener("click", () => analisando?.abort());

// ------------------------------------------------------------------ resultado
function mostrarResultado(res: AnalysisResult, segundos: number): void {
  const el = $("resultado");
  el.hidden = false;
  if (res.run === null) {
    el.innerHTML = `<div class="resultado">
      <div class="quem" style="color:var(--feixe)">Não deu para medir</div>
      <p class="dica">${res.problem ?? "Sem cruzamento detectado."}</p>
      <p class="detalhe">${res.reader.received} quadros lidos · ${res.measuredFps.toFixed(1)} FPS medidos
        ${res.missedFrames > 0 ? ` · ${res.missedFrames} quadros não entregues pelo navegador` : ""}</p>
    </div>`;
    return;
  }
  const r = res.run;
  const p: Passada = {
    id: novoId(),
    dataMs: Date.now(),
    // A passada nasce SEM DONO. Quem a amarra a um competidor é o toque em "Salvar para #N": um
    // tempo que apareceu sozinho (poeira, alguém atravessando) não pode consumir a lista de largada
    // e empurrar todos os nomes uma casa para trás pelo resto da prova.
    competidor: "",
    cavalo: "",
    categoria: "",
    ordem: 0,
    // A prova aberta é do DIA, não do competidor: para calibrar ninguém digita nome, e sem isto
    // toda passada nasceria órfã — e a conferência não teria como somar só a sessão de hoje.
    eventoId: store.eventoAtualId,
    inscricaoId: null,
    elapsedRawNs: r.elapsedRawNs,
    elapsedRefinedNs: r.elapsedRefinedNs,
    tamboresDerrubados: 0,
    semTempo: false,
    qualidadeLargada: r.start.quality,
    qualidadeChegada: r.finish.quality,
    incertezaLargadaNs: r.start.uncertaintyNs,
    incertezaChegadaNs: r.finish.uncertaintyNs,
    degradada: r.degraded || res.missedFrames > 0,
    fps: res.measuredFps,
    quadrosPerdidos: res.missedFrames,
    arquivo: arquivo?.name ?? "",
    origem: "video",
  };
  passadaAberta = p;
  // GRAVA JÁ. O número existe; esperar um toque em "Salvar" é o que fazia a passada sumir ao trocar
  // de vídeo, ao armar de novo, ao trocar de aba, ou quando a bateria acabava. `salvarPassada` é
  // idempotente pelo id, então o toque depois só atualiza.
  store.salvarPassada(p);
  desenharHistorico();
  desenharCartao(segundos, res);
}

function desenharCartao(segundos: number, res: AnalysisResult): void {
  const p = passadaAberta!;
  const el = $("resultado");
  const qualidade = Math.min(p.qualidadeLargada, p.qualidadeChegada);
  const incerteza = (p.incertezaLargadaNs + p.incertezaChegadaNs) / 1e6;
  const finalNs = p.elapsedRefinedNs + p.tamboresDerrubados * 5_000_000_000;
  const quem = p.inscricaoId
    ? `#${p.ordem} ${p.competidor}${p.cavalo ? ` / ${p.cavalo}` : ""}${p.categoria ? ` — ${p.categoria}` : ""}`
    : "Sem competidor";
  el.innerHTML = `<div class="resultado">
    <div class="quem">${escapar(quem)}</div>
    <div class="tempo ${p.semTempo ? "sat" : ""}">${p.semTempo ? "SAT" : formatElapsed(finalNs)}</div>
    <div>
      <span class="selo q${qualidade}">qualidade ${qualidade} · ±${incerteza.toFixed(2)} ms</span>
      ${p.degradada ? '<span class="selo aviso">degradada</span>' : ""}
    </div>
    <p class="detalhe">
      refinado ${formatElapsed(p.elapsedRefinedNs)} · bruto ${formatElapsed(p.elapsedRawNs)}<br>
      ${res.measuredFps.toFixed(0)} FPS · ${res.reader.received} quadros lidos${res.missedFrames > 0 ? ` · <b>${res.missedFrames} não entregues pelo navegador</b>` : ""} · análise em ${segundos.toFixed(0)} s<br>
      leitura por ${res.leitura}${res.codec ? ` · ${res.codec}` : ""}${
        res.calibracao
          ? `<br>calibrado com o trecho de ${res.calibracao.inicioS.toFixed(1)} s a ${res.calibracao.fimS.toFixed(1)} s do vídeo`
          : ""
      }
    </p>
    <div class="linha">
      <button class="botao" id="menosTambor">− tambor</button>
      <span class="detalhe">${p.tamboresDerrubados} tambor(es) · +${p.tamboresDerrubados * 5} s</span>
      <button class="botao" id="maisTambor">+ tambor</button>
      <button class="botao" id="botaoSat">${p.semTempo ? "SAT ✓" : "SAT"}</button>
    </div>
    ${
      res.largadaS !== null && res.chegadaS !== null
        ? `<div class="linha">
             <span class="detalhe">Conferir no vídeo:</span>
             <button class="botao" id="verLargada">ver a largada</button>
             <button class="botao" id="verChegada">ver a chegada</button>
           </div>`
        : ""
    }
    <div class="linha conferencia">
      <label for="tempoOficial">Tempo da cronometragem oficial</label>
      <input type="text" id="tempoOficial" inputmode="decimal" placeholder="14,325"
             value="${escapar(p.oficialTexto ?? "")}">
      <span class="detalhe" id="erroOficial"></span>
    </div>
    <div class="linha">
      <button class="botao grande primario" id="salvarPassada">
        ${p.inscricaoId ? `Salvar para #${p.ordem}` : "Salvar no histórico"}
      </button>
    </div>
  </div>`;
  // Cada um destes GRAVA: a passada já está no histórico, e mudar só o objeto na memória fazia a
  // penalidade aparecer na tela e não existir no dia seguinte — com o pódio da categoria trocado.
  $("menosTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.max(0, p.tamboresDerrubados - 1);
    store.salvarPassada(p);
    desenharCartao(segundos, res);
  });
  $("maisTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.min(3, p.tamboresDerrubados + 1);
    store.salvarPassada(p);
    desenharCartao(segundos, res);
  });
  $("botaoSat").addEventListener("click", () => {
    p.semTempo = !p.semTempo;
    store.salvarPassada(p);
    desenharCartao(segundos, res);
  });
  // O campo do tempo oficial NUNCA repinta o cartão: `desenharCartao` refaz o `innerHTML` inteiro,
  // e repintar a cada tecla mataria o foco e o que está sendo digitado. Aqui só o `<span>` do erro
  // muda; o valor é espelhado na passada a cada tecla para sobreviver a uma repintura disparada
  // por outro botão (tambor/SAT).
  // Ver o quadro do disparo é o que transforma o número em medição auditável: se o cavalo está
  // cruzando ali, o tempo é dele; se aparece poeira ou sombra, o tempo é lixo — e dá para saber em
  // dois segundos, em vez de discutir.
  if (res.largadaS !== null && res.chegadaS !== null) {
    $("verLargada").addEventListener("click", () => void irParaInstante(res.largadaS!));
    $("verChegada").addEventListener("click", () => void irParaInstante(res.chegadaS!));
  }

  const campoOficial = $<HTMLInputElement>("tempoOficial");
  const pintarErro = (): void => {
    const oficial = parseTempo(campoOficial.value);
    const alvo = $("erroOficial");
    if (oficial === null) {
      alvo.textContent = campoOficial.value.trim() === "" ? "" : "não entendi esse tempo";
      alvo.className = "detalhe";
      return;
    }
    if (!oficialPlausivel(p, oficial)) {
      alvo.textContent = `esse tempo não parece o desta passada (medido ${formatElapsed(p.elapsedRefinedNs)}) — faltou a vírgula?`;
      alvo.className = "detalhe conf-fora";
      return;
    }
    const erroNs = p.elapsedRefinedNs - oficial;
    const incertezaNs = p.incertezaLargadaNs + p.incertezaChegadaNs;
    const dentro = Math.abs(erroNs) <= incertezaNs;
    const lado = erroNs >= 0 ? "o app mediu mais" : "o app mediu menos";
    alvo.textContent = `${erroEmMs(erroNs)} — ${lado} · ${dentro ? "dentro" : "FORA"} do ±${(incertezaNs / 1e6).toFixed(2)} ms declarado`;
    alvo.className = `detalhe ${dentro ? "conf-ok" : "conf-fora"}`;
  };
  campoOficial.addEventListener("input", () => {
    p.oficialTexto = campoOficial.value;
    const lido = parseTempo(campoOficial.value);
    // Absurdo não entra: fica na tela para ele corrigir, mas não contamina a conferência.
    p.oficialNs = oficialPlausivel(p, lido) ? lido : null;
    pintarErro();
  });
  pintarErro();

  $("salvarPassada").addEventListener("click", () => {
    p.oficialTexto = campoOficial.value;
    const lido = parseTempo(campoOficial.value);
    p.oficialNs = oficialPlausivel(p, lido) ? lido : null;
    amarrarAoProximo(p);
    store.salvarPassada(p);
    aviso(p.inscricaoId ? `Passada de #${p.ordem} guardada.` : "Passada guardada.", true);
    atualizarProximo();
    desenharHistorico();
    desenharCartao(segundos, res);
  });
}

/**
 * Amarra a passada ao próximo competidor da lista de largada — só no TOQUE do operador.
 *
 * A passada nasce sem dono e é guardada assim. É ele quem diz "esta é do #12", e é por isso que um
 * tempo que apareceu sozinho (poeira, alguém atravessando a pista) não empurra a lista de largada
 * uma casa para trás e faz todos os nomes seguintes saírem errados pelo resto da prova.
 */
/**
 * O tempo digitado é desta passada?
 *
 * `14,25` sem a vírgula vira `1425` — que o leitor aceita como 1425 segundos. Isso entrava na
 * conferência e o viés do dia saltava para mais de vinte minutos, sem uma linha vermelha em lugar
 * nenhum: o único número que decide se o app serve virava lixo por um dedo de luva.
 */
function oficialPlausivel(p: Passada, ns: number | null): boolean {
  return ns !== null && Math.abs(ns - p.elapsedRefinedNs) <= 2_000_000_000;
}

function amarrarAoProximo(p: Passada): void {
  if (p.inscricaoId !== null) return;
  const prox = store.proximaInscricao();
  if (prox === null) return;
  p.inscricaoId = prox.id;
  p.competidor = prox.competidor;
  p.cavalo = prox.cavalo;
  p.categoria = prox.categoria;
  p.ordem = prox.ordem;
}

const escapar = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ------------------------------------------------------------------ faixa "próximo"
function atualizarProximo(): void {
  const el = $("faixa-proximo");
  const i = store.proximaInscricao();
  if (i === null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<div class="rotulo">PRÓXIMO</div><div class="nome">${escapar(
    `#${i.ordem} ${i.competidor}${i.cavalo ? ` / ${i.cavalo}` : ""}${i.categoria ? ` — ${i.categoria}` : ""}`,
  )}</div>`;
}

// ------------------------------------------------------------------ prova
$("criarProva").addEventListener("click", () => {
  const nome = $<HTMLInputElement>("provaNome").value;
  if (!nome.trim()) return aviso("Dê um nome à prova.");
  store.criarEvento(nome, $<HTMLInputElement>("provaLocal").value);
  $<HTMLInputElement>("provaNome").value = "";
  $<HTMLInputElement>("provaLocal").value = "";
  desenharProva();
  atualizarProximo();
});

$("addInscricao").addEventListener("click", () => {
  const ev = store.eventoAtualId;
  if (ev === null) return aviso("Crie ou abra uma prova primeiro.");
  const competidor = $<HTMLInputElement>("insCompetidor").value.trim();
  if (!competidor) return aviso("Falta o nome do competidor.");
  const atual = store.inscricoesDe(ev);
  const ordem = Number($<HTMLInputElement>("insOrdem").value) || (atual.at(-1)?.ordem ?? 0) + 1;
  store.adicionarInscricao({
    eventoId: ev,
    ordem,
    competidor,
    cavalo: $<HTMLInputElement>("insCavalo").value.trim(),
    categoria: $<HTMLInputElement>("insCategoria").value.trim(),
  });
  for (const id of ["insOrdem", "insCompetidor", "insCavalo"]) $<HTMLInputElement>(id).value = "";
  desenharProva();
  atualizarProximo();
});

$<HTMLInputElement>("csvInscricoes").addEventListener("change", async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  const evento = store.eventoAtualId;
  if (!f) return;
  if (evento === null) return aviso("Crie ou abra uma prova primeiro.");
  const linhas = lerCsvInscricoes(await f.text());
  if (linhas.length === 0) return aviso("Nenhuma inscrição reconhecida no arquivo.");
  for (const l of linhas) store.adicionarInscricao({ ...l, eventoId: evento });
  aviso(`${linhas.length} inscrições importadas.`, true);
  desenharProva();
  atualizarProximo();
});

function desenharProva(): void {
  const provas = $("listaProvas");
  provas.innerHTML = "";
  for (const e of store.eventos) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `<div class="cresce"><div>${e.id === store.eventoAtualId ? "● " : "○ "}${escapar(e.nome)}</div>
      <div class="sub">${escapar(e.local)} ${new Date(e.dataMs).toLocaleDateString("pt-BR")}</div></div>`;
    const abrir = document.createElement("button");
    abrir.textContent = e.id === store.eventoAtualId ? "aberta" : "Abrir";
    abrir.addEventListener("click", () => {
      store.selecionarEvento(e.id);
      desenharProva();
      atualizarProximo();
    });
    const excluir = document.createElement("button");
    excluir.textContent = "Excluir";
    excluir.addEventListener("click", () => {
      store.removerEvento(e.id);
      desenharProva();
      atualizarProximo();
    });
    div.append(abrir, excluir);
    provas.append(div);
  }
  if (store.eventos.length === 0) provas.innerHTML = '<p class="dica">Nenhuma prova criada ainda.</p>';

  const ins = $("listaInscricoes");
  ins.innerHTML = "";
  const ev = store.eventoAtualId;
  if (ev !== null) {
    const feitas = new Set(store.passadas.map((p) => p.inscricaoId));
    for (const i of store.inscricoesDe(ev)) {
      const div = document.createElement("div");
      div.className = "item" + (feitas.has(i.id) ? " feito" : "");
      div.innerHTML = `<div class="cresce">${feitas.has(i.id) ? "✓ " : "· "}${escapar(
        `#${i.ordem} ${i.competidor}${i.cavalo ? ` / ${i.cavalo}` : ""}${i.categoria ? ` — ${i.categoria}` : ""}`,
      )}</div>`;
      const x = document.createElement("button");
      x.textContent = "Excluir";
      x.addEventListener("click", () => {
        store.removerInscricao(i.id);
        desenharProva();
        atualizarProximo();
      });
      div.append(x);
      ins.append(div);
    }
    if (ins.children.length === 0) ins.innerHTML = '<p class="dica">Sem inscrições nesta prova.</p>';
  } else {
    ins.innerHTML = '<p class="dica">Abra ou crie uma prova acima.</p>';
  }

  const cl = $("classificacao");
  cl.innerHTML = "";
  if (ev === null) {
    cl.innerHTML = '<p class="dica">Abra uma prova para ver a classificação.</p>';
    return;
  }
  const linhas = store.classificacao(ev);
  if (linhas.length === 0) {
    cl.innerHTML = '<p class="dica">Nenhuma passada salva nesta prova ainda.</p>';
    return;
  }
  const t = document.createElement("table");
  t.innerHTML = `<thead><tr><th>Col.</th><th>Competidor</th><th class="num">Tempo</th></tr></thead>`;
  const tb = document.createElement("tbody");
  for (const { colocacao: c, passada: p } of linhas) {
    const tr = document.createElement("tr");
    if (c.place === null) tr.className = "sat";
    tr.innerHTML = `<td>${c.place === null ? "SAT" : `${c.place}º`}</td>
      <td>${escapar(`#${p.ordem} ${p.competidor}`)}<div class="sub">${escapar(p.categoria)}${
        c.penaltyNs > 0 ? ` · +${c.penaltyNs / 1e9}s` : ""
      }</div></td>
      <td class="num">${c.place === null ? "—" : formatElapsed(c.finalNs)}</td>`;
    tb.append(tr);
  }
  t.append(tb);
  cl.append(t);
}

$("exportarProva").addEventListener("click", () => {
  const ev = store.eventoAtualId;
  if (ev === null) return aviso("Abra uma prova primeiro.");
  baixar(`classificacao-${(store.eventoAtual?.nome ?? "prova").replace(/[^\w]+/g, "-").toLowerCase()}.csv`,
    csvClassificacao(store.classificacao(ev)));
});

// ------------------------------------------------------------------ histórico
function desenharHistorico(): void {
  conferirGravacao();
  desenharConferencia();
  const el = $("listaHistorico");
  el.innerHTML = "";
  if (store.passadas.length === 0) {
    el.innerHTML = '<p class="dica">Nenhuma passada salva ainda.</p>';
    return;
  }
  for (const p of store.passadas) {
    const div = document.createElement("div");
    div.className = "item";
    const finalNs = p.elapsedRefinedNs + p.tamboresDerrubados * 5_000_000_000;
    const oficial = p.oficialNs ?? null;
    const conferencia =
      oficial !== null && !p.semTempo
        ? ` · oficial ${(oficial / 1e9).toFixed(3).replace(".", ",")} · erro ${erroEmMs(p.elapsedRefinedNs - oficial)}`
        : "";
    div.innerHTML = `<div class="cresce">
      <div><b>${p.semTempo ? "SAT" : formatElapsed(finalNs)}</b> ${escapar(
        [p.competidor, p.cavalo].filter(Boolean).join(" · "),
      )}</div>
      <div class="sub">${new Date(p.dataMs).toLocaleString("pt-BR")} · bruto ${formatElapsed(
        p.elapsedRawNs,
      )} · q${p.qualidadeLargada}/${p.qualidadeChegada}${p.degradada ? " · degradada" : ""} · ${
      nomeOrigem(origemDe(p))
    }${conferencia}</div></div>`;

    // Campo embutido em vez de `prompt()`: a página roda dentro de um visualizador com restrições,
    // onde `prompt()` pode simplesmente não abrir — e um botão que não faz nada é pior que nenhum.
    const oficialInput = document.createElement("input");
    oficialInput.type = "text";
    oficialInput.className = "oficial-mini";
    oficialInput.inputMode = "decimal";
    oficialInput.placeholder = "oficial";
    oficialInput.value = p.oficialTexto ?? "";
    oficialInput.addEventListener("blur", () => {
      const novoNs = parseTempo(oficialInput.value);
      if ((p.oficialTexto ?? "") === oficialInput.value) return;
      p.oficialTexto = oficialInput.value;
      p.oficialNs = novoNs;
      store.salvarPassada(p);
      desenharHistorico();
    });
    div.append(oficialInput);

    const x = document.createElement("button");
    x.textContent = "Excluir";
    x.addEventListener("click", () => {
      store.removerPassada(p.id);
      desenharHistorico();
      atualizarProximo();
    });
    div.append(x);
    el.append(div);
  }
}

/**
 * O painel de conferência: o que vinte passadas dizem que uma sozinha não diz.
 *
 * O número que mais importa é o "dentro da incerteza": um app que erra 3 ms avisando "±4 ms" está
 * certo; um que erra 3 ms declarando "±0,8 ms" está mentindo, e é isso que precisa aparecer.
 */
/**
 * Escopo do painel: só a prova aberta (padrão) ou o histórico inteiro.
 *
 * O padrão é a prova porque um dia de calibração precisa do viés DAQUELE dia: somar as passadas de
 * teste de ontem faria o número que ele vai usar para julgar o app sair contaminado.
 */
let escopoConferencia: "prova" | "tudo" = "prova";

function passadasDaConferencia(): Passada[] {
  const ev = store.eventoAtualId;
  if (escopoConferencia === "tudo" || ev === null) return store.passadas;
  return store.passadas.filter((p) => p.eventoId === ev);
}

function desenharConferencia(): void {
  const cartao = $("cartaoConferencia");
  // Sem nenhuma passada conferida em lugar nenhum não há painel; havendo, ele fica visível mesmo
  // que o recorte atual esteja vazio — senão o seletor sumiria junto e não haveria como voltar.
  cartao.hidden = comparacoes(store.passadas).length === 0;
  if (cartao.hidden) return;

  const lista = passadasDaConferencia();
  $<HTMLSelectElement>("escopoConferencia").value = escopoConferencia;
  const prova = store.eventoAtual;
  $("escopoLinha").hidden = prova === null;
  $("escopoNome").textContent = prova === null ? "" : prova.nome;

  const r = resumoValidacao(lista);
  if (!r) {
    $("resumoConferencia").innerHTML =
      '<p class="dica">Nenhuma passada com tempo oficial nesta prova. Escolha "todo o histórico" para ver as anteriores.</p>';
    return;
  }
  const ms = (v: number): string => v.toFixed(1).replace(".", ",");
  const fatias = r.porQualidade
    .map(
      (f) =>
        `<div class="sub">qualidade ${f.qualidade}: ${f.n} caso(s) · viés ${erroEmMs(f.viesMs * 1e6)} · |erro| médio ${ms(f.erroAbsMedioMs)} ms</div>`,
    )
    .join("");
  // A quebra por caminho é a resposta à pergunta prática: o cronômetro ao vivo erra o suficiente
  // para não servir? Só aparece quando existem os dois — com um só, a comparação não existe.
  const caminhos = porOrigem(lista)
    .map((f) => ({ origem: f.origem, resumo: resumoValidacao(f.passadas) }))
    .filter((x) => x.resumo !== null);
  const porCaminho =
    caminhos.length > 1
      ? '<div class="sub"><b>Por caminho:</b></div>' +
        caminhos
          .map(
            (x) =>
              `<div class="sub">${nomeOrigem(x.origem)}: ${x.resumo!.n} caso(s) · viés ${erroEmMs(
                x.resumo!.viesMs * 1e6,
              )} · |erro| médio ${ms(x.resumo!.erroAbsMedioMs)} ms · ${x.resumo!.dentroDaIncerteza} de ${
                x.resumo!.n
              } dentro da incerteza</div>`,
          )
          .join("")
      : "";
  const honesto = r.dentroDaIncerteza === r.n;
  $("resumoConferencia").innerHTML = `
    <div class="detalhe">${r.n} passada(s) com tempo oficial</div>
    <div class="linha-numeros">
      <div><b>${erroEmMs(r.viesMs * 1e6)}</b><span>viés (sistemático)</span></div>
      <div><b>${ms(r.erroAbsMedioMs)} ms</b><span>erro médio</span></div>
      <div><b>${erroEmMs(r.maiorErroMs * 1e6)}</b><span>maior erro</span></div>
    </div>
    <div class="selo ${honesto ? "q2" : "q0"}">${r.dentroDaIncerteza} de ${r.n} dentro da incerteza declarada</div>
    ${fatias}${porCaminho}`;
}

$<HTMLSelectElement>("escopoConferencia").addEventListener("change", (ev) => {
  escopoConferencia = (ev.target as HTMLSelectElement).value === "tudo" ? "tudo" : "prova";
  desenharConferencia();
});

$("salvarFalha").addEventListener("click", () => {
  mostrarTexto("fotocelula-historico.csv", csvHistorico(store.passadas));
});

$("exportarHistorico").addEventListener("click", () => {
  if (store.passadas.length === 0) return aviso("Histórico vazio.");
  baixar("fotocelula-historico.csv", csvHistorico(store.passadas));
});

$("copiarConferencia").addEventListener("click", () => {
  const lista = passadasDaConferencia();
  if (comparacoes(lista).length === 0) return aviso("Nenhuma passada com tempo oficial neste recorte.");
  mostrarTexto("conferencia.txt", textoConferencia(lista));
});

// Dois toques em vez de `confirm()`: dentro do visualizador o `confirm` pode não abrir, e aí o
// comportamento não seria "não apaga" — seria APAGAR SEM PERGUNTAR. Agora o histórico carrega dados
// de prova que não dá para refazer.
let armadoParaLimpar = false;
let timerLimpar = 0;
$("limparHistorico").addEventListener("click", () => {
  const botao = $("limparHistorico");
  if (!armadoParaLimpar) {
    armadoParaLimpar = true;
    botao.textContent = "Tem certeza? Toque de novo";
    clearTimeout(timerLimpar);
    timerLimpar = window.setTimeout(() => {
      armadoParaLimpar = false;
      botao.textContent = "Apagar tudo";
    }, 5000);
    return;
  }
  clearTimeout(timerLimpar);
  armadoParaLimpar = false;
  botao.textContent = "Apagar tudo";
  store.limparHistorico();
  desenharHistorico();
  atualizarProximo();
});

function baixar(nome: string, texto: string): void {
  try {
    const blob = new Blob(["\ufeff" + texto], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    /* alguns visualizadores bloqueiam o download: cai para a cópia */
  }
  // Sempre oferecer o texto: em página aberta dentro de outro app o download não acontece e o
  // usuário ficaria sem o arquivo sem saber por quê.
  mostrarTexto(nome, texto);
}

/** Mostra o CSV em texto, com botão de copiar — o plano B quando o download não é permitido. */
function mostrarTexto(nome: string, texto: string): void {
  const fundo = document.createElement("div");
  fundo.className = "modal";
  fundo.innerHTML = `<div class="cartao modal-conteudo">
    <h2>${nome}</h2>
    <p class="dica">Se o download não abrir sozinho, copie o texto abaixo e cole numa planilha.</p>
    <textarea readonly rows="10"></textarea>
    <div class="linha">
      <button class="botao primario" data-copiar>Copiar</button>
      <button class="botao" data-fechar>Fechar</button>
    </div>
  </div>`;
  const area = fundo.querySelector("textarea")!;
  area.value = texto;
  fundo.querySelector("[data-copiar]")!.addEventListener("click", async () => {
    area.select();
    try {
      await navigator.clipboard.writeText(texto);
      aviso("CSV copiado.", true);
    } catch {
      document.execCommand?.("copy");
      aviso("Selecionado — toque em Copiar no menu do iPhone.");
    }
  });
  const fechar = () => fundo.remove();
  fundo.querySelector("[data-fechar]")!.addEventListener("click", fechar);
  fundo.addEventListener("click", (e) => {
    if (e.target === fundo) fechar();
  });
  document.body.append(fundo);
}

// ------------------------------------------------------------------ início
atualizarProximo();
desenharProva();
desenharHistorico();
$("versao").textContent =
  `Fotocélula Tambor · versão ${VERSAO} · núcleo conferido pelos mesmos ${VETORES} vetores do app nativo.`;
if (!supportsFrameCallback()) {
  aviso("Este navegador não consegue ler os quadros do vídeo. No iPhone, abra pelo Safari.");
}
// Sem aviso de orientação: em pé funciona, e quem escolhe a altura da banda é quem está olhando a
// pista. O que a medição pede é que a banda pegue a altura do peito do cavalo — não uma orientação.

// ------------------------------------------------------------------ manter a tela acesa
/**
 * Sem isto o iPhone bloqueia a tela sozinho, o `requestVideoFrameCallback` para, e a passada não é
 * medida — com a tela dizendo "armado — esperando a largada" até o fim. Vale também na análise: um
 * clipe grande leva minutos sem ninguém tocar em nada.
 *
 * A trava é solta pelo próprio navegador quando a aba sai da frente, então é preciso repedir ao
 * voltar. Onde a API não existe (Safari antigo), não há o que fazer pelo código — a Ajuda manda pôr
 * o bloqueio automático em "Nunca".
 */
type TravaTela = { release: () => Promise<void> };
let travaTela: TravaTela | null = null;
let queroTelaAcesa = false;

async function manterTelaAcesa(): Promise<void> {
  queroTelaAcesa = true;
  const nav = navigator as unknown as { wakeLock?: { request: (t: string) => Promise<TravaTela> } };
  if (nav.wakeLock === undefined || travaTela !== null) return;
  try {
    travaTela = await nav.wakeLock.request("screen");
  } catch {
    /* recusado (bateria fraca, aba em segundo plano): a Ajuda cobre o caso */
  }
}

function soltarTela(): void {
  queroTelaAcesa = false;
  void travaTela?.release().catch(() => {});
  travaTela = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    travaTela = null;
    return;
  }
  if (queroTelaAcesa) void manterTelaAcesa();
});

// ------------------------------------------------------------------ visor ao vivo
/**
 * O visor compartilha o MESMO objeto `roi` da análise. Mirar ao vivo já deixa a faixa no lugar
 * certo para o vídeo que vem a seguir — em vez de posicionar a linha depois, num quadro congelado.
 */
/** O último resultado já transformado em passada — para não abrir a mesma duas vezes. */
let resultadoVisor: RunResult | null = null;
/**
 * Tocou em Armar antes de a calibragem terminar.
 *
 * Antes o `armar()` desistia em silêncio nesse caso e a tela trocava o botão e mostrava 0.000 assim
 * mesmo: parecia armado e nunca disparava. Agora o pedido fica guardado e o cronômetro arma sozinho
 * no instante em que a cena for medida.
 */
let armarPendente = false;
/** Qual dica de diagnóstico está na tela, para não reescrever o DOM a cada quadro. */
let dicaVisor: "nenhuma" | "mira" | "limiar" = "nenhuma";
/**
 * Disparar sozinho: arma assim que a cena é medida e rearma depois de cada passada.
 *
 * É o modo de quem está na beira da pista — abrir o celular e não tocar em mais nada entre um
 * cavalo e outro. O preço é que ele dispara em QUALQUER coisa que cruze a faixa (poeira, alguém
 * atravessando), e por isso a passada anterior é salva antes de rearmar: nada se perde, e o que
 * não for cavalo se apaga depois no Histórico.
 */
let autoVisor = true;
let timerRearmar = 0;
let passadaVisor: Passada | null = null;

const visor = new Visor(
  $<HTMLVideoElement>("visorVideo"),
  $<HTMLCanvasElement>("visorFaixa"),
  roi,
  {
    onQuadro: (fps, delta, limiar, cruzando) => {
      const barra = $("visorBarra");
      const nivel = limiar === null ? 0 : Math.min(1, delta / (limiar * 2));
      $<HTMLElement>("visorBarra").firstElementChild!.setAttribute(
        "style",
        `width:${(nivel * 100).toFixed(0)}%`,
      );
      barra.classList.toggle("cruzando", cruzando);
      const prog = visor.calibragemProgresso;
      const recomecos = visor.calibragemRecomecos;
      const pico = visor.picoRecente;
      $("visorEstado").textContent =
        limiar === null
          ? `medindo a cena parada… ${prog.feitas}/${prog.total}` +
            (recomecos > 0 ? ` · recomeçou ${recomecos}× (algo se mexeu na linha)` : "") +
            ` · ${fps.toFixed(0)} quadros por segundo`
          : `${cruzando ? "CRUZANDO" : "livre"} · movimento ${delta.toFixed(1)} · maior ${pico.toFixed(1)} (limiar ${limiar.toFixed(1)}) · ${fps.toFixed(0)} quadros por segundo`;
      // O diagnóstico de "por que não disparou?", dito em português enquanto ele está na pista.
      // O valor instantâneo pisca rápido demais para ser lido com o cavalo passando; o MAIOR dos
      // últimos segundos é que separa "a linha está no lugar errado" de "o limiar ficou alto".
      // Só escreve quando MUDA: `innerHTML` a cada quadro custa uma reconstrução de DOM por quadro,
      // rouba tempo do laço da câmera e faz perder quadro — que é exatamente o que estraga a medição.
      const qual =
        limiar === null || pico >= limiar ? "nenhuma" : pico < limiar * 0.35 ? "mira" : "limiar";
      if (qual !== dicaVisor) {
        dicaVisor = qual;
        const dica = $("visorDica");
        dica.hidden = qual === "nenhuma";
        if (qual === "mira") {
          dica.innerHTML =
            "<b>Nada cruzou a faixa ainda.</b> O maior movimento visto está bem abaixo do limiar — " +
            "arraste a linha vermelha até onde o cavalo passa, e as alças até a altura do peito dele.";
        } else if (qual === "limiar") {
          dica.innerHTML =
            "<b>Passou perto, mas não alcançou o limiar.</b> A cena provavelmente estava se mexendo " +
            "na hora da medição. Com a pista vazia, toque em <b>Medir a cena de novo</b>.";
        }
      }
      // Pedido de armar que estava esperando a cena: arma no instante em que o limiar aparece.
      if (armarPendente && limiar !== null) armarAgora();
      // E, no modo "sozinho", o pedido é permanente: assim que houver limiar e não houver passada
      // em andamento nem rearme agendado, ele arma por conta própria.
      else if (autoVisor && limiar !== null && !visor.armado && timerRearmar === 0) armarAgora();
    },
    onCronometro: (estado, decorridoNs, resultado) => {
      $("visorTempo").hidden = false;
      const fase: Record<string, string> = {
        ARMED: "armado — esperando a largada",
        CONFIRMING_START: "confirmando a largada…",
        DEBOUNCE_START: "largou! (bloqueio para o resto do cavalo passar)",
        RUNNING: "correndo",
        AWAITING_FINISH: "esperando a chegada",
        CONFIRMING_FINISH: "confirmando a chegada…",
        DEBOUNCE_FINISH: "chegou!",
        FINISHED: "tempo fechado",
      };
      // Nada de número de precisão cravado aqui: o que vale é o que o estimador declarar em cada
      // gatilho, e isso aparece no cartão quando o tempo fecha.
      $("visorFase").textContent =
        `${fase[estado] ?? estado} · ${visor.taxaMedida.toFixed(0)} quadros por segundo` +
        (visor.porQuadroDaCamera ? "" : " · laço da tela (o navegador não entrega quadro a quadro)");
      if (resultado) {
        $("visorRelogio").textContent = formatElapsed(resultado.elapsedRefinedNs);
      } else if (decorridoNs !== null) {
        $("visorRelogio").textContent = formatElapsed(decorridoNs);
      }
      if (resultado !== null && resultado !== resultadoVisor) {
        resultadoVisor = resultado;
        abrirPassadaAoVivo(resultado);
        if (autoVisor) agendarRearme();
      }
    },
    onErro: (m) => {
      aviso(m);
      $("abrirVisor").hidden = false;
      $("fecharVisor").hidden = true;
      $("palcoVisor").hidden = true;
      $("visorSinal").hidden = true;
      $("visorAjustes").hidden = true;
    },
  },
);

function fecharVisor(): void {
  if (!visor.ativo) return;
  soltarTela();
  clearInterval(timerGravacao);
  timerGravacao = 0;
  clearTimeout(timerRearmar);
  timerRearmar = 0;
  armarPendente = false;
  visor.desarmar();
  visor.fechar();
  $("armarVisor").hidden = false;
  $("desarmarVisor").hidden = true;
  $("desarmarVisor").textContent = "Parar";
  $("visorPendente").hidden = true;
  $("visorTempo").hidden = true;
  $("abrirVisor").hidden = false;
  $("fecharVisor").hidden = true;
  $("palcoVisor").hidden = true;
  $("visorSinal").hidden = true;
  $("visorAjustes").hidden = true;
}

$("abrirVisor").addEventListener("click", async () => {
  $("abrirVisor").hidden = true;
  $("palcoVisor").hidden = false;
  $("visorSinal").hidden = false;
  $("visorAjustes").hidden = false;
  relogioParado("não armado — toque em Armar quando a linha estiver no lugar");
  $("visorEstado").textContent = "abrindo a câmera…";
  await visor.abrir();
  if (visor.ativo) {
    $("fecharVisor").hidden = false;
    iniciarPinturaVisor();
    void manterTelaAcesa();
  }
});
$("fecharVisor").addEventListener("click", fecharVisor);

/** Arma de verdade, e só então a tela diz que está armado. Devolve se conseguiu. */
/**
 * O relógio fica SEMPRE visível com a câmera aberta, marcando 0.000, e quem diz o que está
 * acontecendo é a linha de baixo. Escondê-lo até armar deixava a tela sem cronômetro nenhum — e a
 * primeira pergunta de quem abre o visor é justamente "cadê o cronômetro?".
 */
function relogioParado(fase: string): void {
  $("visorTempo").hidden = false;
  $("visorRelogio").textContent = "0.000";
  $("visorFase").textContent = fase;
}

function armarAgora(): boolean {
  if (!visor.armar()) return false;
  armarPendente = false;
  $("armarVisor").hidden = true;
  $("desarmarVisor").hidden = false;
  $("desarmarVisor").textContent = "Parar";
  $("visorPendente").hidden = true;
  $("visorTempo").hidden = false;
  $("visorRelogio").textContent = "0.000";
  $("visorFase").textContent = `armado — esperando a largada · ${visor.taxaMedida.toFixed(0)} quadros por segundo`;
  return true;
}

$("armarVisor").addEventListener("click", () => {
  // Armar recomeça a passada: o cartão anterior sai da tela para não haver dúvida de qual tempo é
  // qual — e para que "Salvar" nunca grave o tempo da passada passada.
  resultadoVisor = null;
  passadaVisor = null;
  $("resultadoVisor").hidden = true;
  $("resultadoVisor").innerHTML = "";
  if (armarAgora()) return;
  // A calibragem ainda não terminou. Em vez de fingir que armou (o defeito de antes), o pedido fica
  // de pé e a tela diz o que está faltando.
  armarPendente = true;
  $("armarVisor").hidden = true;
  $("desarmarVisor").hidden = false;
  $("desarmarVisor").textContent = "Cancelar";
  $("visorPendente").hidden = false;
  relogioParado("ainda não armado — esperando a cena ser medida");
});

/**
 * Rearma para a próxima passada, guardando a que acabou.
 *
 * A espera existe para dar tempo de ler o tempo na tela; salvar antes de rearmar é o que impede a
 * passada de sumir quando o cavalo seguinte entra na pista sem ninguém ter tocado em nada.
 */
function agendarRearme(): void {
  clearTimeout(timerRearmar);
  timerRearmar = window.setTimeout(() => {
    timerRearmar = 0;
    if (!visor.ativo || !autoVisor) return;
    if (passadaVisor !== null) {
      store.salvarPassada(passadaVisor);
      desenharHistorico();
      aviso("Passada salva sozinha. O tempo da fotocélula pode ser digitado depois, no Histórico.", true);
    }
    passadaVisor = null;
    resultadoVisor = null;
    $("resultadoVisor").hidden = true;
    $("resultadoVisor").innerHTML = "";
    visor.desarmar();
    armarAgora();
  }, 6000);
}

// ---------------------------------------------------------------- gravar a passada
/** Endereço do último vídeo gravado. Revogado ao descartar ou ao gravar outro. */
let urlVideoSalvo: string | null = null;
let timerGravacao = 0;
/** Teto da gravação, em segundos: memória de uma aba de celular não é infinita. */
const MAX_GRAVACAO_S = 120;

function pintarBotaoGravar(): void {
  const b = $("gravarVisor");
  if (visor.gravando) {
    b.textContent = "Parar e salvar";
    b.classList.add("perigo");
    $("gravarEstado").textContent = `gravando… ${visor.segundosGravados.toFixed(0)} s`;
  } else {
    b.textContent = "Gravar vídeo";
    b.classList.remove("perigo");
    $("gravarEstado").textContent = "";
  }
}

async function pararEGuardarVideo(): Promise<void> {
  clearInterval(timerGravacao);
  timerGravacao = 0;
  const blob = await visor.pararGravacao();
  pintarBotaoGravar();
  if (blob === null || blob.size === 0) return aviso("Não veio nada na gravação.");
  if (urlVideoSalvo !== null) URL.revokeObjectURL(urlVideoSalvo);
  urlVideoSalvo = URL.createObjectURL(blob);
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  const nome = `passada-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  const el = $("videoSalvo");
  el.hidden = false;
  el.innerHTML = `<div class="resultado">
    <div class="quem">Vídeo desta passada</div>
    <p class="detalhe">${(blob.size / 1048576).toFixed(1)} MB · ${escapar(blob.type || "vídeo")}</p>
    <div class="linha">
      <a class="botao grande primario" id="baixarVideo" download="${nome}" href="${urlVideoSalvo}">Baixar o vídeo</a>
      <button class="botao" id="descartarVideo">Descartar</button>
    </div>
    <p class="dica">No iPhone, o botão abre o vídeo — use <b>Compartilhar → Salvar em Vídeos</b>.
       Esta gravação é da câmera do navegador (30 ou 60 quadros por segundo), então serve de prova
       do que disparou, <b>não</b> para remedir no milésimo.</p>
  </div>`;
  $("descartarVideo").addEventListener("click", () => {
    if (urlVideoSalvo !== null) URL.revokeObjectURL(urlVideoSalvo);
    urlVideoSalvo = null;
    el.hidden = true;
    el.innerHTML = "";
  });
}

$("gravarVisor").addEventListener("click", () => {
  if (visor.gravando) return void pararEGuardarVideo();
  if (!visor.ativo) return aviso("Abra a câmera primeiro.");
  if (!Visor.podeGravar || !visor.iniciarGravacao()) {
    return aviso("Este navegador não grava vídeo. No iPhone, use o Safari atualizado.");
  }
  pintarBotaoGravar();
  timerGravacao = window.setInterval(() => {
    pintarBotaoGravar();
    // Teto de tempo: uma gravação esquecida ligada encheria a memória da aba no meio da prova.
    if (visor.segundosGravados >= MAX_GRAVACAO_S) {
      aviso(`Gravação fechada em ${MAX_GRAVACAO_S} s para não encher a memória.`);
      void pararEGuardarVideo();
    }
  }, 500);
});

$<HTMLInputElement>("visorAuto").addEventListener("change", (ev) => {
  autoVisor = (ev.target as HTMLInputElement).checked;
  clearTimeout(timerRearmar);
  timerRearmar = 0;
  if (!autoVisor && visor.armado) {
    visor.desarmar();
    $("armarVisor").hidden = false;
    $("desarmarVisor").hidden = true;
    relogioParado("não armado — toque em Armar quando quiser");
  }
  aviso(autoVisor ? "Vai disparar sozinho a cada passada." : "Agora só dispara quando você armar.");
});

$("recalibrarVisor").addEventListener("click", () => {
  visor.reiniciarMedicao();
  armarPendente = false;
  $("armarVisor").hidden = false;
  $("desarmarVisor").hidden = true;
  $("desarmarVisor").textContent = "Parar";
  $("visorPendente").hidden = true;
  $("visorDica").hidden = true;
  dicaVisor = "nenhuma";
  relogioParado("não armado — medindo a cena");
  aviso("Medindo a cena de novo — deixe a pista vazia por uns segundos.", true);
});

$<HTMLInputElement>("visorMao").addEventListener("change", (ev) => {
  visor.naMao = (ev.target as HTMLInputElement).checked;
  // A medição da cena tem de recomeçar: o que conta como "parado" é outro quando o celular treme.
  visor.reiniciarMedicao();
  armarPendente = false;
  $("armarVisor").hidden = false;
  $("desarmarVisor").hidden = true;
  $("desarmarVisor").textContent = "Parar";
  $("visorPendente").hidden = true;
  relogioParado("não armado — medindo a cena");
  aviso(
    visor.naMao
      ? "Modo na mão: medindo a cena de novo. O tempo daqui não entra na conferência com a fotocélula."
      : "Modo tripé: medindo a cena de novo.",
  );
});

$<HTMLInputElement>("visorEnsaio").addEventListener("change", (ev) => {
  visor.ensaio = (ev.target as HTMLInputElement).checked;
  if (visor.armado) aviso("O ensaio vale a partir do próximo Armar.");
});

/**
 * O tempo ao vivo vira uma passada de verdade.
 *
 * Sem isto o número aparecia na tela e morria ali — e a comparação entre o caminho ao vivo e o do
 * arquivo, que é a razão de existir do modo, seria impossível de fazer.
 */
function abrirPassadaAoVivo(r: RunResult): void {
  passadaVisor = {
    id: novoId(),
    dataMs: Date.now(),
    // Sem dono até alguém dizer de quem é — ver `amarrarAoProximo`.
    competidor: "",
    cavalo: "",
    categoria: "",
    ordem: 0,
    eventoId: store.eventoAtualId,
    inscricaoId: null,
    elapsedRawNs: r.elapsedRawNs,
    elapsedRefinedNs: r.elapsedRefinedNs,
    tamboresDerrubados: 0,
    semTempo: false,
    qualidadeLargada: r.start.quality,
    qualidadeChegada: r.finish.quality,
    incertezaLargadaNs: r.start.uncertaintyNs,
    incertezaChegadaNs: r.finish.uncertaintyNs,
    // Quadro perdido OU laço da tela: os dois valem marca. Sem `requestVideoFrameCallback` o
    // navegador repete quadro e a contagem de perdidos nem existe — medir assim é medição
    // degradada, e tem de ficar escrito na passada, não só na tela.
    degradada: r.degraded || visor.quadrosPerdidos > 0 || !visor.porQuadroDaCamera,
    fps: visor.taxaMedida,
    quadrosPerdidos: visor.quadrosPerdidos,
    arquivo: "",
    origem: visor.naMao ? "ao-vivo-mao" : "ao-vivo",
  };
  // Guarda na hora, como no caminho do arquivo: o cavalo seguinte não pode apagar este tempo.
  store.salvarPassada(passadaVisor);
  desenharHistorico();
  desenharCartaoVisor();
}

function desenharCartaoVisor(): void {
  const p = passadaVisor;
  if (p === null) return;
  const el = $("resultadoVisor");
  el.hidden = false;
  const qualidade = Math.min(p.qualidadeLargada, p.qualidadeChegada);
  const incerteza = (p.incertezaLargadaNs + p.incertezaChegadaNs) / 1e6;
  const finalNs = p.elapsedRefinedNs + p.tamboresDerrubados * 5_000_000_000;
  const quem = p.inscricaoId
    ? `#${p.ordem} ${p.competidor}${p.cavalo ? ` / ${p.cavalo}` : ""}${p.categoria ? ` — ${p.categoria}` : ""}`
    : "Sem competidor";
  el.innerHTML = `<div class="resultado">
    <div class="quem">${escapar(quem)} · ${nomeOrigem(origemDe(p))}</div>
    <div class="tempo ${p.semTempo ? "sat" : ""}">${p.semTempo ? "SAT" : formatElapsed(finalNs)}</div>
    <div>
      <span class="selo q${qualidade}">qualidade ${qualidade} · ±${incerteza.toFixed(2)} ms</span>
      ${p.degradada ? '<span class="selo aviso">degradada</span>' : ""}
    </div>
    <p class="detalhe">
      refinado ${formatElapsed(p.elapsedRefinedNs)} · bruto ${formatElapsed(p.elapsedRawNs)}<br>
      ${p.fps.toFixed(0)} quadros por segundo${p.quadrosPerdidos > 0 ? ` · <b>${p.quadrosPerdidos} quadro(s) perdido(s)</b>` : ""}
    </p>
    <div class="linha">
      <button class="botao" id="visorMenosTambor">− tambor</button>
      <span class="detalhe">${p.tamboresDerrubados} tambor(es) · +${p.tamboresDerrubados * 5} s</span>
      <button class="botao" id="visorMaisTambor">+ tambor</button>
      <button class="botao" id="visorSat">${p.semTempo ? "SAT ✓" : "SAT"}</button>
    </div>
    <div class="linha conferencia">
      <label for="visorOficial">Tempo da cronometragem oficial</label>
      <input type="text" id="visorOficial" inputmode="decimal" placeholder="14,325"
             value="${escapar(p.oficialTexto ?? "")}">
      <span class="detalhe" id="visorErroOficial"></span>
    </div>
    <div class="linha">
      <button class="botao grande primario" id="visorSalvar">
        ${p.inscricaoId ? `Salvar para #${p.ordem}` : "Salvar no histórico"}
      </button>
    </div>
  </div>`;

  $("visorMenosTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.max(0, p.tamboresDerrubados - 1);
    store.salvarPassada(p);
    desenharCartaoVisor();
  });
  $("visorMaisTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.min(3, p.tamboresDerrubados + 1);
    store.salvarPassada(p);
    desenharCartaoVisor();
  });
  $("visorSat").addEventListener("click", () => {
    p.semTempo = !p.semTempo;
    store.salvarPassada(p);
    desenharCartaoVisor();
  });

  // Mesma regra do cartão do vídeo: o campo do oficial NUNCA repinta o cartão, senão o foco e o que
  // está sendo digitado se perdem a cada tecla.
  const campo = $<HTMLInputElement>("visorOficial");
  const pintarErro = (): void => {
    const oficial = parseTempo(campo.value);
    const alvo = $("visorErroOficial");
    if (oficial === null) {
      alvo.textContent = campo.value.trim() === "" ? "" : "não entendi esse tempo";
      alvo.className = "detalhe";
      return;
    }
    if (!oficialPlausivel(p, oficial)) {
      alvo.textContent = `esse tempo não parece o desta passada (medido ${formatElapsed(p.elapsedRefinedNs)}) — faltou a vírgula?`;
      alvo.className = "detalhe conf-fora";
      return;
    }
    const erroNs = p.elapsedRefinedNs - oficial;
    const incertezaNs = p.incertezaLargadaNs + p.incertezaChegadaNs;
    const dentro = Math.abs(erroNs) <= incertezaNs;
    const lado = erroNs >= 0 ? "o app mediu mais" : "o app mediu menos";
    alvo.textContent = `${erroEmMs(erroNs)} — ${lado} · ${dentro ? "dentro" : "FORA"} do ±${(incertezaNs / 1e6).toFixed(2)} ms declarado`;
    alvo.className = `detalhe ${dentro ? "conf-ok" : "conf-fora"}`;
  };
  campo.addEventListener("input", () => {
    p.oficialTexto = campo.value;
    const lido = parseTempo(campo.value);
    // Absurdo não entra: fica na tela para ele corrigir, mas não contamina a conferência.
    p.oficialNs = oficialPlausivel(p, lido) ? lido : null;
    pintarErro();
  });
  pintarErro();

  $("visorSalvar").addEventListener("click", () => {
    p.oficialTexto = campo.value;
    const lido = parseTempo(campo.value);
    p.oficialNs = oficialPlausivel(p, lido) ? lido : null;
    amarrarAoProximo(p);
    store.salvarPassada(p);
    aviso(p.inscricaoId ? `Passada de #${p.ordem} guardada.` : "Passada guardada.", true);
    atualizarProximo();
    desenharHistorico();
    desenharCartaoVisor();
  });
}
$("desarmarVisor").addEventListener("click", () => {
  // Parar é parar: desliga também o rearme automático, senão o cronômetro voltaria sozinho.
  autoVisor = false;
  $<HTMLInputElement>("visorAuto").checked = false;
  clearTimeout(timerRearmar);
  timerRearmar = 0;
  armarPendente = false;
  visor.desarmar();
  $("armarVisor").hidden = false;
  $("desarmarVisor").hidden = true;
  $("desarmarVisor").textContent = "Parar";
  $("visorPendente").hidden = true;
});

/**
 * Liga o laço que desenha a linha sobre a câmera.
 *
 * Tem de ser chamado DEPOIS de a câmera abrir. Antes ele era disparado no toque do botão, quando
 * `visor.ativo` ainda era falso porque `abrir()` é assíncrono: o laço pintava uma vez e parava na
 * própria condição de continuar. Com o canvas esticado por CSS ninguém percebia — a linha caía no
 * lugar certo por acaso, já que esticar preserva a fração. Com o canvas posicionado sobre o
 * retângulo do vídeo, o mesmo defeito deixaria a mira do tamanho errado.
 */
let iniciarPinturaVisor: () => void = () => {};

// arrastar a linha e as alças TAMBÉM no visor, com a mesma matemática do editor
{
  const palcoV = $("palcoVisor");
  const over = $<HTMLCanvasElement>("visorOverlay");
  let arr: "linha" | "topo" | "base" | null = null;
  // Sempre pelo retângulo do VÍDEO: o container pode ser mais largo que ele (o vídeo é limitado
  // pela altura), e medir pelo container faria o dedo cair numa coluna diferente da que ele vê.
  const pos = (ev: PointerEvent): { x: number; y: number } => {
    const r = $<HTMLVideoElement>("visorVideo").getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { x: roi.lineXFraction, y: roi.bandTopFraction };
    return {
      x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
    };
  };
  const pintar = (): void => {
    const v = $<HTMLVideoElement>("visorVideo");
    // O canvas cobre o retângulo do vídeo, não o do container: é isso que mantém a linha desenhada
    // e a faixa medida na MESMA coluna, seja qual for o tamanho em que o vídeo acabou desenhado.
    const rv = v.getBoundingClientRect();
    const rp = palcoV.getBoundingClientRect();
    if (rv.width < 1 || rv.height < 1) {
      if (visor.ativo) requestAnimationFrame(pintar);
      return;
    }
    const w = Math.max(1, Math.round(rv.width));
    const h = Math.max(1, Math.round(rv.height));
    over.style.left = `${Math.round(rv.left - rp.left)}px`;
    over.style.top = `${Math.round(rv.top - rp.top)}px`;
    over.style.width = `${w}px`;
    over.style.height = `${h}px`;
    if (over.width !== w || over.height !== h) {
      over.width = w;
      over.height = h;
    }
    const ctx = over.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    const x = roi.lineXFraction * w;
    const top = roi.bandTopFraction * h;
    const bot = roi.bandBottomFraction * h;
    const vw = v.videoWidth || 1280;
    const meia = Math.max(2, (roi.stripWidthPx / 2) * (w / vw));
    ctx.setLineDash([10, 10]);
    ctx.strokeStyle = "rgba(255, 214, 64, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(215, 38, 61, 0.35)";
    ctx.fillRect(x - meia, top, meia * 2, bot - top);
    ctx.strokeStyle = "#d7263d";
    ctx.lineWidth = 3;
    ctx.strokeRect(x - meia, top, meia * 2, bot - top);
    for (const y of [top, bot]) {
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (visor.ativo) requestAnimationFrame(pintar);
  };
  palcoV.addEventListener("pointerdown", (ev) => {
    const p = pos(ev);
    const perto = (a: number, b: number): boolean => Math.abs(a - b) < 0.06;
    arr = perto(p.y, roi.bandTopFraction) && perto(p.x, roi.lineXFraction)
      ? "topo"
      : perto(p.y, roi.bandBottomFraction) && perto(p.x, roi.lineXFraction)
        ? "base"
        : "linha";
    palcoV.setPointerCapture(ev.pointerId);
    moverVisor(p);
  });
  palcoV.addEventListener("pointermove", (ev) => {
    if (arr === null) return;
    ev.preventDefault();
    moverVisor(pos(ev));
  });
  for (const e of ["pointerup", "pointercancel"]) palcoV.addEventListener(e, () => (arr = null));
  function moverVisor(p: { x: number; y: number }): void {
    const lim = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
    if (arr === "topo") roi.bandTopFraction = lim(p.y, 0, roi.bandBottomFraction - 0.05);
    else if (arr === "base") roi.bandBottomFraction = lim(p.y, roi.bandTopFraction + 0.05, 1);
    else roi.lineXFraction = lim(p.x, 0.03, 0.97);
    // mexer na faixa invalida a calibragem: a cena medida passou a ser outra
    visor.reiniciarMedicao();
    guardarRoi(true);
    desenharOverlay();
  }
  iniciarPinturaVisor = (): void => {
    requestAnimationFrame(pintar);
  };
}

// Só registra o service worker quando a página é servida por um site (num visualizador embutido
// não há sw.js e o pedido só geraria erro). Sem ele o app funciona igual — só não abre sem sinal.
if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !ARQUIVO_UNICO) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    /* sem service worker o app funciona igual, só não abre offline */
  });
  // O service worker é cache-first: sem isto, uma versão nova fica esperando o usuário fechar e
  // reabrir a aba — e ele testaria a versão velha achando que é a nova. Já aconteceu neste projeto.
  let jaControlado = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!jaControlado) {
      jaControlado = true;
      return;
    }
    aviso("Versão nova disponível — recarregue a página para usá-la.", true);
  });
}
