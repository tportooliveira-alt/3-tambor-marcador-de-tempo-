/**
 * Analisa um vídeo REAL de passada com o app de verdade, e compara com a cronometragem oficial.
 *
 *   node Tools/analisar_video.mjs <video> [opções]
 *
 *     --oficial 14,325      tempo da fotocélula, para calcular o erro
 *     --linha 0.5           posição da linha (fração da largura)
 *     --banda 0.20,0.80     topo e base da banda (fração da altura)
 *     --largura 15          largura da faixa em pixels do vídeo
 *     --varrer-linha        repete a análise em várias posições de linha e compara
 *     --png saida.png       grava o primeiro quadro com a linha desenhada
 *     --manter              não apaga o arquivo convertido (para reanalisar rápido)
 *
 * Por que este atalho existe: o iPhone trava ao exportar clipes longos de câmera lenta para a
 * página, então o caminho prático é o usuário subir o vídeo no Drive e a análise acontecer aqui —
 * onde, de quebra, dá para ver todos os diagnósticos, testar posições de linha e comparar com o
 * tempo oficial sem ele ficar mexendo no celular.
 *
 * Nada de algoritmo novo: isto abre o app publicado num Chromium e lê o resultado. O número que sai
 * daqui é o mesmo que sairia na mão dele.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, "..");
const web = path.join(raiz, "web");
const dist = path.join(web, "dist");

// ---------------------------------------------------------------- argumentos
const argv = process.argv.slice(2);
const entrada = argv.find((a) => !a.startsWith("--"));
if (!entrada || !existsSync(entrada)) {
  console.error("uso: node Tools/analisar_video.mjs <video> [--oficial 14,325] [--linha 0.5] [--banda 0.2,0.8] [--largura 15] [--varrer-linha] [--png arq.png]");
  process.exit(2);
}
const opt = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : padrao;
};
const temFlag = (nome) => argv.includes(`--${nome}`);

const oficialTexto = opt("oficial", "");
const linha = Number(opt("linha", "0.5"));
const [bandaTopo, bandaBase] = opt("banda", "0.20,0.80").split(",").map(Number);
const largura = Number(opt("largura", "15"));
const pngSaida = opt("png", "");
const varrer = temFlag("varrer-linha");
const manter = temFlag("manter");

const FFMPEG = (() => {
  try {
    return execFileSync("python3", ["-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "ffmpeg";
  }
})();

const MB = (n) => (n / 1048576).toFixed(1);

// ---------------------------------------------------------------- 1. o que é este arquivo
/**
 * O veredicto sobre o arquivo, ANTES de qualquer análise. Não existe `ffprobe` neste ambiente, então
 * a informação sai do próprio ffmpeg: a linha do stream traz codec, resolução e taxa, e a contagem
 * exata de quadros vem de uma decodificação para o vazio.
 */
function inspecionar(arquivo) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", arquivo, "-f", "null", "-"], { encoding: "utf8" });
  const saida = r.stderr ?? "";
  const stream = /Stream #\d+:\d+.*?: Video: ([^\s,]+).*?, (\d+)x(\d+).*?, ([\d.]+) fps/s.exec(saida);
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(saida);
  const quadros = [...saida.matchAll(/frame=\s*(\d+)/g)].pop();
  return {
    codec: stream?.[1] ?? "?",
    largura: Number(stream?.[2] ?? 0),
    altura: Number(stream?.[3] ?? 0),
    fps: Number(stream?.[4] ?? 0),
    duracaoS: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    quadros: quadros ? Number(quadros[1]) : 0,
    bytes: statSync(arquivo).size,
  };
}

/**
 * O Chromium deste ambiente não decodifica H.264 nem HEVC — que são exatamente os codecs do iPhone.
 * A conversão é SEM PERDAS e com `-fps_mode passthrough`: nenhum quadro criado, nenhum descartado,
 * nenhum carimbo de tempo mexido. Recompressão com perda inventaria níveis de cinza e mentiria o
 * milésimo, porque o estimador sub-quadro lê a rampa de exposição pixel a pixel.
 */
