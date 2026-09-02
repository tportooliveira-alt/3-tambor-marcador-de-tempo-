# Fotocélula Tambor — cronômetro de Três Tambores por câmera (iOS + Android)

Fotocélula **virtual** para a Prova de Três Tambores: a câmera traseira do celular, fixa num tripé
ao lado da linha de largada/chegada (é a mesma linha), filma a 240 quadros por segundo; uma faixa
vertical estreita da imagem funciona como o feixe do olho eletrônico. Quando o cavalo cruza a faixa,
o app usa o **timestamp de hardware do sensor** daquele quadro (nunca o relógio do processador) e
refina o instante do cruzamento dentro do quadro pela **fração de exposição** dos pixels. Nenhum
vídeo é gravado.

| | iOS (`ios/`) | Android (`android/`) |
|---|---|---|
| Linguagem / UI | Swift 5.9 · SwiftUI · AVFoundation | Kotlin · Jetpack Compose · Camera2 |
| Mínimo | iOS 16, iPhone (todos desde o 6 fazem 720p240) | Android 9 (API 28); alta velocidade só onde o fabricante libera |
| Captura | `builtInWideAngleCamera` 1x, formato 420v 240 FPS, exposição/foco/branco travados | sessão de alta velocidade (240/120 FPS) via OpenGL, ou sessão normal (ImageReader) |
| Tempo | PTS do `CMSampleBuffer` (host clock) | `SENSOR_TIMESTAMP` |
| Núcleo | `ios/Packages/PhotocellCore` (Swift, testável com `swift test`) | `android/core` (Kotlin JVM, testável com Gradle) |

Os dois núcleos implementam **o mesmo algoritmo**, especificado pela referência executável
`Tools/photocell_reference.py`, e são validados pelos **mesmos vetores de teste** em
`shared/test-vectors/` (21 cenários: cruzamentos sintéticos com ruído, flicker de 120 Hz, drops,
exposições curtas e longas, calibração, máquina de estados completa).

## Como funciona (resumo)

1. **Calibrar**: a câmera deixa exposição, foco e balanço de branco convergirem no centro da faixa
   e depois os **trava** (valores fixos). Em seguida mede o ruído da faixa com a pista vazia por 1 s
   e define o limiar adaptativo `max(4, μ + 6σ, 2μ)`. Se detectar flicker de 120 Hz (luz artificial),
   passa a comparar cada quadro com o de mesma fase (c−2).
2. **Armar**: repete a medição de ruído (a luz muda entre competidores) e entra em `ARMED`.
3. **Largada**: o primeiro quadro em que as colunas centrais da faixa mudam acima do limiar vira
   candidato; a passagem é confirmada em 2 dos 4 quadros seguintes contra a referência de fundo.
   O tempo do evento é o do quadro candidato, refinado pelo estimador sub-quadro. Bipe + flash.
4. **DEBOUNCE_START (1,5 s) → RUNNING**: o pipeline de vídeo é **desligado** (economia térmica);
   volta aos 8,0 s só para ressemear e a detecção da chegada é armada aos 10,0 s.
5. **Chegada** (mesma faixa, sentido oposto) → **DEBOUNCE_FINISH (2,0 s)** → **FINISHED**:
   tempo = `PTS_chegada − PTS_largada`, com o refinamento sub-quadro; penalidade de +5 s por tambor
   e "sem tempo" (SAT); histórico e exportação CSV.

### Precisão

| Modo | Erro por gatilho | Observação |
|---|---|---|
| Por quadro (bruto) a 240 FPS | ±2,08 ms | limite da amostragem |
| **Refinado, qualidade 2** (fração de exposição) | **0,01–0,1 ms** na simulação (1.920 cenários: erro médio 0,007 ms, p95 0,03 ms, máximo 0,17 ms) | precisa de contraste ≥ 20 níveis entre cavalo e fundo e exposição ≥ 1/480 s; a incerteza 3σ é mostrada junto do tempo |
| Refinado, qualidade 1 (intervalo) | intervalo honesto que contém a verdade (tipicamente ±0,5–1,5 ms) | exposição curta, contraste baixo ou bordo visto numa só coluna |
| Refinado, qualidade 0 | ±2,08 ms (meio da janela do quadro) | o app mostra o bruto |
| Samsung (30 FPS para apps de terceiros) | ±17 ms | o app avisa na tela |

Números por condição (velocidade × exposição × ruído × flicker): [`docs/validacao-numerica.md`](docs/validacao-numerica.md).

O estimador mede, em cada pixel da faixa, a fração da janela de exposição em que o cavalo já cobria
o pixel (`V = B + (O − B)·f`) e ajusta uma reta tempo × coluna para obter o instante em que o bordo
cruzou o **plano central** da faixa — por isso a largada (num sentido) e a chegada (no outro) não têm
viés de direção. Pixels totalmente cobertos/descobertos só fornecem limites; a margem de
classificação depende do ruído medido na calibração. Detalhes e fontes: `docs/estudo-tecnico.md`.

