/**
 * Tela do app. Sem framework de propósito: uma página, sem dependências, funciona offline e abre
 * instantaneamente num celular na arena.
 */
import { analyzeVideo, configForFile, probeFramePeriod, roiPixels, type AnalysisResult } from "./analyze.ts";
import { defaultConfig } from "./core/photocellConfig.ts";
import { formatElapsed } from "./core/timeFormatter.ts";
import {
  csvClassificacao,
  csvHistorico,
  lerCsvInscricoes,
  novoId,
  Store,
  type Inscricao,
  type Passada,
} from "./store.ts";
import { probeFileInfo } from "./videoDecoderReader.ts";
import { supportsFrameCallback } from "./videoStripReader.ts";

/** Ligado na versão de arquivo único (página embutida): sem service worker, sem manifesto. */
declare const ARQUIVO_UNICO: boolean;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const store = new Store();

// ROI em fração (a mesma convenção do app nativo)
const roi = { lineXFraction: 0.5, bandTopFraction: 0.3, bandBottomFraction: 0.7, stripWidthPx: 15 };

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
  });
}

// ------------------------------------------------------------------ escolher o vídeo
$<HTMLInputElement>("arquivo").addEventListener("change", async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  arquivo = f;
  $("resultado").hidden = true;
  await mostrarPrimeiroQuadro(f);
});

/** Mostra o primeiro quadro do vídeo para o usuário posicionar a linha e a banda. */
async function mostrarPrimeiroQuadro(f: File): Promise<void> {
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
    aviso((e as Error).message);
  } finally {
    // soltar o vídeo ANTES de liberar o endereço: revogar com o elemento ainda carregando faz o
    // navegador registrar uma falha de carregamento (e, no iPhone, pode abortar o primeiro quadro)
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
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
for (const e of ["pointerup", "pointercancel"]) palco.addEventListener(e, () => (arrastando = null));

function moverROI(p: { x: number; y: number }): void {
  const lim = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  if (arrastando === "topo") roi.bandTopFraction = lim(p.y, 0, roi.bandBottomFraction - 0.05);
  else if (arrastando === "base") roi.bandBottomFraction = lim(p.y, roi.bandTopFraction + 0.05, 1);
  else roi.lineXFraction = lim(p.x, 0.03, 0.97);
  desenharOverlay();
}

$<HTMLInputElement>("largura").addEventListener("input", (ev) => {
  roi.stripWidthPx = Number((ev.target as HTMLInputElement).value);
  $("larguraOut").textContent = String(roi.stripWidthPx);
  desenharOverlay();
});

// ------------------------------------------------------------------ analisar
$("analisar").addEventListener("click", async () => {
  if (!arquivo) return;
  if (!supportsFrameCallback()) {
    aviso("Este navegador não entrega os quadros do vídeo. No iPhone, use o Safari.");
    return;
  }
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
  const prox = store.proximaInscricao();
  const p: Passada = {
    id: novoId(),
    dataMs: Date.now(),
    competidor: prox?.competidor ?? "",
    cavalo: prox?.cavalo ?? "",
    categoria: prox?.categoria ?? "",
    ordem: prox?.ordem ?? 0,
    eventoId: prox ? store.eventoAtualId : null,
    inscricaoId: prox?.id ?? null,
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
  };
  passadaAberta = p;
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
    <div class="linha">
      <button class="botao grande primario" id="salvarPassada">
        ${p.inscricaoId ? `Salvar para #${p.ordem}` : "Salvar no histórico"}
      </button>
    </div>
  </div>`;
  $("menosTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.max(0, p.tamboresDerrubados - 1);
    desenharCartao(segundos, res);
  });
  $("maisTambor").addEventListener("click", () => {
    p.tamboresDerrubados = Math.min(3, p.tamboresDerrubados + 1);
    desenharCartao(segundos, res);
  });
  $("botaoSat").addEventListener("click", () => {
    p.semTempo = !p.semTempo;
    desenharCartao(segundos, res);
  });
  $("salvarPassada").addEventListener("click", () => {
    store.salvarPassada(p);
    aviso("Passada salva no histórico.", true);
    atualizarProximo();
    desenharHistorico();
  });
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
    div.innerHTML = `<div class="cresce">
      <div><b>${p.semTempo ? "SAT" : formatElapsed(finalNs)}</b> ${escapar(
        [p.competidor, p.cavalo].filter(Boolean).join(" · "),
      )}</div>
      <div class="sub">${new Date(p.dataMs).toLocaleString("pt-BR")} · bruto ${formatElapsed(
        p.elapsedRawNs,
      )} · q${p.qualidadeLargada}/${p.qualidadeChegada}${p.degradada ? " · degradada" : ""}</div></div>`;
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

$("exportarHistorico").addEventListener("click", () => {
  if (store.passadas.length === 0) return aviso("Histórico vazio.");
  baixar("fotocelula-historico.csv", csvHistorico(store.passadas));
});

$("limparHistorico").addEventListener("click", () => {
  if (!confirm("Apagar todas as passadas do histórico?")) return;
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
$("versao").textContent = `Fotocélula Tambor · versão web · núcleo conferido pelos mesmos 30 vetores do app nativo.`;
if (!supportsFrameCallback()) {
  aviso("Este navegador não consegue ler os quadros do vídeo. No iPhone, abra pelo Safari.");
}
// Só registra o service worker quando a página é servida por um site (num visualizador embutido
// não há sw.js e o pedido só geraria erro). Sem ele o app funciona igual — só não abre sem sinal.
if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !ARQUIVO_UNICO) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    /* sem service worker o app funciona igual, só não abre offline */
  });
}
