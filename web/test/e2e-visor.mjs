/**
 * Teste do visor ao vivo, com câmera FALSA alimentada por um vídeo de verdade.
 *
 *   node test/e2e-visor.mjs [video.y4m]
 *
 * O Chromium aceita `--use-file-for-fake-video-capture` com um arquivo .y4m e o entrega como se
 * fosse a câmera. É o único jeito de exercitar `getUserMedia` sem hardware — e sem isso o visor
 * seria a única tela do app que ninguém nunca executou.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
const y4m = process.argv[2] ?? "/tmp/visor-fake.y4m";
if (!existsSync(y4m)) {
  console.error(`falta o vídeo falso: ${y4m}`);
  process.exit(2);
}

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
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
});
const contexto = await navegador.newContext({ permissions: ["camera"] });
const pagina = await contexto.newPage();
const erros = [];
pagina.on("pageerror", (e) => erros.push(String(e)));
pagina.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) erros.push(m.text()); });

let falhou = false;
const checar = (ok, msg) => { console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`); if (!ok) falhou = true; };

try {
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#abrirVisor", { state: "attached" });

  await pagina.click('#abas button[data-aba="visor"]');
  checar(await pagina.isVisible("#abrirVisor"), "a aba Mirar abriu com o botão da câmera");

  await pagina.click("#abrirVisor");
  await pagina.waitForSelector("#palcoVisor:not([hidden])", { timeout: 15_000 });
  await pagina.waitForFunction(() => (document.getElementById("visorVideo")?.videoWidth ?? 0) > 0, null, { timeout: 20_000 });
  const dim = await pagina.evaluate(() => {
    const v = document.getElementById("visorVideo");
    return { w: v.videoWidth, h: v.videoHeight, tocando: !v.paused };
  });
  console.log(`    câmera: ${dim.w}×${dim.h}, tocando=${dim.tocando}`);
  checar(dim.w > 0 && dim.h > 0, `o vídeo da câmera está entregando quadros (${dim.w}×${dim.h})`);

  // a calibragem tem de terminar sozinha e o limiar aparecer no texto de estado
  await pagina.waitForFunction(
    () => /limiar/.test(document.getElementById("visorEstado")?.textContent ?? ""),
    null,
    { timeout: 30_000 },
  );
  const estado = await pagina.textContent("#visorEstado");
  console.log(`    estado: ${estado}`);
  checar(/quadros por segundo/.test(estado), "o visor mostra a taxa real medida");
  checar(/limiar/.test(estado), "a calibragem terminou sozinha e o limiar apareceu");

  // o overlay tem de estar desenhado (canvas com pixels não transparentes)
  const pintado = await pagina.evaluate(() => {
    const c = document.getElementById("visorOverlay");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  checar(pintado > 100, `a linha e a banda estão desenhadas sobre a câmera (${pintado} pixels)`);

  // armar o cronômetro
  await pagina.click("#armarVisor");
  await pagina.waitForSelector("#visorTempo:not([hidden])", { timeout: 5000 });
  await pagina.waitForFunction(
    () => (document.getElementById("visorFase")?.textContent ?? "").length > 0,
    null,
    { timeout: 15_000 },
  );
  const fase = await pagina.textContent("#visorFase");
  console.log(`    fase: ${fase}`);
  checar(/precisão ao vivo ±\d+ ms/.test(fase), "o cronômetro declara a precisão ao vivo, sem esconder");
  checar(await pagina.isVisible("#desarmarVisor"), "o botão de parar apareceu");

  // sair da aba TEM de desligar a câmera (aparelho quente estraga a medição depois)
  await pagina.click('#abas button[data-aba="passada"]');
  await pagina.waitForTimeout(500);
  const desligou = await pagina.evaluate(() => {
    const v = document.getElementById("visorVideo");
    return v.srcObject === null;
  });
  checar(desligou, "sair da aba desligou a câmera");

  checar(erros.length === 0, `sem erros de JavaScript${erros.length ? ": " + erros.join(" | ") : ""}`);
} finally {
  await navegador.close();
  servidor.close();
}
process.exit(falhou ? 1 : 0);
