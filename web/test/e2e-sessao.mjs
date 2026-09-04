/**
 * Uma SESSÃO inteira: várias passadas seguidas, como num dia de calibração.
 *
 *   node test/e2e-sessao.mjs [video.mp4]
 *
 * Por que existe: todos os outros testes de navegador analisam UM vídeo por execução, e é
 * justamente o que acontece da segunda passada em diante que estraga um dia de dados — cartão
 * antigo ainda na tela, passada órfã de prova, conferência somando o histórico inteiro, linha
 * perdida ao recarregar a página. Nada disso aparece com uma passada só.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
const video = process.argv[2] ?? "/tmp/prova-sintetica.mp4";
if (!existsSync(video)) {
  console.error(`falta o vídeo: ${video}`);
  process.exit(2);
}
const naoVideo = "/tmp/nao-e-video.txt";
writeFileSync(naoVideo, "isto não é um vídeo\n");

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const servidor = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (rel === "favicon.ico") return void res.writeHead(200, { "content-type": "image/x-icon" }).end();
  try {
    const corpo = readFileSync(path.join(dist, rel));
    res.writeHead(200, { "content-type": TIPOS[path.extname(rel)] ?? "application/octet-stream" });
    res.end(corpo);
  } catch { res.writeHead(404).end("não encontrado"); }
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const porta = servidor.address().port;

const navegador = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const pagina = await navegador.newPage();
const erros = [];
pagina.on("pageerror", (e) => erros.push(String(e)));
pagina.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) erros.push(m.text()); });

let falhou = false;
const checar = (ok, msg) => { console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`); if (!ok) falhou = true; };
const aba = (nome) => pagina.click(`#abas button[data-aba="${nome}"]`);

/** "+3,2 ms" — a mesma formatação de `validacao.ts`, para comparar o texto da tela. */
const erroEmMs = (ns) => `${ns >= 0 ? "+" : "−"}${Math.abs(ns / 1e6).toFixed(1).replace(".", ",")} ms`;

/**
 * Uma análise, do arquivo ao tempo medido.
 *
 * Espera pelo gancho `window.ultimaAnalise`, e NÃO por `#resultado:not([hidden])`: o cartão da
 * passada anterior já satisfaz esse seletor, e o teste passaria antes de a análise nova terminar.
 */
async function analisar() {
  await pagina.evaluate(() => { window.ultimaAnalise = null; });
  await pagina.setInputFiles("#arquivo", video);
  await pagina.waitForSelector("#editor:not([hidden])", { timeout: 30_000 });
  await pagina.click("#analisar");
  await pagina.waitForFunction(() => window.ultimaAnalise != null, null, { timeout: 180_000 });
  return await pagina.evaluate(() => window.ultimaAnalise.run.elapsedRefinedNs);
}