function converter(arquivo, info) {
  const saida = path.join("/tmp", `analise-${path.basename(arquivo).replace(/\.\w+$/, "")}.mp4`);
  if (existsSync(saida) && manter) {
    console.log(`  (reaproveitando ${saida})`);
    return saida;
  }
  console.log(`  convertendo sem perdas para VP9 (o Chromium daqui não abre ${info.codec})…`);
  const t0 = Date.now();
  const r = spawnSync(
    FFMPEG,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", arquivo,
     "-an", "-fps_mode", "passthrough",
     "-c:v", "libvpx-vp9", "-lossless", "1", "-cpu-used", "5", "-row-mt", "1", "-threads", "4",
     "-pix_fmt", "yuv420p", saida],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    console.error(r.stderr?.slice(-2000));
    throw new Error("a conversão falhou");
  }
  const depois = inspecionar(saida);
  console.log(`  convertido em ${((Date.now() - t0) / 1000).toFixed(0)} s · ${depois.quadros} quadros (${MB(depois.bytes)} MB)`);
  if (depois.quadros !== info.quadros) {
    throw new Error(`a conversão mudou a contagem de quadros (${info.quadros} → ${depois.quadros}); análise abortada`);
  }
  return saida;
}

// ---------------------------------------------------------------- 2. rodar o app de verdade
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

async function abrirApp() {
  const { chromium } = await import(path.join(web, "node_modules/playwright/index.mjs"));
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
  const navegador = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  });
  const pagina = await navegador.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(String(e)));
  await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
  await pagina.waitForSelector("#analisar", { state: "attached" });
  return { navegador, pagina, servidor, erros };
}

async function analisar(pagina, video, roi, primeiraVez) {
  if (primeiraVez) {
    await pagina.setInputFiles("#arquivo", video);
    await pagina.waitForSelector("#editor:not([hidden])", { timeout: 120_000 });
    await pagina.waitForFunction(
      () => (document.getElementById("info-video")?.textContent ?? "").includes("·"),
      null,
      { timeout: 120_000 },
    );
    console.log(`  ${(await pagina.textContent("#info-video")).split("—")[0].trim()}`);
    const banner = await pagina.evaluate(() => {
      const el = document.getElementById("aviso-taxa");
      return el && !el.hidden ? el.innerText.replace(/\s+/g, " ").trim() : null;
    });
    if (banner) console.log(`  AVISO DA TAXA: ${banner}`);
  }
  await pagina.evaluate((r) => window.definirROI(r.l, r.t, r.b, r.w), roi);
  await pagina.click("#analisar");
  await pagina.waitForSelector("#resultado:not([hidden])", { timeout: 900_000 });
  return pagina.evaluate(() => window.ultimaAnalise ?? null);
}

// ---------------------------------------------------------------- 3. relatar
const fmt = (ns) => (ns / 1e9).toFixed(4);
const ms = (ns) => (ns / 1e6).toFixed(2);

function relatar(res, rotulo) {
  if (!res?.run) {
    console.log(`${rotulo}  NÃO MEDIU — ${res?.problem ?? "sem cruzamento"} (parou em ${res?.finalState})`);
    console.log(`          ${res?.reader?.received ?? 0} quadros · ${(res?.measuredFps ?? 0).toFixed(1)} fps`);
    return null;
  }
  const r = res.run;
  const q = Math.min(r.start.quality, r.finish.quality);
  const unc = r.start.uncertaintyNs + r.finish.uncertaintyNs;
  console.log(
    `${rotulo}  refinado ${fmt(r.elapsedRefinedNs)} s · bruto ${fmt(r.elapsedRawNs)} s · qualidade ${q} · ±${ms(unc)} ms` +
      `${r.degraded ? " · DEGRADADA" : ""}`,
  );
  console.log(
    `          largada q${r.start.quality} ±${ms(r.start.uncertaintyNs)} ms (${r.start.interiorCount} col., ${r.start.texturedColumns} texturizadas)` +
      ` · chegada q${r.finish.quality} ±${ms(r.finish.uncertaintyNs)} ms (${r.finish.interiorCount} col., ${r.finish.texturedColumns} texturizadas)`,
  );
  console.log(
    `          ${res.reader.received}/${res.reader.expected} quadros · ${res.measuredFps.toFixed(1)} fps · leitura por ${res.leitura}` +
      `${res.codec ? ` · ${res.codec}` : ""}` +
      `${res.calibracao ? ` · calibrado em ${res.calibracao.inicioS.toFixed(1)}–${res.calibracao.fimS.toFixed(1)} s` : ""}`,
  );
  return { refinadoNs: r.elapsedRefinedNs, brutoNs: r.elapsedRawNs, qualidade: q, incertezaNs: unc };
}

