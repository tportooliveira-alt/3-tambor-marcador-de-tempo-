# Versão web — cronometrar analisando o vídeo em câmera lenta

Abre por um link, no navegador do celular, **sem instalar nada**. Você grava a passada no app
**Câmera** do iPhone em **câmera lenta (240 FPS)** e solta o arquivo aqui: o app lê o vídeo quadro a
quadro e devolve o tempo com milésimo, a qualidade e a incerteza — mais prova, lista de largada,
classificação e CSV.

O vídeo **não sai do aparelho**: toda a análise acontece no navegador.

## O que muda em relação ao app nativo

| | App nativo | Web (aqui) |
|---|---|---|
| Quando o tempo aparece | na hora, com bipe no cruzamento | segundos depois, ao soltar o vídeo |
| Precisão | milésimo | **o mesmo milésimo** |
| Instalar | precisa de um computador uma vez | nada: é um link |

A captura ao vivo continua sendo nativa porque o navegador não entrega 240 FPS, não deixa travar a
exposição e não dá o relógio do sensor. Ler um arquivo já gravado a 240 FPS não depende de nada disso.

## Como os quadros são lidos (e por que assim)

1. **Decodificador** (caminho principal): o arquivo é demultiplexado com `mp4box.js` e decodificado
   por **WebCodecs**. Entrega **todos** os quadros, com o carimbo de tempo do próprio arquivo, e roda
   mais rápido que a reprodução (medido: clipe de 4,2 s analisado em 6 s).
2. **Reprodução** (reserva): tocar devagar e pegar cada quadro apresentado
   (`requestVideoFrameCallback`). Funciona, mas o navegador **pula quadros** — medido aqui: ~3% de
   perda, o bastante para derrubar o refinamento perto do gatilho. Quando esse caminho é usado e
   faltam quadros, a passada sai marcada como **degradada**; nunca silenciosamente errada.

A exposição de cada quadro não vem no arquivo: o app assume `E = P` (a janela inteira) e **alarga a
incerteza** em vez de fingir que sabe.

## Núcleo: a quarta implementação da mesma especificação

`src/core/` é o porte TypeScript do mesmo núcleo do Python (referência), do Kotlin (Android) e do
Swift (iOS) — differencer da faixa, calibração de ruído, estimador sub-quadro, máquina de estados e
regra de classificação. Conferido pelos **mesmos 30 vetores compartilhados**:

```bash
npm test        # 30 vetores compartilhados + os testes da conferência
npm run build   # dist/ (site estático)
npm run dev     # servidor local em http://127.0.0.1:5173
```

## Calibragem automática

O app precisa de um trecho com a pista vazia para medir o quanto a cena treme sozinha — é o que separa
"cavalo passando" de "reflexo tremendo". Esse trecho **não precisa estar no começo do vídeo**: como o
clipe inteiro é lido antes de calcular, o app procura a janela mais parada em qualquer ponto (antes da
largada, entre a ida e a volta, ou depois da chegada) e calibra ali. O cartão de resultado informa
qual trecho foi usado.

Quando a cena nunca fica parada — celular na mão, tripé esbarrado —, o app diz isso em vez de calibrar
em cima do próprio movimento.

A calibragem é refeita a cada vídeo de propósito: ela mede *aquela* cena, naquela luz.

## Teste ponta a ponta (o que o app nativo nunca teve)

```bash
# passada normal, com a pista vazia no começo
python3 ../Tools/gen_test_video.py --out /tmp/prova.mp4 --speed 2400 --object-px 200
npm run build && node test/e2e.mjs /tmp/prova.mp4

# gravação "atrasada": o objeto já está cruzando quando o vídeo começa
python3 ../Tools/gen_test_video.py --out /tmp/tarde.mp4 --speed 2400 --object-px 200 \
  --start-s 0.12 --finish-s 2.7 --duration-s 3.4
node test/e2e.mjs /tmp/tarde.mp4
```

Gera uma prova sintética (a mesma física dos vetores: bordo em movimento, exposição integrada,
ruído, curva de tom) como vídeo de 240 FPS, abre o app **real** num Chromium e confere o tempo medido
contra a verdade da simulação. Última execução: **erro de −0,418 ms** na passada normal (qualidade 2,
incerteza declarada ±0,84 ms, 1008/1008 quadros) e **−0,419 ms** na gravação atrasada, com o app
calibrando sozinho no trecho parado depois da chegada.

O erro é medido **em nanossegundos**, pelo gancho `window.ultimaAnalise`, e não pelo texto da tela:
`formatElapsed` arredonda para o milésimo, então comparar o texto com a verdade dava "0,000 ms" por
construção — um zero de arredondamento, não de exatidão. O teste também exige que **a incerteza
declarada cubra o erro real**: um app que erra mais do que promete é pior que um que erra e avisa.

Limite conhecido deste ambiente: o Chromium disponível não decodifica H.264/HEVC, então o teste usa
VP9 em MP4. O contêiner é o mesmo do `.MOV` do iPhone (o demuxer é o mesmo caminho de código), mas a
decodificação dos codecs da Apple só se confirma no aparelho.

## Vídeo grande: por que ele cabe na memória

Câmera lenta a 240 FPS gera oito vezes mais imagem que um vídeo comum: um clipe de 20 s passa de
50 MB e um clipe longo chega a centenas. O leitor nunca tem o arquivo inteiro na memória:

1. as caixas do contêiner são mapeadas lendo **16 bytes de cada uma** — é assim que se acha o índice
   (`moov`) mesmo quando o iPhone o grava no fim do arquivo, sem ler o que está antes;
2. o índice (poucos kilobytes) vai para o `mp4box.js`, e só então os dados entram em **fatias de
   4 MB**;
