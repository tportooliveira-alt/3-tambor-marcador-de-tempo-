/**
 * Teste de memória da leitura de vídeo: prova que o pico de memória da página NÃO acompanha o
 * tamanho do arquivo.
 *
 *   node test/e2e-memoria.mjs <video-pequeno.mp4> <video-grande.mp4>
 *
 * Por que existe: o leitor antigo fazia `file.arrayBuffer()` — o arquivo inteiro num bloco só — e
 * ainda guardava todas as amostras comprimidas antes de decodificar. Com o clipe de 26 MB do teste
 * ponta a ponta isso passava despercebido; com um vídeo de verdade (centenas de MB, que é o que a
 * câmera lenta gera) o Safari do iPhone mata a aba em silêncio: "carrega e para". O conserto lê em
 * fatias e decodifica na hora, e é isso que este teste mede.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import http from "node:http";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const dist = process.env.DIST ?? path.resolve(aqui, "../dist");
// Os dois arquivos têm de ter a MESMA resolução e o MESMO número de quadros, mudando só o tamanho
// em bytes — senão a conta "memória por byte de arquivo" está medindo resolução, que é outra coisa
// (um quadro 960×540 decodificado ocupa 9× um 320×180, e isso não tem nada a ver com o leitor):
//   python3 Tools/gen_test_video.py --out /tmp/mem-leve.mp4 --width 960 --height 540 --fps 240 \
//     --duration-s 4.2 --start-s 1.0 --finish-s 3.5 --speed 2400 --object-px 200 --noise 0
//   (o mesmo com --noise 6 gera o pesado: ruído não comprime, e o arquivo passa de 1 MB para 225 MB)
const pequeno = process.argv[2] ?? "/tmp/mem-leve.mp4";
const grande = process.argv[3] ?? "/tmp/prova-grande.mp4";

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
    res.writeHead(200, { "content-type": "image/x-icon" }).end();
    return;
  }
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

let falhou = false;
const checar = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`);
  if (!ok) falhou = true;
};
const MB = (n) => (n / 1048576).toFixed(0);

/**
 * Memória de TODO o navegador, lida do sistema operacional.
 *
 * O `JSHeapUsedSize` sozinho não serve aqui: o conteúdo de um ArrayBuffer mora FORA do heap de
 * JavaScript, e era justamente um ArrayBuffer com o arquivo inteiro que derrubava a página. Somando
 * o RSS dos processos do Chromium a conta aparece inteira.
 */
function rssNavegador() {
  let total = 0;
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes("chrome")) continue;
      const st = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
      total += Number(st[1]) * 4096; // páginas residentes
    } catch {
      /* processo saiu no meio da leitura */
    }
  }
  return total;
}

/** Analisa um vídeo e devolve o pico de memória JS observado durante a análise. */
async function medir(video) {
  const pagina = await navegador.newPage();
  const cdp = await pagina.context().newCDPSession(pagina);
  await cdp.send("Performance.enable");
  const heap = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  };
  try {
    await pagina.goto(`http://127.0.0.1:${porta}/index.html`);
    await pagina.waitForSelector("#analisar", { state: "attached" });

    // A régua zero é ANTES de o arquivo ser escolhido, e nesta MESMA página. Antes ela era tirada
    // depois de o vídeo estar aberto — o que escondia justamente o custo de mantê-lo aberto — e a
    // comparação final usava os picos ABSOLUTOS de duas medições diferentes, então a memória que o
    // navegador não devolve entre uma e outra entrava na conta como se fosse do arquivo. Daí o
    // número pular de 2,6 para 7,6 entre execuções do mesmo código.
    await new Promise((r) => setTimeout(r, 800));
    const base = await heap();
    const baseRss = rssNavegador();

    await pagina.setInputFiles("#arquivo", video);
    await pagina.waitForSelector("#editor:not([hidden])", { timeout: 60_000 });
    // Quanto custa só TER o arquivo aberto, antes de qualquer análise.
    let aberturaRss = 0;
    for (let i = 0; i < 6; i++) {
      aberturaRss = Math.max(aberturaRss, rssNavegador() - baseRss);
      await new Promise((r) => setTimeout(r, 250));
    }
    let pico = base;
    let picoRss = baseRss;
    let vivo = true;
    // amostragem enquanto a análise roda; o pico é o que interessa
    const relogio = (async () => {
      while (vivo) {
        pico = Math.max(pico, await heap());
        picoRss = Math.max(picoRss, rssNavegador());
        await new Promise((r) => setTimeout(r, 150));
      }
    })();

    // o texto de progresso é o que o usuário vê: conferir que ele existe e fala em MB
    const textos = new Set();
    const olho = setInterval(() => {
      pagina.textContent("#progressoTexto").then((t) => textos.add(t)).catch(() => {});
    }, 120);

    await pagina.click("#analisar");
    await pagina.waitForSelector("#resultado:not([hidden])", { timeout: 600_000 });
    clearInterval(olho);
    vivo = false;
    await relogio;

    const res = await pagina.evaluate(() => window.ultimaAnalise ?? null);
    return { base, pico, baseRss, picoRss, aberturaRss, res, progresso: [...textos].filter(Boolean) };
  } finally {
    await pagina.close();
  }
}