// ---------------------------------------------------------------- principal
const info = inspecionar(entrada);
console.log(`\nARQUIVO  ${path.basename(entrada)}`);
console.log(`  ${info.codec} · ${info.largura}×${info.altura} · ${info.quadros} quadros em ${info.duracaoS.toFixed(2)} s · ${info.fps} fps · ${MB(info.bytes)} MB`);
const fpsReal = info.duracaoS > 0 ? info.quadros / info.duracaoS : 0;
console.log(`  taxa real pelo cabeçalho: ${fpsReal.toFixed(1)} quadros por segundo`);
if (fpsReal >= 200) console.log("  → CÂMERA LENTA PRESERVADA: o arquivo tem os quadros originais.");
else if (fpsReal >= 100) console.log("  → taxa intermediária: mede, mas com o dobro da incerteza de 240.");
else console.log("  → ATENÇÃO: taxa de vídeo comum. O iPhone provavelmente renderizou a câmera lenta antes de entregar; cada gatilho vale ±17 ms.");

const precisaConverter = !/vp8|vp9|av1/i.test(info.codec);
const video = precisaConverter ? converter(entrada, info) : entrada;

if (!existsSync(dist)) execFileSync("node", [path.join(web, "build.mjs")], { cwd: web, stdio: "inherit" });

const { navegador, pagina, servidor, erros } = await abrirApp();
let saiu = 0;
try {
  const posicoes = varrer
    ? Array.from({ length: 16 }, (_, i) => Number((0.35 + i * 0.02).toFixed(2)))
    : [linha];
  let primeira = true;
  const resultados = [];
  for (const l of posicoes) {
    const res = await analisar(pagina, video, { l, t: bandaTopo, b: bandaBase, w: largura }, primeira);
    primeira = false;
    const r = relatar(res, `\nLINHA ${l.toFixed(2)}`);
    if (r) resultados.push({ linha: l, ...r });
  }

  if (varrer && resultados.length > 0) {
    console.log("\nRESUMO DA VARREDURA (melhor = maior qualidade, menor incerteza)");
    for (const r of [...resultados].sort((a, b) => b.qualidade - a.qualidade || a.incertezaNs - b.incertezaNs)) {
      console.log(`  linha ${r.linha.toFixed(2)}  q${r.qualidade}  ±${ms(r.incertezaNs)} ms  ${fmt(r.refinadoNs)} s`);
    }
  }

  const oficial = oficialTexto ? oficialTexto.replace(",", ".") : "";
  if (oficial && resultados.length > 0) {
    const oficialNs = Math.round(Number(oficial) * 1e9);
    console.log(`\nCONTRA A CRONOMETRAGEM OFICIAL (${oficialTexto} s)`);
    for (const r of resultados) {
      const erro = r.refinadoNs - oficialNs;
      const dentro = Math.abs(erro) <= r.incertezaNs;
      console.log(
        `  linha ${r.linha.toFixed(2)}  erro ${erro >= 0 ? "+" : "−"}${Math.abs(erro / 1e6).toFixed(2)} ms` +
          ` (${erro >= 0 ? "o app mediu mais" : "o app mediu menos"}) · ${dentro ? "dentro" : "FORA"} do ±${ms(r.incertezaNs)} ms declarado`,
      );
    }
  }

  if (pngSaida) {
    await pagina.locator("#palco").screenshot({ path: pngSaida });
    console.log(`\nprimeiro quadro com a linha: ${pngSaida}`);
  }
  if (erros.length) {
    console.log(`\nERROS DE JAVASCRIPT: ${erros.join(" | ")}`);
    saiu = 1;
  }
} finally {
  await navegador.close();
  servidor.close();
  if (precisaConverter && !manter) rmSync(video, { force: true });
}
process.exit(saiu);