3. cada fatia é decodificada na hora e devolvida (`releaseUsedSamples`). O que fica guardado é a
   faixa da ROI de cada quadro — cerca de **1 KB por quadro**, não o quadro inteiro.

O teste que garante isso compara o pico de memória do navegador entre um clipe pequeno e um grande:

```bash
python3 ../Tools/gen_test_video.py --out /tmp/longa.mp4 --speed 2400 --object-px 200 --duration-s 40
node test/e2e-memoria.mjs /tmp/prova.mp4 /tmp/longa.mp4
```

Medido nesta máquina, comparando o clipe de 25 MB com um de **242 MB na mesma resolução** (40 s,
9600 quadros):

| | leitor anterior | leitor em fatias |
|---|---|---|
| memória a mais por byte de vídeo | **2,30** | **0,19** |
| memória do navegador no clipe grande | 1624 MB | **1158 MB** (+41 MB sobre o pequeno) |
| heap de JavaScript | 9 MB | 7 MB |

Os 0,19 que sobram são as faixas guardadas (1 KB por quadro), que a calibragem automática precisa —
não o arquivo. O `file.arrayBuffer()` do leitor anterior é o que fazia a página "carregar e parar" no
iPhone: num vídeo de verdade ele pedia mais memória do que o aparelho dá a uma aba.

(O heap de JavaScript sozinho não denuncia o problema — o conteúdo de um `ArrayBuffer` mora fora
dele. Por isso o teste mede também a memória residente do navegador.)

Na tela, a leitura mostra o progresso em MB o tempo todo (`Lendo o vídeo… 120 MB de 380 MB`), porque
um vídeo grande leva minutos e silêncio parece travamento.

## Conferência contra a cronometragem oficial

Vídeo sintético prova o **algoritmo**, não a cadeia inteira — câmera do iPhone, exposição real,
poeira, luz de arena, cavalo em vez de barra. Quem prova isso é uma fotocélula eletrônica ao lado,
que erra menos de 1 ms: toda diferença que sobra é do app.

Depois de analisar, o cartão traz um campo **"Tempo da cronometragem oficial"**. Digitado o tempo, o
app mostra na hora a diferença com sinal e — o que mais importa — se ela **coube na incerteza que ele
mesmo declarou**. Um app que erra 3 ms avisando "±4 ms" está certo; um que erra 3 ms declarando
"±0,8 ms" está mentindo, e é isso que precisa aparecer.

A comparação é feita com o **tempo refinado, sem penalidade**: a fotocélula mede o cruzamento da
linha na ida e na volta; os +5 s por tambor são decisão de juiz, não medição.

Na aba Histórico, um painel acumula o que várias passadas dizem e uma sozinha não diz:

- **viés** — o app é sistematicamente rápido ou lento? Erro sistemático é o que dá para corrigir;
- **erro absoluto médio** e **maior erro**;
- **quantos ficaram dentro da incerteza declarada**;
- a mesma quebra **por qualidade (0/1/2)**, que separa "o app erra" de "o app erra quando ele mesmo
  avisou que a medição foi ruim" — diagnósticos opostos, correções opostas.

O botão **"Ver / copiar a tabela"** gera o texto colável com o resumo e uma linha por caso. É por ali
que os casos saem: dentro do visualizador de Artifact o download de arquivo é bloqueado, e o CSV
completo (`Baixar CSV`, com as colunas novas `tempo_oficial_s`, `erro_refinado_ms`, `erro_bruto_ms`)
cai no mesmo caminho de texto.

```bash
node test/e2e-validacao.mjs /tmp/prova.mp4   # digita a verdade da simulação como "tempo oficial"
```

Esse teste vale como prova dupla: exercita o campo novo e, como a "fotocélula" é a verdade da
simulação, confirma que a conta do erro está certa.

## Analisar um vídeo real aqui (sem depender do celular)

O iPhone trava ao exportar clipes longos de câmera lenta para a página. O caminho prático para
calibrar é o dono do vídeo subir o arquivo no Drive e a análise acontecer numa máquina, onde dá para
ver todos os diagnósticos, testar posições de linha e comparar com o tempo oficial:

```bash
node ../Tools/analisar_video.mjs /tmp/passada.MOV --oficial 14,325 --linha 0.5 --png /tmp/roi.png
node ../Tools/analisar_video.mjs /tmp/passada.MOV --varrer-linha     # acha sozinho onde medir
```

O comando não reimplementa nada: ele abre o app publicado num Chromium e lê o resultado — o número
que sai dali é o mesmo que sairia na mão do usuário. Antes disso ele faz duas coisas que importam:

1. **Diz o que o arquivo é.** Taxa real pelo cabeçalho: `240 fps` com a duração da gravação significa
   que o iPhone entregou o original; `30 fps` com a duração oito vezes maior significa que ele
   renderizou a câmera lenta antes de entregar, e a precisão cai para ±17 ms por gatilho. Essa é a
   pergunta que a pesquisa bibliográfica não conseguiu responder e que um `ffmpeg -i` responde em um
   segundo.
2. **Converte sem perdas quando precisa.** O Chromium deste ambiente não decodifica H.264 nem HEVC —
   os codecs do iPhone. A conversão para VP9 usa `-lossless 1` e `-fps_mode passthrough`, e a
   contagem de quadros é conferida antes e depois: nenhum quadro criado, nenhum descartado, nenhum
   carimbo de tempo mexido. Recompressão com perda inventaria níveis de cinza e mentiria o milésimo.

Verificado: o mesmo clipe sintético dá `−0,42 ms` pelo caminho direto e `−0,41 ms` depois de passar
por H.264 sem perdas e voltar, com 1008/1008 quadros nos dois casos.
