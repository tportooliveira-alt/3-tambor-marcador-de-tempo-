/**
 * Teste ponta a ponta da CONFERÊNCIA: analisa o vídeo sintético, digita como "tempo oficial" a
 * verdade da simulação e confere que o app calcula o erro certo, guarda e resume.
 *
 *   node test/e2e-validacao.mjs [video.mp4]
 *
 * Vale como prova dupla: além de exercitar o campo novo, ele confirma que a conta do erro está
 * certa — aqui a "fotocélula" é a verdade da simulação, que conhecemos ao nanossegundo.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
const video = process.argv[2] ?? "/tmp/prova-sintetica.mp4";
const verdade = JSON.parse(readFileSync(video.replace(/\.\w+$/, ".json"), "utf8"));

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const servidor = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  if (rel === "favicon.ico") return void res.writeHead(200, { "content-type": "image/x-icon" }).end();
  try {
    const corpo = readFileSync(path.join(dist, rel));
    res.writeHead(200, { "content-type": TIPOS[path.extname(rel)] ?? "application/octet-stream" });
    res.end(corpo);
  } catch {
    res.writeHead(404).end("não encontrado");
  }
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const porta = servidor.address().port;

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const navegador = await chromium.launch({ executablePath: CHROMIUM });
const pagina = await navegador.newPage();
const erros = [];
pagina.on("pageerror", (e) => erros.push(String(e)));
pagina.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) erros.push(m.text());
});

let falhou = false;
const checar = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`);
  if (!ok) falhou = true;
};

try {
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#analisar", { state: "attached" });
  await pagina.setInputFiles("#arquivo", video);
  await pagina.waitForSelector("#editor:not([hidden])", { timeout: 60_000 });
  await pagina.waitForFunction(() => (document.getElementById("info-video")?.textContent ?? "").includes("·"), null, {
    timeout: 60_000,
  });
  await pagina.click("#analisar");
  await pagina.waitForSelector("#resultado:not([hidden])", { timeout: 300_000 });

  // "tempo da fotocélula" = a verdade da simulação, digitada como o usuário digitaria
  const verdadeS = verdade.elapsedNs / 1e9;
  const digitado = verdadeS.toFixed(3).replace(".", ",");
  await pagina.fill("#tempoOficial", digitado);
  const textoErro = (await pagina.textContent("#erroOficial")).trim();
  console.log(`    digitado "${digitado}" → "${textoErro}"`);
  checar(/[+−]\d+,\d ms/.test(textoErro), "o cartão mostrou a diferença com sinal");
  checar(textoErro.includes("dentro"), `o erro coube na incerteza declarada (${textoErro})`);

  // o número tem de bater com a conta feita fora do app
  const cru = await pagina.evaluate(() => window.ultimaAnalise?.run?.elapsedRefinedNs ?? null);
  const esperadoMs = (cru - verdade.elapsedNs) / 1e6;
  const mostradoMs = Number(/([+−]\d+,\d) ms/.exec(textoErro)[1].replace("−", "-").replace(",", "."));
  checar(Math.abs(mostradoMs - esperadoMs) <= 0.05, `a diferença mostrada bate com a conta (${mostradoMs} vs ${esperadoMs.toFixed(2)})`);

  // digitar lixo não pode quebrar nada
  await pagina.fill("#tempoOficial", "abc");
  checar((await pagina.textContent("#erroOficial")).includes("não entendi"), "tempo inválido é recusado sem quebrar a tela");
  await pagina.fill("#tempoOficial", digitado);

  // mexer nos tambores repinta o cartão: o tempo oficial tem de sobreviver
  await pagina.click("#maisTambor");
  checar((await pagina.inputValue("#tempoOficial")) === digitado, "o tempo oficial sobrevive à repintura do cartão");
  await pagina.click("#menosTambor");

  await pagina.click("#salvarPassada");
  await pagina.click('#abas button[data-aba="historico"]');
  await pagina.waitForSelector("#cartaoConferencia:not([hidden])", { timeout: 10_000 });
  const resumo = (await pagina.textContent("#resumoConferencia")).replace(/\s+/g, " ").trim();
  console.log(`    resumo: ${resumo}`);
  checar(resumo.includes("1 passada(s) com tempo oficial"), "o resumo contou a passada");
  checar(resumo.includes("1 de 1 dentro da incerteza declarada"), "o resumo mostrou a honestidade da incerteza");
  checar((await pagina.textContent("#listaHistorico")).includes("oficial"), "o item do histórico mostra o oficial e o erro");

  // o texto colável (o caminho que funciona dentro do visualizador, onde o download é bloqueado)
  await pagina.click("#copiarConferencia");
  await pagina.waitForSelector(".modal textarea", { timeout: 5000 });
  const texto = await pagina.inputValue(".modal textarea");
  checar(texto.includes("CONFERÊNCIA CONTRA A CRONOMETRAGEM OFICIAL"), "a tabela colável foi gerada");
  checar(texto.includes("oficial;refinado;bruto;erro_ms"), "a tabela tem o cabeçalho das colunas");

  checar(erros.length === 0, `sem erros de JavaScript${erros.length ? ": " + erros.join(" | ") : ""}`);
} finally {
  await navegador.close();
  servidor.close();
}

process.exit(falhou ? 1 : 0);
