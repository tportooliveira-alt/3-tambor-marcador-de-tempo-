// Service worker: guarda o app para abrir SEM SINAL — na arena não há rede, e não pode haver.
// Nada de dados de prova passa por aqui: o histórico vive no armazenamento do navegador.
const CACHE = "fotocelula-__VERSAO__";
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
 * A CASCA do app (página, código, estilo) vem da REDE primeiro, com o cache como reserva; o resto
 * (ícones, manifesto) vem do cache primeiro.
 *
 * Antes era tudo cache primeiro, e isso, somado ao nome de cache que nunca mudava, prendia o
 * usuário na primeira versão que ele tivesse carregado — fechar e reabrir a aba não resolve, porque
 * quem responde é o service worker, não a rede. Agora, com sinal, ele sempre pega a versão nova; e
 * sem sinal (a arena) o `fetch` falha na hora e o cache responde, que é o que precisa acontecer.
 *
 * O tempo de espera existe para o sinal RUIM: sem ele, uma barra de sinal fraca deixaria a página
 * pendurada esperando a rede em vez de abrir do cache.
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
      daRede(e.request)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("index.html"))),
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
