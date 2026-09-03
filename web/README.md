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
npm test        # node --test test/vectors.test.ts  → 30 vetores
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
contra a verdade da simulação. Última execução: **erro de 0,000 ms**, qualidade 2, 1008/1008 quadros
na passada normal — e **erro de 0,000 ms** também na gravação atrasada, com o app calibrando sozinho
no trecho parado depois da chegada.

Limite conhecido deste ambiente: o Chromium disponível não decodifica H.264/HEVC, então o teste usa
VP9 em MP4. O contêiner é o mesmo do `.MOV` do iPhone (o demuxer é o mesmo caminho de código), mas a
decodificação dos codecs da Apple só se confirma no aparelho.
