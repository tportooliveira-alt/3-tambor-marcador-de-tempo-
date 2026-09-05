// Service worker: guarda o app para abrir SEM SINAL — na arena não há rede, e não pode haver.
// Nada de dados de prova passa por aqui: o histórico vive no armazenamento do navegador.
const CACHE = "fotocelula-v35dmue";
const ARQUIVOS = ["./", "index.html", "app.js", "estilo.css", "manifest.webmanifest", "icone-180.png", "icone-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * A CASCA do app (página, código, estilo) responde DO CACHE na hora e busca a versão nova ATRÁS,
 * para a próxima abertura. Ícones e manifesto seguem cache primeiro, sem busca de fundo.
 *
 * Por que não é rede-primeiro: o pior caso da arena não é "sem rede" (aí o `fetch` falha na hora),
 * é a rede que aceita a conexão e não responde. Medido: com a casca vindo da rede primeiro, sinal
 * pendurado custava 5,1 s até a página abrir — dois tempos de espera em série. Do cache, abre em
 * 0,2 s em qualquer condição.
 *
 * E não se volta ao defeito antigo, porque quem traz a versão nova é o CARIMBO no nome do cache:
 * com o `sw.js` mudando a cada publicação, o navegador instala o novo, o `install` rebusca tudo da
 * rede e o `activate` apaga o cache velho. Antes o carimbo nunca era aplicado e o nome do cache era
 * o mesmo para sempre — era ISSO que prendia o usuário, não a estratégia de busca.
 */
const CASCA = ["index.html", "app.js", "estilo.css"];
const ESPERA_REDE_MS = 2500;

function daRede(req) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("rede lenta")), ESPERA_REDE_MS);
    fetch(req).then(
      (r) => {
        clearTimeout(t);
        res(r);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // NÃO tocar em blob: / data: — é por aí que o vídeo escolhido pelo usuário é lido; interceptar
  // essas URLs quebra a leitura do arquivo (o endereço é local à página, não existe rede por trás)
  const url = new URL(e.request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const arquivo = url.pathname.split("/").pop() || "index.html";
  const ehCasca = e.request.mode === "navigate" || CASCA.includes(arquivo);

  if (ehCasca) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        const rede = daRede(e.request).then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
          return res;
        });
        if (hit) {
          // Responde já e atualiza atrás: a falha da rede aqui não pode virar erro na página.
          rede.catch(() => {});
          return hit;
        }
        return rede.catch(() => caches.match("index.html"));
      }),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ??
        fetch(e.request)
          .then((res) => {
            const copia = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copia));
            return res;
          })
          .catch(() => caches.match("index.html")),
    ),
  );
});
