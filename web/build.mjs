// Empacota o app numa pasta estática (dist/): sem servidor, sem back-end — é só um site.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const raiz = path.dirname(new URL(import.meta.url).pathname);
const dist = path.join(raiz, "dist");
const servir = process.argv.includes("--serve");

mkdirSync(dist, { recursive: true });
cpSync(path.join(raiz, "public"), dist, { recursive: true });

const opcoes = {
  entryPoints: [path.join(raiz, "src/app.ts")],
  bundle: true,
  format: "esm",
  target: ["es2022", "safari16"],
  minify: !servir,
  sourcemap: servir,
  outfile: path.join(dist, "app.js"),
  logLevel: "info",
};

// versão do cache do service worker = conteúdo do bundle (troca sozinha a cada build)
function carimbarSW(bundle) {
  const sw = path.join(dist, "sw.js");
  const hash = createHashLike(bundle);
  writeFileSync(sw, readFileSync(sw, "utf8").replace("__VERSAO__", hash));
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
} else {
  await build(opcoes);
  carimbarSW(readFileSync(path.join(dist, "app.js"), "utf8"));
  console.log("dist/ pronto");
}
