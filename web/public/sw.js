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

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // NÃO tocar em blob: / data: — é por aí que o vídeo escolhido pelo usuário é lido; interceptar
  // essas URLs quebra a leitura do arquivo (o endereço é local à página, não existe rede por trás)
  const proto = new URL(e.request.url).protocol;
  if (proto !== "http:" && proto !== "https:") return;
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
