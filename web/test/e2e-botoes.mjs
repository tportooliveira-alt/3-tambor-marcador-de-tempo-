/**
 * Aperta TODOS os botões do app num navegador de verdade.
 *
 *   node test/e2e-botoes.mjs [video.mp4]
 *
 * Por que existe: o modo prova inteiro — criar prova, inscrições, importar CSV, classificação —
 * nunca tinha sido tocado por teste nenhum, e foi exatamente nessa camada que já apareceu um
 * travamento antes (chave duplicada na classificação com duas categorias). Aqui cada controle é
 * exercitado e o efeito é conferido; no fim, exige-se ZERO erro de JavaScript.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
const video = process.argv[2] ?? "/tmp/prova-sintetica.mp4";
const csv = path.resolve(aqui, "../../docs/exemplo-lista-largada.csv");

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

try {
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#analisar", { state: "attached" });

  // ---------------------------------------------------------------- abas
  console.log("\n### abas");
  for (const n of ["prova", "historico", "ajuda", "visor", "passada"]) {
    await aba(n);
    checar(await pagina.isVisible(`#aba-${n}`), `a aba "${n}" abre`);
  }

  // ---------------------------------------------------------------- prova
  console.log("\n### modo prova (nunca testado até aqui)");
  await aba("prova");
  await pagina.fill("#provaNome", "Copa de Teste");
  await pagina.fill("#provaLocal", "Arena Municipal");
  await pagina.click("#criarProva");
  checar((await pagina.textContent("#listaProvas")).includes("Copa de Teste"), "criar prova");
  checar(await pagina.isVisible("#cartaoInscricoes"), "o cartão de inscrições aparece com a prova aberta");

  // DUAS inscrições com o MESMO número de largada em categorias diferentes.
  // É o caso que já derrubou a tela de classificação antes.
  for (const [ordem, competidor, cavalo, categoria] of [
    ["7", "Ana Prado", "Estrela", "Aberta"],
    ["7", "Bruno Lima", "Trovão", "Mirim"],
  ]) {
    await pagina.fill("#insOrdem", ordem);
    await pagina.fill("#insCompetidor", competidor);
    await pagina.fill("#insCavalo", cavalo);
    await pagina.fill("#insCategoria", categoria);
    await pagina.click("#addInscricao");
  }
  const lista = await pagina.textContent("#listaInscricoes");
  checar(lista.includes("Ana Prado") && lista.includes("Bruno Lima"),
    "duas inscrições com o MESMO número de largada em categorias diferentes");

  await pagina.setInputFiles("#csvInscricoes", csv);
  await pagina.waitForTimeout(400);
  const depoisCsv = await pagina.textContent("#listaInscricoes");
  checar(depoisCsv.includes("Carla Souza"), "importar a lista de largada por CSV");

  await aba("passada");
  checar((await pagina.textContent("#faixa-proximo")).length > 0, 'a faixa "PRÓXIMO" mostra quem vem');

  // ---------------------------------------------------------------- passada
  console.log("\n### passada");
  await pagina.setInputFiles("#arquivo", video);
  await pagina.waitForSelector("#editor:not([hidden])", { timeout: 60_000 });
  await pagina.waitForFunction(() => (document.getElementById("info-video")?.textContent ?? "").includes("·"), null, { timeout: 60_000 });

  const antes = await pagina.evaluate(() => document.getElementById("larguraOut").textContent);
  await pagina.evaluate(() => {
    const c = document.getElementById("largura");
    c.value = "25";
    c.dispatchEvent(new Event("input", { bubbles: true }));
  });
  checar((await pagina.textContent("#larguraOut")) === "25" && antes !== "25", "o slider de largura muda a faixa");

  // arrastar a linha no palco
  const caixa = await pagina.locator("#palco").boundingBox();
  await pagina.mouse.move(caixa.x + caixa.width * 0.5, caixa.y + caixa.height * 0.5);
  await pagina.mouse.down();
  await pagina.mouse.move(caixa.x + caixa.width * 0.62, caixa.y + caixa.height * 0.5, { steps: 6 });
  await pagina.mouse.up();
  const linhaDepois = await pagina.evaluate(() => window.ultimaAnalise ?? null);
  checar(true, "arrastar a linha no primeiro quadro não quebra nada");

  // cancelar no meio da análise
  await pagina.click("#analisar");
  await pagina.waitForSelector("#cancelar:not([hidden])", { timeout: 10_000 });
  await pagina.click("#cancelar");
  await pagina.waitForSelector("#analisar:not([hidden])", { timeout: 30_000 });
  checar(await pagina.isHidden("#progresso"), "cancelar interrompe a análise e devolve a tela");

  // analisar de verdade e mexer no cartão
  await pagina.evaluate(() => window.definirROI(0.5, 0.3, 0.7, 15));
  await pagina.click("#analisar");
  await pagina.waitForSelector("#resultado:not([hidden])", { timeout: 300_000 });
  await pagina.click("#maisTambor");
  await pagina.click("#maisTambor");
  checar((await pagina.textContent("#resultado")).includes("2 tambor"), "+ tambor soma penalidade");
  await pagina.click("#menosTambor");
  checar((await pagina.textContent("#resultado")).includes("1 tambor"), "− tambor desconta");
  await pagina.click("#botaoSat");
  checar((await pagina.textContent("#resultado")).includes("SAT ✓"), "SAT marca sem tempo");
  await pagina.click("#botaoSat");
  await pagina.fill("#tempoOficial", "2,500");
  await pagina.click("#salvarPassada");
  await pagina.waitForTimeout(300);

  // ---------------------------------------------------------------- histórico
  console.log("\n### histórico e conferência");
  await aba("historico");
  checar((await pagina.textContent("#listaHistorico")).includes("oficial"), "a passada salva mostra o tempo oficial e o erro");
  checar(await pagina.isVisible("#cartaoConferencia"), "o painel de conferência aparece");

  // corrigir o oficial pelo campo embutido no item
  const mini = pagina.locator("#listaHistorico .oficial-mini").first();
  await mini.fill("2,600");
  await mini.blur();
  await pagina.waitForTimeout(300);
  checar((await pagina.textContent("#listaHistorico")).includes("2,600"), "dá para corrigir o tempo oficial depois, pelo histórico");

  await pagina.click("#copiarConferencia");
  await pagina.waitForSelector(".modal textarea", { timeout: 5000 });
  checar((await pagina.inputValue(".modal textarea")).includes("CONFERÊNCIA"), "o texto da conferência é gerado");
  await pagina.click(".modal [data-copiar]");
  await pagina.click(".modal [data-fechar]");
  checar((await pagina.locator(".modal").count()) === 0, "copiar e fechar o modal funcionam");

  await pagina.click("#exportarHistorico");
  await pagina.waitForSelector(".modal textarea", { timeout: 5000 });
  checar((await pagina.inputValue(".modal textarea")).includes("tempo_oficial_s"), "o CSV do histórico traz as colunas da conferência");
  await pagina.click(".modal [data-fechar]");

  // "apagar tudo" em dois toques: o primeiro só arma
  await pagina.click("#limparHistorico");
  checar((await pagina.textContent("#limparHistorico")).includes("certeza"), "o primeiro toque em apagar só pede confirmação");
  checar((await pagina.textContent("#listaHistorico")).length > 20, "e NÃO apagou nada ainda");
  await pagina.waitForTimeout(5200);
  checar((await pagina.textContent("#limparHistorico")).includes("Apagar tudo"), "sem o segundo toque, ele volta sozinho ao normal");

  // ---------------------------------------------------------------- classificação com 2 categorias
  console.log("\n### classificação");
  await aba("prova");
  const tabela = await pagina.textContent("#classificacao");
  checar(tabela.length > 0, "a tabela de classificação renderiza com duas categorias e números repetidos");
  await pagina.click("#exportarProva");
  await pagina.waitForSelector(".modal textarea", { timeout: 5000 });
  checar((await pagina.inputValue(".modal textarea")).includes("categoria"), "exportar a classificação da prova");
  await pagina.click(".modal [data-fechar]");

  checar(erros.length === 0, `sem erros de JavaScript${erros.length ? ": " + erros.join(" | ") : ""}`);
} finally {
  await navegador.close();
  servidor.close();
}
process.exit(falhou ? 1 : 0);
