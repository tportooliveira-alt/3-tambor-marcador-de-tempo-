/**
 * Teste do visor ao vivo, com câmera FALSA alimentada por um vídeo de verdade.
 *
 *   node test/e2e-visor.mjs [video.y4m]
 *
 * O Chromium aceita `--use-file-for-fake-video-capture` com um arquivo .y4m e o entrega como se
 * fosse a câmera. É o único jeito de exercitar `getUserMedia` sem hardware — e sem isso o visor
 * seria a única tela do app que ninguém nunca executou.
 *
 * O arquivo tem uma PROVA de verdade dentro (dois cruzamentos), então o cronômetro ao vivo é
 * exercitado de ponta a ponta — armar, disparar, fechar o tempo, digitar o oficial e salvar:
 *
 *   python3 Tools/gen_test_video.py --out /tmp/visor-fake.mp4 --width 640 --height 360 --fps 30 \
 *     --duration-s 8 --start-s 2.5 --finish-s 5.5 --speed 600 --object-px 60 \
 *     --exposure-frac 1.0 --noise 2 > /tmp/visor-fake.json
 *   ffmpeg -y -i /tmp/visor-fake.mp4 -pix_fmt yuv420p /tmp/visor-fake.y4m
 *
 * O Chromium repete o arquivo em laço, e ele começa e termina com a pista vazia — a emenda não
 * produz diferença nenhuma, então não dispara nada. Os cruzamentos ficam a 2,5 s e 5,5 s, de modo
 * que dois disparos consecutivos distam 3,0 s (largada→chegada) ou 5,0 s (chegada→largada seguinte);
 * qual dos dois sai depende de onde o laço estava quando o cronômetro foi armado.
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

  // ARMAR ANTES DE A CALIBRAGEM TERMINAR — o defeito relatado em campo: a tela trocava o botão e
  // mostrava 0.000, mas por dentro `armar()` tinha desistido em silêncio, e o cronômetro nunca
  // disparava. Agora o pedido fica de pé e a tela diz o que falta.
  checar(await pagina.isVisible("#visorTempo"), "o cronômetro aparece assim que a câmera abre");
  await pagina.click("#armarVisor");
  checar(await pagina.isVisible("#visorPendente"), "armar cedo avisa que ainda está medindo a cena");
  // O relógio continua na tela (era ele que sumia e virava "cadê o cronômetro?"), mas a linha de
  // baixo tem de dizer que NÃO está armado — mostrar 0.000 sem essa frase seria fingir de novo.
  checar(
    /não armado/.test(await pagina.textContent("#visorFase")),
    `enquanto não arma, a tela diz isso (${(await pagina.textContent("#visorFase")).trim()})`,
  );
  console.log(`    esperando: ${(await pagina.textContent("#visorEstado")).trim()}`);

  // a calibragem tem de terminar sozinha e o limiar aparecer no texto de estado
  await pagina.waitForFunction(
    () => /limiar/.test(document.getElementById("visorEstado")?.textContent ?? ""),
    null,
    { timeout: 30_000 },
  );
  await pagina.waitForSelector("#visorTempo:not([hidden])", { timeout: 10_000 });
  checar(!(await pagina.isVisible("#visorPendente")), "o cronômetro armou sozinho quando a cena foi medida");
  await pagina.click("#desarmarVisor");
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

  // O overlay TEM de cobrir o retângulo do vídeo, não o do container. Se o vídeo for limitado pela
  // altura (celular deitado), o container fica mais largo — e um overlay esticado sobre ele
  // desenharia a linha vermelha numa coluna diferente da que o app mede. Seria uma mira mentirosa.
  const caixas = await pagina.evaluate(() => {
    const v = document.getElementById("visorVideo").getBoundingClientRect();
    const o = document.getElementById("visorOverlay").getBoundingClientRect();
    const p = document.getElementById("visorSinal").getBoundingClientRect();
    const palco = document.getElementById("palcoVisor").getBoundingClientRect();
    return {
      dx: Math.abs(v.left - o.left), dy: Math.abs(v.top - o.top),
      dw: Math.abs(v.width - o.width), dh: Math.abs(v.height - o.height),
      painelAcima: p.bottom <= palco.top + 1,
    };
  });
  checar(
    caixas.dx <= 1 && caixas.dy <= 1 && caixas.dw <= 1 && caixas.dh <= 1,
    `a linha desenhada cai sobre a faixa medida (desvio ${caixas.dx.toFixed(1)}/${caixas.dy.toFixed(1)} px, tamanho ${caixas.dw.toFixed(1)}/${caixas.dh.toFixed(1)} px)`,
  );
  checar(caixas.painelAcima, "o cronômetro e os botões ficam ACIMA da imagem");

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
  checar(/\d+ quadros por segundo/.test(fase), "o cronômetro mostra a taxa medida, sem cravar precisão");
  checar(await pagina.isVisible("#desarmarVisor"), "o botão de parar apareceu");

  // --- a passada ao vivo, de ponta a ponta ---------------------------------------------------
  // Rearmar com o "ensaio" ligado: sem ele a chegada só arma 10 s depois da largada (que é o certo
  // numa prova de verdade, onde poeira e rabo de cavalo passam na linha logo depois).
  await pagina.click("#desarmarVisor");
  await pagina.check("#visorEnsaio");
  await pagina.click("#armarVisor");
  checar(!(await pagina.isVisible("#resultadoVisor")), "armar limpou o cartão anterior");

  await pagina.waitForSelector("#resultadoVisor:not([hidden])", { timeout: 60_000 });
  const medido = await pagina.evaluate(() => {
    const el = document.getElementById("resultadoVisor");
    return {
      tempo: el.querySelector(".tempo")?.textContent?.trim(),
      selo: el.querySelector(".selo")?.textContent?.trim(),
      detalhe: el.querySelector(".detalhe")?.textContent?.replace(/\s+/g, " ").trim(),
    };
  });
  console.log(`    ao vivo: ${medido.tempo} · ${medido.selo}`);
  console.log(`    ${medido.detalhe}`);
  checar(/^\d+\.\d{3}$/.test(medido.tempo ?? ""), `o tempo ao vivo fechou (${medido.tempo})`);
  checar(/qualidade \d · ±\d+[.,]\d+ ms/.test(medido.selo ?? ""), `o cartão declara qualidade e incerteza (${medido.selo})`);

  // Os dois intervalos fisicamente possíveis no clipe em laço. Não é frouxidão: qualquer outro
  // valor significaria disparo em coisa que não é o objeto.
  const segundos = Number(medido.tempo);
  const alvo = [3.0, 5.0].reduce((a, b) => (Math.abs(b - segundos) < Math.abs(a - segundos) ? b : a));
  const erroMs = (segundos - alvo) * 1000;
  console.log(`    verdade mais próxima ${alvo.toFixed(3)} s · erro ${erroMs.toFixed(1)} ms`);
  checar(Math.abs(erroMs) < 60, `o tempo ao vivo bate com a verdade (erro ${erroMs.toFixed(1)} ms)`);

  // digitar o oficial e salvar: é isso que faz a passada ao vivo entrar na conferência
  await pagina.fill("#visorOficial", alvo.toFixed(3).replace(".", ","));
  const veredicto = await pagina.textContent("#visorErroOficial");
  console.log(`    conferência: ${veredicto}`);
  // Exigir "dentro", não só que a conta apareça: o intervalo declarado TEM de conter o erro real —
  // é a mesma regra que o teste do caminho de arquivo cobra, e é o princípio do projeto.
  checar(/dentro do ±/.test(veredicto ?? ""), `a incerteza declarada cobre o erro real (${veredicto})`);

  await pagina.click("#visorSalvar");
  await pagina.click('#abas button[data-aba="historico"]');
  const item = await pagina.textContent("#listaHistorico");
  checar(/ao vivo/.test(item ?? ""), "a passada aparece no histórico marcada como ao vivo");
  const guardada = await pagina.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("fotocelula.dados.v1") ?? "{}");
    return (d.passadas ?? []).map((p) => p.origem);
  });
  checar(guardada.length === 1 && guardada[0] === "ao-vivo", `gravada com origem "ao-vivo" (${guardada.join(",")})`);
  // Voltar para a aba fecha o ciclo: a câmera foi desligada ao sair, então tem de reabrir aqui
  // para que a verificação seguinte (sair desliga) signifique alguma coisa.
  await pagina.click('#abas button[data-aba="visor"]');
  await pagina.click("#abrirVisor");
  await pagina.waitForFunction(() => document.getElementById("visorVideo")?.srcObject !== null, null, { timeout: 15_000 });

  // --- a mesma prova, agora no modo "na mão" ---------------------------------------------------
  // Sem tripé o limiar sobe (o tremor produz diferença em toda a faixa), e a passada tem de ficar
  // num caminho SEPARADO: misturada com as do tripé, estragaria a comparação que se quer fazer.
  await pagina.check("#visorMao");
  await pagina.click("#armarVisor");
  await pagina.waitForSelector("#resultadoVisor:not([hidden])", { timeout: 120_000 });
  const quemMao = await pagina.evaluate(
    () => document.getElementById("resultadoVisor")?.querySelector(".quem")?.textContent ?? "",
  );
  checar(/na mão/.test(quemMao), `o cartão avisa que foi na mão (${quemMao.trim()})`);
  await pagina.fill("#visorOficial", "3,000");
  await pagina.click("#visorSalvar");
  const origens = await pagina.evaluate(() =>
    (JSON.parse(localStorage.getItem("fotocelula.dados.v1") ?? "{}").passadas ?? []).map((p) => p.origem),
  );
  checar(
    origens.includes("ao-vivo-mao") && origens.includes("ao-vivo"),
    `tripé e na mão ficam em caminhos separados (${origens.join(", ")})`,
  );

  // --- gravar o vídeo da passada ---------------------------------------------------------------
  await pagina.click("#gravarVisor");
  checar(
    /gravando/.test(await pagina.textContent("#gravarEstado")),
    "o botão de gravar entra em gravação e mostra o tempo",
  );
  await pagina.waitForTimeout(2500);
  await pagina.click("#gravarVisor");
  await pagina.waitForSelector("#videoSalvo:not([hidden])", { timeout: 15_000 });
  const video = await pagina.evaluate(() => {
    const a = document.getElementById("baixarVideo");
    return { href: (a?.getAttribute("href") ?? "").slice(0, 5), nome: a?.getAttribute("download") ?? "" };
  });
  checar(video.href === "blob:", "o vídeo gravado vira um arquivo para baixar");
  checar(/^passada-.*\.(webm|mp4)$/.test(video.nome), `com nome de arquivo (${video.nome})`);
  await pagina.click("#descartarVideo");
  checar(!(await pagina.isVisible("#videoSalvo")), "e dá para descartar");

  // --- disparar sozinho: sem tocar em nada, ele tem de armar quando a cena for medida ----------
  await pagina.uncheck("#visorMao");
  await pagina.check("#visorAuto");
  await pagina.waitForFunction(
    () => /armado — esperando/.test(document.getElementById("visorFase")?.textContent ?? ""),
    null,
    { timeout: 40_000 },
  );
  checar(true, "no modo sozinho ele arma sem ninguém tocar em nada");

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