## Montagem em campo

1. Tripé pesado na lateral da linha, celular **deitado (paisagem)**, lente 1x, sem zoom.
2. Abra o app antes de posicionar: o formato de 240 FPS tem campo de visão mais estreito.
3. Alinhe a linha tracejada com a estaca/cerca do outro lado da pista movendo o **tripé**, não a
   linha (o plano da fotocélula só é perpendicular à pista no centro da imagem).
4. Ajuste a **banda** (alças) para a altura que o peito/pescoço do cavalo sempre cruza.
5. Pista vazia → **Calibrar** → **Armar**. Depois da chegada, marque tambores derrubados/SAT e salve.

A 5–8 m da linha, cada pixel cobre ~4–6 mm em 720p; a faixa padrão tem 15 px (ajustável 5–40).

## Compilar

### iOS (Mac com Xcode 15+)
```sh
cd ios
open FotocelulaTambor.xcodeproj        # projeto gerado por Tools/generate_xcodeproj.py
# se não abrir na sua versão do Xcode:
./bootstrap.sh                          # brew install xcodegen && xcodegen generate
# testes do núcleo sem abrir o Xcode:
cd Packages/PhotocellCore && swift test
```
Requer um iPhone físico (o simulador não tem câmera). Ajuste o "Team" em Signing & Capabilities.

### Android (Android Studio ou linha de comando com o SDK)
```sh
cd android
./gradlew :core:test -PskipApp=true     # testes do núcleo (roda em qualquer máquina com JDK 17+)
./gradlew :app:assembleDebug            # APK (precisa do Android SDK / Android Studio)
```

### Ferramentas de apoio (Python 3)
```sh
python3 Tools/gen_test_vectors.py       # regenera shared/test-vectors a partir da referência
python3 Tools/generate_xcodeproj.py     # regenera ios/FotocelulaTambor.xcodeproj
python3 Tools/validate_project.py       # validação estática do projeto iOS (pip install pbxproj)
```

## Configurar o iPhone para manter o milésimo

**No aparelho**
1. Ajustes → Privacidade e Segurança → **Modo Desenvolvedor** ligado (iOS 16+; sem isso o Xcode não instala o app).
2. Ajustes → Bateria → **Modo Pouca Energia desligado** (corta até 40 % da CPU e trava a tela em 60 Hz; o app bloqueia "Armar" enquanto estiver ligado).
3. **Modo Avião** (ou Foco "Não Perturbe") durante a prova: uma ligação interrompe a sessão de câmera e a passada é perdida.
4. Bateria acima de 40 %, aparelho fora do sol direto e **sem carregar durante a prova** (calor faz o iOS reduzir a taxa da câmera; o badge térmico mostra o estado).
5. Brilho da tela baixo; Acesso Guiado (toque triplo) evita toques acidentais.

**No Xcode**
1. Abra `ios/FotocelulaTambor.xcodeproj`, selecione o alvo, Signing & Capabilities → Team = seu Apple ID (gratuito instala por 7 dias; o Programa de Desenvolvedor permite TestFlight e 1 ano). Nenhuma capability extra é necessária.
2. Conecte o iPhone, escolha-o como destino e rode. **Meça sempre em Release** (Product → Scheme → Edit Scheme → Run → Build Configuration = Release): em Debug o laço da faixa é 10–50× mais lento.
3. O painel de diagnósticos mostra a taxa medida e o jitter de ΔPTS; o app só arma com 240 FPS confirmados.

## Checklist de verificação no aparelho

1. Formato escolhido e taxa medida na tela (deve ler 240,0 FPS; a exposição travada não pode reduzi-la).
2. Dedo sobre a faixa → o medidor de ΔY reage nas duas orientações de paisagem.
3. Latência de retomada dos quadros aos 8 s (Diagnósticos → FPS volta a 240 antes dos 10 s).
4. 10 min armado sem o badge térmico passar de "sério".
5. Validação de ΔT com um LED/tela piscando a 1,000 Hz cruzando a faixa: 1,000 ± 0,001 s (refinado).

## Estrutura

```
Tools/photocell_reference.py   referência executável do algoritmo (Python)
Tools/gen_test_vectors.py      gera shared/test-vectors/*.json
shared/test-vectors/           vetores compartilhados (Swift e Kotlin precisam bater)
ios/Packages/PhotocellCore     núcleo Swift + XCTest
ios/App                        app SwiftUI (Capture, Session, Timing, Results, Feedback, UI)
android/core                   núcleo Kotlin + JUnit (27 testes passando)
android/app                    app Compose (camera, engine, results, feedback, ui)
docs/estudo-tecnico.md         estudo avançado (física, APIs, decisões, fontes)
```
