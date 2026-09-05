// Empacota o app numa pasta estática (dist/): sem servidor, sem back-end — é só um site.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const raiz = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(raiz, "dist");
const servir = process.argv.includes("--serve");

mkdirSync(dist, { recursive: true });
cpSync(path.join(raiz, "public"), dist, { recursive: true });

const umArquivo = process.argv.includes("--single");
// --artifact: mesma página, mas só o conteúdo (sem doctype/html/head/body), para publicar dentro
// de um visualizador que fornece o esqueleto da página.
const paraArtifact = process.argv.includes("--artifact");

const opcoes = {
  entryPoints: [path.join(raiz, "src/app.ts")],
  bundle: true,
  format: "esm",
  target: ["es2022", "safari16"],
  minify: !servir,
  sourcemap: servir,
  outfile: path.join(dist, "app.js"),
  logLevel: "info",
  define: {
    ARQUIVO_UNICO: String(umArquivo || paraArtifact),
    // Carimbo e contagem vêm DA CONSTRUÇÃO, não escritos à mão na tela. O texto da Ajuda já ficou
    // desatualizado uma vez ("30 vetores" quando eram 31), e número errado na tela do usuário é o
    // mesmo defeito de sempre: o app afirmando o que não confere.
    VERSAO: JSON.stringify(carimbo()),
    VETORES: JSON.stringify(String(contarVetores())),
  },
};

/** Data da construção + hash curto do conteúdo: é o que o usuário lê para saber se está na versão nova. */
function carimbo() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

function contarVetores() {
  try {
    const dir = path.join(raiz, "../shared/test-vectors");
    return readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").length;
  } catch {
    return 0;
  }
}

/**
 * Carimba o nome do cache do service worker com o conteúdo do que vai ao ar.
 *
 * DOIS defeitos moravam aqui, e juntos eles prendiam o usuário na primeira versão que ele tivesse
 * carregado, para sempre:
 *
 * 1. `cpSync(public → dist)` roda no topo deste arquivo, em TODA invocação. O fluxo de publicação
 *    faz `npm run build` (que carimbava) e logo depois `build.mjs --single` — que copiava o
 *    `sw.js` cru por cima e NÃO carimbava. O que foi publicado tinha o literal `__VERSAO__`:
 *    nome de cache idêntico em toda versão, `sw.js` byte a byte igual, navegador não vê
 *    atualização nenhuma, e o `install` (que é quem rebusca os arquivos) nunca mais roda.
 * 2. O carimbo saía só do bundle. Mudar apenas o HTML ou o CSS não mudava o hash.
 *
 * Agora entra tudo o que a página serve, e é chamado ao fim de TODOS os caminhos.
 */
function carimbarSW() {
  const sw = path.join(dist, "sw.js");
  const pedaco = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const hash = createHashLike(
    pedaco(path.join(dist, "app.js")) +
      pedaco(path.join(raiz, "public/index.html")) +
      pedaco(path.join(raiz, "public/estilo.css")) +
      pedaco(path.join(raiz, "public/manifest.webmanifest")),
  );
  writeFileSync(sw, readFileSync(sw, "utf8").replace("__VERSAO__", hash));
  return hash;
}

function createHashLike(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h << 5) + h + texto.charCodeAt(i)) | 0;
  return `v${(h >>> 0).toString(36)}`;
}

if (servir) {
  const ctx = await context(opcoes);
  await ctx.watch();
  const { host, port } = await ctx.serve({ servedir: dist, port: 5173 });
  console.log(`servindo em http://${host}:${port}`);
} else if (umArquivo || paraArtifact) {
  // Versão de ARQUIVO ÚNICO: tudo embutido (CSS, JS, ícone) numa página só, para abrir onde não há
  // como servir uma pasta — inclusive dentro de outro app.
  opcoes.outfile = path.join(dist, "app-single.js");
  await build(opcoes);
  const js = readFileSync(opcoes.outfile, "utf8");
  const css = readFileSync(path.join(raiz, "public/estilo.css"), "utf8");
  const icone = readFileSync(path.join(raiz, "public/icone-180.png")).toString("base64");
  let html = readFileSync(path.join(raiz, "public/index.html"), "utf8");
  // ATENÇÃO: o texto de substituição TEM de entrar por função.
  // Passar o conteúdo como string faz o String.replace interpretar `$&`, `$\``, `$'` e `$1` dentro
  // dele. O minificador batiza variáveis de `$`, então uma linha como `at>$&&($=at)` virava
  // `at><script src="app.js"></script>&(...)` no meio do bundle e a página inteira morria com
  // "Unexpected token '<'" — nenhum botão respondia. Uma função devolve o texto literal.
  const literal = (texto) => () => texto;
  html = html
    .replace('<link rel="manifest" href="manifest.webmanifest">', "")
    .replace(/<link rel="apple-touch-icon"[^>]*>/, literal(`<link rel="apple-touch-icon" href="data:image/png;base64,${icone}">`))
    .replace(/<link rel="icon"[^>]*>/, literal(`<link rel="icon" href="data:image/png;base64,${icone}">`))
    .replace('<link rel="stylesheet" href="estilo.css">', literal(`<style>\n${css}\n</style>`))
    .replace('<script type="module" src="app.js"></script>', literal(`<script type="module">\n${js}\n</script>`));
  let saida = path.join(raiz, "fotocelula-tambor.html");
  if (paraArtifact) {
    const titulo = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "Fotocélula Tambor";
    const estilo = /<style>[\s\S]*?<\/style>/.exec(html)?.[0] ?? "";
    const corpo = /<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    html = `<title>${titulo}</title>\n${estilo}\n${corpo.trim()}\n`;
    saida = path.join(raiz, "fotocelula-tambor.artifact.html");
  }
  writeFileSync(saida, html);
  // O `cpSync` do topo repôs o `sw.js` cru: carimbar aqui também, senão o que sobra em `dist/`
  // depois deste caminho é o literal.
  const marca = carimbarSW();
  console.log(`${paraArtifact ? "página para publicar" : "arquivo único"}: ${saida} (${(html.length / 1024).toFixed(0)} KB) · sw ${marca}`);
} else {
  await build(opcoes);
  console.log(`dist/ pronto · sw ${carimbarSW()}`);
}
