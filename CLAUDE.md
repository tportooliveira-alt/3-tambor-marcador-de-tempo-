# Fotocélula Tambor — estado do projeto

Cronômetro de milésimos para a Prova de Três Tambores. O celular vira uma **fotocélula virtual**:
uma faixa vertical estreita da imagem é a linha de largada/chegada, e a passagem do cavalo produz o
tempo. Textos de interface e comentários em **pt-BR**; identificadores em inglês.

## O que existe, e por quê

**Uma especificação, quatro implementações.** O mesmo algoritmo em Python (referência), Kotlin
(Android), Swift (iOS) e TypeScript (web), conferidas pelos **mesmos 31 vetores** em
`shared/test-vectors/`. É isso que garante que o número não muda de aparelho para aparelho. Ao mexer
no núcleo, a ordem é sempre **Python → Kotlin → Swift → TypeScript**, regenerando os vetores.

| onde | o que é |
|---|---|
| `Tools/photocell_reference.py` | referência do algoritmo; o harness e o gerador de vetores importam daqui |
| `android/core/` | núcleo Kotlin (JVM puro) — **compila e testa nesta máquina** |
| `ios/Packages/PhotocellCore/` | núcleo Swift — só compila em macOS (CI) |
| `web/src/core/` | núcleo TypeScript — testa com `node --test` |
| `ios/App/` | app nativo: 240 FPS ao vivo, timestamp de hardware, sem gravar em disco |
| `android/app/` | app nativo: Camera2 alta velocidade, leitura da faixa por GPU |
| `web/` | **o que o usuário realmente usa hoje** — analisa vídeo de câmera lenta no navegador |

## O algoritmo, em uma frase

Cada pixel **integra a luz durante a exposição**, então um pixel parcialmente coberto vale
`V = B + (O−B)·f`, e `f` é linear no tempo. Ajustando `f` por mínimos quadrados ponderados sobre
dezenas de colunas obtém-se o instante do cruzamento **entre quadros** — daí ±0,4 ms com 240 FPS,
em vez dos ±2,08 ms da quantização. Cada gatilho sai com **qualidade** (0/1/2) e **incerteza
declarada**, e a regra é: nunca prometer precisão que não se tem.

## Comandos

```bash
# núcleo web + conferência (rápido)
cd web && npm ci && npm test

# núcleo Kotlin (a varredura de 1.920 cenários mora aqui)
cd android && ./gradlew -PskipApp=true :core:test --offline

# vetores compartilhados (depois de QUALQUER mudança no núcleo)
python3 Tools/gen_test_vectors.py

# cenários adversariais contra a referência Python
python3 Tools/scenario_harness.py '{"noise_sigma": 5}'
python3 Tools/test_cena.py            # o renderizador numpy tem de bater com a Scene

# vídeo sintético de prova + análise ponta a ponta no navegador
python3 Tools/gen_test_video.py --out /tmp/prova.mp4 --speed 2400 --object-px 200
cd web && npm run build && node test/e2e.mjs /tmp/prova.mp4

# cena de arena (cavalo, poeira, sombra, arquibancada)
python3 Tools/gen_test_video.py --out /tmp/arena.mp4 --silhueta cavalo --poeira 300 \
  --sombra --fundo-movel --skew-ns 3200000 --textura 18 --png-amostra /tmp/arena.png

# analisar um vídeo REAL com o app de verdade (converte H.264/HEVC sem perdas antes)
node Tools/analisar_video.mjs /tmp/passada.MOV --oficial 14,325 --varrer-linha
```

Testes do app web, todos em navegador de verdade: `e2e.mjs` (análise), `e2e-validacao.mjs`
(conferência com a fotocélula), `e2e-botoes.mjs` (**todos** os controles), `e2e-visor.mjs` (câmera
ao vivo, com dispositivo falso), `e2e-memoria.mjs` (vídeo grande), `e2e-empacotado.mjs` (as duas
páginas empacotadas, byte a byte).

## Armadilhas já pagas — não repetir

- **`String.replace` com o bundle como texto de substituição** (`web/build.mjs`): `$&` dentro do
  código minificado era expandido e cravava HTML no meio do JavaScript. A página abria e **nenhum
  botão funcionava**. Sempre usar função de substituição. `e2e-empacotado.mjs` guarda contra isso.
- **Ler o vídeo inteiro na memória**: `file.arrayBuffer()` gastava 2,3 bytes de RAM por byte de
  vídeo e matava a aba. O leitor lê em fatias de 4 MB e devolve as amostras (`releaseUsedSamples`).
- **Erro medido pelo texto da tela**: `formatElapsed` arredonda para o milésimo, então o "0,000 ms"
  era do arredondamento. Medir sempre em nanossegundos, pelo gancho `window.ultimaAnalise`.
- **Dois tetos de margem no estimador**: ruído é aleatório (a média corrige), textura é viés (não
  corrige). `fractionMarginMax = 0.40` e `textureMarginMax = 0.25` são separados de propósito.
- **`confirm()`/`prompt()` dentro do visualizador de Artifact** podem não abrir. Usar confirmação em
  dois toques e campos embutidos.
- **TypeScript "apagável"**: o Node roda com `--experimental-strip-types`. Proibido parâmetro-
  propriedade em construtor e `enum`.

## Ambiente

Linux sem Xcode e sem Android SDK. `download.swift.org` e `dl.google.com` bloqueados, além de
YouTube e Google em geral. O Chromium do Playwright está em
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome` e **não decodifica H.264/HEVC** — por isso os
testes usam VP9 em MP4 e `Tools/analisar_video.mjs` converte antes. O `ffmpeg` do `imageio_ffmpeg`
decodifica os codecs do iPhone.

Branch de trabalho: `claude/ios-sports-timing-system-65t7ng`. Página publicada em
`https://claude.ai/code/artifact/9c0abeaf-00cf-4892-a990-239933088060`.

## Em aberto

1. **O usuário só tem iPhone** (sem Mac, sem programa pago da Apple), então o app nativo não instala
   nele. A versão web é a única que roda no aparelho que ele tem.
2. **GitHub Pages**: `.github/workflows/pages.yml` está pronto. Falta o repositório virar público
   (varredura de segredos já feita: limpa) e ligar Pages em Settings → Pages → Source: GitHub
   Actions. Aí a página instala na tela de início e **abre sem sinal**.
3. **Nunca foi medida uma passada real.** O passo que vale mais que qualquer refatoração: um vídeo
   de verdade com o tempo da fotocélula oficial ao lado. A tela de conferência já está pronta para
   receber e acumular (viés, erro médio, quantos couberam na incerteza, quebra por qualidade).
4. **Metal no iOS** foi pedido e recusado com números: a ROI tem 1.400 a 10.000 pixels, custa
   dezenas de µs na CPU contra 50-200 µs só de despacho na GPU, num orçamento de 4.166 µs por
   quadro. O app já mostra `custo/quadro µs` no painel — é esse número que decide, no aparelho.
5. `web/src/app.ts` tem 934 linhas e acumula tela, estado e persistência. Quebrar em módulos só
   depois de os testes de botão estarem consolidados — não às vésperas de uma prova.