try {
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#analisar", { state: "attached" });

  // ---------------------------------------------------------------- a prova do dia
  console.log("\n### a prova do dia");
  await aba("prova");
  await pagina.fill("#provaNome", "Calibração 04/09");
  await pagina.click("#criarProva");
  checar((await pagina.textContent("#listaProvas")).includes("Calibração 04/09"), "a prova do dia foi criada");

  // ---------------------------------------------------------------- a linha, mirada uma vez
  console.log("\n### a linha fica guardada");
  await aba("passada");
  // A linha fica no meio de propósito: é onde a verdade do vídeo sintético está definida. Mover o
  // X mudaria o instante de cada cruzamento e os tempos oficiais abaixo deixariam de valer — o que
  // seria um teste de outra coisa. O que se guarda aqui é a banda e a largura.
  await pagina.evaluate(() => window.definirROI(0.5, 0.25, 0.75, 21));
  const roiGravada = await pagina.evaluate(() =>
    JSON.parse(localStorage.getItem("fotocelula.dados.v1") ?? "{}").roi,
  );
  checar(
    roiGravada != null && Math.abs(roiGravada.bandTopFraction - 0.25) < 1e-6 && roiGravada.stripWidthPx === 21,
    `a linha foi guardada (${JSON.stringify(roiGravada)})`,
  );

  // ---------------------------------------------------------------- três passadas seguidas
  console.log("\n### três passadas seguidas, uma por vez");
  const oficiais = ["2,500", "2,505", "2,495"];
  const errosNs = [];
  for (let i = 0; i < oficiais.length; i++) {
    const medidoNs = await analisar();
    await pagina.fill("#tempoOficial", oficiais[i]);
    const veredicto = await pagina.textContent("#erroOficial");
    await pagina.click("#salvarPassada");
    const oficialNs = Math.round(Number(oficiais[i].replace(",", ".")) * 1e9);
    errosNs.push(medidoNs - oficialNs);
    console.log(`    passada ${i + 1}: medido ${(medidoNs / 1e9).toFixed(4)} s · oficial ${oficiais[i]} · ${veredicto}`);
  }
  const guardadas = await pagina.evaluate(() =>
    JSON.parse(localStorage.getItem("fotocelula.dados.v1") ?? "{}").passadas ?? [],
  );
  checar(guardadas.length === 3, `as três passadas foram salvas (${guardadas.length})`);
  checar(
    guardadas.every((p) => typeof p.eventoId === "string" && p.eventoId.length > 0),
    "toda passada pertence à prova do dia, mesmo sem competidor",
  );
  checar(guardadas.every((p) => p.origem === "video"), "gravadas com origem \"video\"");

  // ---------------------------------------------------------------- o resumo
  console.log("\n### a conferência");
  await aba("historico");
  const resumo = await pagina.textContent("#resumoConferencia");
  const viesEsperado = erroEmMs(errosNs.reduce((a, b) => a + b, 0) / errosNs.length);
  console.log(`    resumo: ${resumo.replace(/\s+/g, " ").trim()}`);
  checar(/3 passada\(s\) com tempo oficial/.test(resumo), "o resumo conta as três");
  checar(resumo.includes(viesEsperado), `o viés bate com a conta feita fora (${viesEsperado})`);
  // Os tempos oficiais foram espalhados ±5 ms de propósito: com ±0,9 ms declarados, duas TÊM de
  // aparecer como fora. Um resumo que dissesse "3 de 3" significaria que a checagem de honestidade
  // não está funcionando — que é justamente o número que ele vai usar para julgar o app.
  // Cada passada carrega o próprio oficial: nada de casar por índice (o histórico guarda a mais
  // recente primeiro, e a ordem é o contrário da de gravação).
  const dentroEsperado = guardadas.filter(
    (p) => Math.abs(p.elapsedRefinedNs - p.oficialNs) <= p.incertezaLargadaNs + p.incertezaChegadaNs,
  ).length;
  checar(
    resumo.includes(`${dentroEsperado} de 3 dentro da incerteza declarada`),
    `o "dentro da incerteza" bate com a conta feita fora (${dentroEsperado} de 3)`,
  );

  // ---------------------------------------------------------------- o recorte
  console.log("\n### o recorte por prova");
  await aba("prova");
  await pagina.fill("#provaNome", "Outra prova");
  await pagina.click("#criarProva");
  await aba("historico");
  const soEsta = await pagina.textContent("#resumoConferencia");
  checar(/Nenhuma passada com tempo oficial nesta prova/.test(soEsta), "a prova nova começa zerada, sem herdar o viés de ontem");
  await pagina.selectOption("#escopoConferencia", "tudo");
  const tudo = await pagina.textContent("#resumoConferencia");
  checar(/3 passada\(s\)/.test(tudo), "\"todo o histórico\" traz as três de volta");

  // ---------------------------------------------------------------- recarregar
  console.log("\n### recarregar a página");
  await pagina.reload();
  await pagina.waitForSelector("#analisar", { state: "attached" });
  const larguraDepois = await pagina.inputValue("#largura");
  checar(larguraDepois === "21", `a largura da faixa sobreviveu ao recarregamento (${larguraDepois})`);
  await aba("historico");
  checar(
    (await pagina.textContent("#listaHistorico")).includes("vídeo"),
    "o histórico sobreviveu ao recarregamento",
  );

  // ---------------------------------------------------------------- arquivo que não é vídeo
  console.log("\n### arquivo que não é vídeo");
  await aba("passada");
  await pagina.setInputFiles("#arquivo", naoVideo);
  await pagina.waitForSelector("#aviso:not([hidden])", { timeout: 20_000 });
  const recado = await pagina.textContent("#aviso");
  console.log(`    aviso: ${recado}`);
  checar(!(await pagina.isVisible("#editor")), "a tela do editor fica escondida, sem quadro velho na frente");
  checar(!(await pagina.isVisible("#analisar")), "o botão Analisar nem fica ao alcance com o arquivo recusado");
  // E mesmo forçado por código, não sai número: `arquivo` foi zerado junto com as dimensões.
  await pagina.evaluate(() => { window.ultimaAnalise = null; document.getElementById("analisar").click(); });
  await pagina.waitForTimeout(1500);
  const analisou = await pagina.evaluate(() => window.ultimaAnalise != null);
  checar(!analisou, "forçar o clique em Analisar não produz tempo nenhum");

  checar(erros.length === 0, `sem erros de JavaScript${erros.length ? ": " + erros.join(" | ") : ""}`);
} finally {
  await navegador.close();
  servidor.close();
}
process.exit(falhou ? 1 : 0);