try {
  const tamP = statSync(pequeno).size;
  const tamG = statSync(grande).size;
  console.log(`pequeno: ${MB(tamP)} MB · grande: ${MB(tamG)} MB\n`);
  checar(tamG > tamP * 2, `o arquivo grande é mesmo bem maior (${MB(tamG)} MB contra ${MB(tamP)} MB)`);

  const p = await medir(pequeno);
  console.log(`pequeno — heap ${MB(p.pico)} MB · navegador +${MB(p.picoRss - p.baseRss)} MB (abrir: +${MB(p.aberturaRss)} MB) · ${p.res?.reader.received} quadros`);
  const g = await medir(grande);
  console.log(`grande  — heap ${MB(g.pico)} MB · navegador +${MB(g.picoRss - g.baseRss)} MB (abrir: +${MB(g.aberturaRss)} MB) · ${g.res?.reader.received} quadros`);

  console.log(`\nprogresso mostrado ao usuário (arquivo grande):`);
  for (const t of g.progresso.slice(0, 6)) console.log(`    "${t}"`);

  // O teste de verdade: quanto o pico cresceu por byte a mais de arquivo. Se o leitor guardasse o
  // arquivo, esse número passaria de 1. As faixas guardadas também crescem (≈5 KB por quadro num
  // clipe 960×540), então a margem aceita é folgada — mas muito longe de 1.
  const crescimento = (g.pico - p.pico) / (tamG - tamP);
  const crescimentoRss = (g.picoRss - g.baseRss - (p.picoRss - p.baseRss)) / (tamG - tamP);
  const crescimentoAbertura = (g.aberturaRss - p.aberturaRss) / (tamG - tamP);
  console.log(`\ncrescimento por byte de arquivo — heap ${crescimento.toFixed(3)} · navegador ${crescimentoRss.toFixed(3)} · só abrir ${crescimentoAbertura.toFixed(3)}`);
  checar(crescimento < 0.35, `o heap de JavaScript não acompanha o tamanho do arquivo (${crescimento.toFixed(3)} < 0,35)`);
  checar(crescimentoRss < 0.35, `a memória do navegador não acompanha o tamanho do arquivo (${crescimentoRss.toFixed(3)} < 0,35)`);
  // Manter o arquivo aberto num `<video>` custava 0,9 byte por byte de arquivo — 258 MB residentes
  // num clipe de 225 MB, antes de a análise começar. É por isso que o editor solta o elemento e o
  // recria só quando alguém percorre o clipe.
  checar(crescimentoAbertura < 0.35, `abrir o arquivo não o traz inteiro para a memória (${crescimentoAbertura.toFixed(3)} < 0,35)`);
  checar(g.pico < 400 * 1048576, `heap abaixo de 400 MB no arquivo grande (${MB(g.pico)} MB)`);
  checar(
    g.progresso.some((t) => /Lendo o vídeo… \d+ MB de \d+ MB/.test(t)),
    "a tela mostrou o progresso de leitura em MB",
  );
  checar(
    g.res?.reader.received > 0 && g.res.reader.received >= g.res.reader.expected * 0.98,
    `o arquivo grande foi lido inteiro (${g.res?.reader.received}/${g.res?.reader.expected})`,
  );
} finally {
  await navegador.close();
  servidor.close();
}

process.exit(falhou ? 1 : 0);
