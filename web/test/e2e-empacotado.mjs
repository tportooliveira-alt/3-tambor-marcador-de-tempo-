/**
 * Confere as versões EMPACOTADAS (arquivo único e página para publicar), que é o que o usuário
 * realmente abre — o `dist/` com arquivos separados é só o formato de desenvolvimento.
 *
 *   node test/e2e-empacotado.mjs [video.mp4]
 *
 * Por que existe: o empacotador embutia o bundle passando o texto como argumento de substituição do
 * `String.replace`, que interpreta `$&`, `` $` ``, `$'` e `$1` dentro do texto. O minificador batiza
 * variáveis de `$`, então uma linha como `at>$&&($=at)` virava
 * `at><script src="app.js"></script>&(...)` no meio do JavaScript: a página abria bonita e NENHUM
 * botão funcionava ("Unexpected token '<'"). Os testes rodavam em `dist/`, onde o JavaScript é um
 * arquivo à parte, e não viam nada. Agora a identidade do bundle é conferida byte a byte e as duas
 * páginas empacotadas rodam a prova inteira num navegador.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(aqui, "..");
const video = process.argv[2] ?? "/tmp/prova-sintetica.mp4";

let falhou = false;
const checar = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FALHA"} — ${msg}`);
  if (!ok) falhou = true;
};

// As duas páginas empacotadas, recém-construídas — cada uma comparada com O SEU bundle.
// Os dois modos escrevem no MESMO `dist/app-single.js`, então ler o bundle depois de construir as
// duas comparava a página de um modo com o bundle do outro: passava só enquanto os dois saíssem
// idênticos por acaso, e falhava sem explicação quando não saíam.
execFileSync("node", [path.join(raiz, "build.mjs"), "--single"], { cwd: raiz, stdio: "ignore" });
const bundle = readFileSync(path.join(raiz, "dist/app-single.js"), "utf8");
const unico = readFileSync(path.join(raiz, "fotocelula-tambor.html"), "utf8");

execFileSync("node", [path.join(raiz, "build.mjs"), "--artifact"], { cwd: raiz, stdio: "ignore" });
const bundleArtifact = readFileSync(path.join(raiz, "dist/app-single.js"), "utf8");
const artifact = readFileSync(path.join(raiz, "fotocelula-tambor.artifact.html"), "utf8");

// 1) o JavaScript embutido tem de ser IDÊNTICO ao bundle — nada pode ser reescrito na inclusão
const embutido = /<script type="module">\n([\s\S]*?)\n<\/script>/.exec(unico)?.[1] ?? "";
checar(embutido === bundle, `o arquivo único embute o bundle sem alterar um byte (${embutido.length} de ${bundle.length})`);
checar(artifact.includes(bundleArtifact), "a página para publicar embute o bundle sem alterar um byte");
for (const [nome, pagina] of [["arquivo único", unico], ["página para publicar", artifact]]) {
  checar(!pagina.includes('src="app.js"'), `${nome}: nenhum resto de <script src> dentro do código`);
}

// 2) as duas páginas rodam a prova inteira num navegador de verdade
for (const [nome, pagina, esqueleto] of [
  ["arquivo único", unico, false],
  ["página para publicar", artifact, true],
]) {
  const dir = path.join("/tmp", `empacotado-${nome.replace(/\W+/g, "-")}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // o visualizador do Artifact fornece o esqueleto da página; aqui ele é reproduzido igual
  const corpo = esqueleto
    ? `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>:root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>` +
      `</head><body>\n${pagina}\n</body></html>`
    : pagina;
  writeFileSync(path.join(dir, "index.html"), corpo);
  console.log(`\n--- ${nome} ---`);
  try {
    execFileSync("node", [path.join(aqui, "e2e.mjs"), video], {
      cwd: raiz,
      env: { ...process.env, DIST: dir },
      stdio: "inherit",
    });
    checar(true, `${nome}: a prova inteira rodou`);
  } catch {
    checar(false, `${nome}: a prova NÃO rodou`);
  }
}

process.exit(falhou ? 1 : 0);
