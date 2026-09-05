/**
 * Teste ponta a ponta da versão web: gera uma prova sintética em vídeo (240 FPS), abre o app REAL
 * num navegador e confere o tempo medido contra a verdade da simulação.
 *
 *   node test/e2e.mjs [caminho-do-video.webm]
 *
 * É o teste que o app nativo nunca teve: aqui o pipeline inteiro roda — decodificação do vídeo,
 * leitura da faixa, differencer, calibração, estimador sub-quadro e máquina de estados.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
const video = process.argv[2] ?? "/tmp/prova-sintetica.webm";
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
  if (rel === "favicon.ico") {
    // o visualizador real fornece o ícone; aqui basta não devolver 404
    res.writeHead(200, { "content-type": "image/x-icon" }).end();
    return;
  }
  try {
    const corpo = readFileSync(path.join(dist, rel));
    res.writeHead(200, { "content-type": TIPOS[path.extname(rel)] ?? "application/octet-stream" });
    res.end(corpo);
  } catch {
    if (rel !== "favicon.ico") console.log(`    (404 pedido: /${rel})`);
    res.writeHead(404).end("não encontrado");
  }
});
await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
const porta = servidor.address().port;

// o Chromium do ambiente é fixo (a versão do pacote npm pode pedir outro build)
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const navegador = await chromium.launch({ executablePath: CHROMIUM });
const pagina = await navegador.newPage();
const erros = [];
pagina.on("pageerror", (e) => erros.push(String(e)));
pagina.on("console", (m) => {
  // o favicon é do servidor de teste, não do app
  if (m.type() === "error" && !m.text().includes("favicon")) erros.push(m.text());
});
// blob: falha quando o próprio app solta o vídeo (removeAttribute + load) — é o cancelamento
// esperado, não um defeito. Só interessa recurso do site que não carregou.
pagina.on("requestfailed", (r) => {
  if (r.url().startsWith("http") && !r.url().endsWith("favicon.ico")) erros.push(`recurso não carregou: ${r.url()}`);
});

let falhou = false;
const checar = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`);
  if (!ok) falhou = true;
};

try {
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#analisar", { state: "attached" });

  // escolher o vídeo da prova (o mesmo que o usuário faz nas Fotos)
  await pagina.setInputFiles("#arquivo", video);
  await pagina.waitForSelector("#editor:not([hidden])", { timeout: 30_000 });
  // a linha de informação só fica pronta depois de ler o cabeçalho do arquivo
  await pagina.waitForFunction(() => (document.getElementById("info-video")?.textContent ?? "").includes("·"), null, {
    timeout: 60_000,
  });
  const info = await pagina.textContent("#info-video");
  checar(info.includes(`${verdade.width}×${verdade.height}`), `primeiro quadro exibido (${info.split("—")[0].trim()})`);

  const avisoTaxa = await pagina.evaluate(() => {
    const el = document.getElementById("aviso-taxa");
    return el && !el.hidden ? { classe: el.className, texto: el.innerText.replace(/\s+/g, " ").trim() } : null;
  });
  if (avisoTaxa) console.log(`    aviso da taxa [${avisoTaxa.classe}]: ${avisoTaxa.texto}`);

  await pagina.click("#analisar");
  await pagina.waitForSelector("#resultado:not([hidden])", { timeout: 300_000 });
  const texto = await pagina.textContent("#resultado");

  const cru = await pagina.evaluate(() => {
    const r = window.ultimaAnalise;
    if (!r) return null;
    return {
      threshold: r.threshold, lag: r.lag, fps: r.measuredFps, faltando: r.missedFrames,
      lidos: r.reader.received, esperados: r.reader.expected, maiorBuraco: r.reader.worstGapPeriods,
      inicio: r.run && { q: r.run.start.quality, unc: r.run.start.uncertaintyNs, interior: r.run.start.interiorCount, tex: r.run.start.texturedColumns, raw: r.run.start.rawTsNs, ref: r.run.start.refinedTsNs },
      fim: r.run && { q: r.run.finish.quality, unc: r.run.finish.uncertaintyNs, interior: r.run.finish.interiorCount, tex: r.run.finish.texturedColumns, raw: r.run.finish.rawTsNs, ref: r.run.finish.refinedTsNs },
      drops: r.run && r.run.drops, degradada: r.run && r.run.degraded,
    };
  });
  console.log("--- números crus ---\n" + JSON.stringify(cru, null, 1) + "\n");

  const medido = await pagina.evaluate(() => {
    const t = document.querySelector("#resultado .tempo")?.textContent?.trim() ?? "";
    const detalhe = document.querySelector("#resultado .detalhe")?.textContent ?? "";
    const selo = document.querySelector("#resultado .selo")?.textContent ?? "";
    return { t, detalhe, selo, html: document.querySelector("#resultado").innerText };
  });
  console.log("\n--- cartão do app ---\n" + medido.html + "\n---------------------\n");

  const refinado = /refinado ([\d.]+)/.exec(medido.detalhe);
  checar(refinado !== null, "o app mostrou o tempo refinado");
  // O ERRO É MEDIDO EM NANOSSEGUNDOS, não no texto da tela: `formatElapsed` arredonda para o
  // milésimo, então comparar o texto com a verdade dava "0,000 ms" por construção — um zero de
  // arredondamento, não de exatidão. O número cru vem do gancho `window.ultimaAnalise`.
  if (cru?.inicio && cru?.fim) {
    const medidoNs = cru.fim.ref - cru.inicio.ref;
    const erroMs = (medidoNs - verdade.elapsedNs) / 1e6;
    const uncMs = (cru.inicio.unc + cru.fim.unc) / 1e6;
    console.log(
      `    verdade ${(verdade.elapsedNs / 1e9).toFixed(6)} s · medido ${(medidoNs / 1e9).toFixed(6)} s` +
        ` · erro ${erroMs.toFixed(3)} ms · incerteza declarada ±${uncMs.toFixed(2)} ms`,
    );
    checar(Math.abs(erroMs) < 0.5, `erro do ΔT abaixo de 0,5 ms (${erroMs.toFixed(3)} ms)`);
    // A incerteza declarada tem de COBRIR o erro real: um app que erra mais do que promete é pior
    // que um que erra e avisa.
    checar(Math.abs(erroMs) <= uncMs, `o erro real cabe na incerteza declarada (${Math.abs(erroMs).toFixed(3)} ≤ ${uncMs.toFixed(2)} ms)`);
  } else {
    checar(false, "os números crus da análise não chegaram");
  }

  const quadros = /(\d+) quadros lidos/.exec(medido.detalhe);
  checar(quadros !== null, "o app informou quantos quadros leu");
  if (quadros) {
    const lidos = Number(quadros[1]);
    console.log(`    ${lidos} quadros lidos de ${verdade.frames} do arquivo`);
    checar(lidos >= verdade.frames * 0.98, `o navegador entregou ≥98% dos quadros (${lidos}/${verdade.frames})`);
  }
  checar(!medido.detalhe.includes("não entregues"), "nenhum quadro perdido pelo navegador");
  checar(medido.selo.includes("qualidade 2"), `qualidade 2 declarada (${medido.selo.trim()})`);
  checar(erros.length === 0, `sem erros de JavaScript${erros.length ? ": " + erros.join(" | ") : ""}`);
} finally {
  await navegador.close();
  servidor.close();
}

process.exit(falhou ? 1 : 0);
