# Estudo técnico — fotocélula virtual para Três Tambores (iOS + Android)

Este documento consolida o estudo que orientou o projeto: o orçamento de erro físico, o que cada
plataforma realmente permite, o algoritmo comum e as decisões de arquitetura. Complementa o
estudo do NotebookLM ("Cronometragem Mobile Para Três Tambores"), que chegou às mesmas conclusões
de base (subtração de fundo em vez de redes neurais, timestamps do sensor, compensação do rolling
shutter, interpolação sub-quadro, motores nativos separados) e acrescenta o que foi verificado com
simulação numérica aqui.

## 1. Orçamento de erro: o que realmente limita a precisão

| Fonte | Magnitude | Cancela em ΔT? | Tratamento |
|---|---|---|---|
| Jitter do timestamp do sensor (PTS / SENSOR_TIMESTAMP) | < 0,1 ms | — | usar sempre o timestamp do quadro, nunca relógio de CPU (jitter de 2–15 ms) |
| Quantização a 240 FPS | ±2,08 ms por gatilho (ΔT: triangular ±4,17 ms, σ ≈ 1,7 ms) | não | **estimador de fração de exposição** (§3) |
| Quantização a 120 / 60 / 30 FPS | ±4,2 / ±8,3 / ±16,7 ms | não | mesmo estimador; o app mostra a precisão esperada do aparelho |
| Rolling shutter (leitura linha a linha) | até 1 período de quadro entre topo e base | sim, para a mesma banda de linhas | offset constante; opcionalmente corrigido por linha quando o skew é conhecido |
| Motion blur (exposição) | 15 m/s × 2 ms = 31 mm | sim | vira **sinal**: é exatamente o que o estimador mede |
| **Viés de direção da faixa** | faixa de 10 px a 6 mm/px = 62 mm ≈ 4 ms a 15 m/s | **não** (largada e chegada cruzam a mesma linha em sentidos opostos) | cronometrar no **plano central** da faixa (ajuste tempo × coluna) |
| Paralaxe (faixa fora do centro óptico) | vários cm por metro de dispersão lateral | não | ROI no centro da imagem; mover o tripé, não a linha |
| Geometria do animal (focinho/peito não é um plano) | dezenas de mm | parcialmente (mesmo bordo nos dois sentidos) | banda de linhas na altura que o cavalo sempre cruza, como o feixe físico |

**Resultado da simulação** (`Tools/gen_test_vectors.py`, cena sintética com rolling shutter, exposição
integrada, ruído gaussiano, flicker de 120 Hz e drops): erro do refinamento entre −0,003 e +0,115 ms
em todos os nove cenários, contra −1,5 a −3,7 ms do tempo por quadro. O pior caso é a arena noturna
(σ = 4 níveis, flicker 10 %).

## 2. Por que nativo, e por que não web

Um app web/PWA não tem acesso ao timestamp do sensor, a formatos de 240 FPS nem ao travamento manual
de exposição; o `requestVideoFrameCallback` entrega tempos de apresentação com jitter de vários ms.
Por isso há dois apps nativos com o mesmo algoritmo (Swift e Kotlin), validados pelos mesmos vetores.

## 3. Algoritmo comum (referência: `Tools/photocell_reference.py`)

### 3.1 Faixa e medições por quadro
- ROI: faixa vertical de W px (5–40, padrão 9) × banda de H linhas; só o **plano Y** (luminância) é
  lido, com `Endereço(x, y) = base + y·stride + x`. Nada do quadro inteiro é copiado.
- Por quadro: `ΔY_full` (fórmula do enunciado, faixa inteira), `ΔY_core` (colunas centrais, gatilho),
  `ΔY_bg` (contra a referência de fundo, confirmação) e, para o estimador, as faixas do quadro atual,
  do quadro de referência e do fundo.
- Referência: quadro c−1 (lag 1) ou c−2 (lag 2) quando a calibração detecta flicker de 120 Hz
  (a 240 FPS há exatamente 2 quadros por ciclo da rede de 60 Hz; quadros de mesma fase têm o mesmo
  brilho). O fundo é uma EMA lenta (α = 0,02), atualizada só quando nada passa, separada por paridade
  no lag 2.

### 3.2 Calibração de ruído
240 amostras de `ΔY_full` (1 s) com Welford; outlier (> μ + 10σ) reinicia (até 3 vezes);
`T = max(4, μ + 6σ, 2μ)`. O ruído por pixel é derivado de μ (`σ_px = μ / 1,128`) e alimenta a margem
de classificação do estimador. O aviso de flicker aparece quando `μ(lag 2) < 0,5·μ(lag 1)`.

### 3.3 Gatilho e confirmação (sem penalidade de tempo)
Candidato = primeiro quadro com `ΔY_core > T`. Confirmação = `ΔY_bg > T` em ≥ 2 dos 4 quadros
seguintes (a referência de fundo dá um sinal sustentado durante toda a passagem, ao contrário da
diferença quadro a quadro, que pode cair num flanco uniforme). O tempo do evento é o do candidato.
Drops (gaps de PTS > 1,5 período) são contados; um drop a < 50 ms do gatilho marca a prova como
"degradada". Não se ressemeia em drop (cegaria um quadro na passagem).

### 3.4 Estimador sub-quadro por fração de exposição
Cada pixel integra a luz em `[t_ini, t_ini + E]` (E = exposição). Se o bordo do objeto (luma O) cobre o
pixel (fundo B) no instante `t_x` dentro da janela, o valor medido é `V = B + (O − B)·f` com
`f = (t_ini + E − t_x)/E`, logo `t_x = t_ini + E·(1 − f)`. O bordo se move a velocidade constante,
`t_x(coluna) = t_c + s·dx`; um ajuste linear ponderado por `(O − B)²` sobre a **mediana por coluna** dos
pixels "interiores" (margem `m = max(0,03; 4·√2·σ_px/|O − B|)`) de três quadros (c−lag, c, c+lag) devolve
`t_c`, o cruzamento do **plano central**, e a velocidade. A mediana resiste a um pixel saturado que o ruído
classificou como interior (erro ~P), que numa média ponderada tombava o ajuste em até 2 ms.

Selecionar os pixels interiores pelo valor observado é correlacionado com o sinal do ruído perto dos
cortes `m` e `1−m` (só entram os pixels cujo ruído os empurrou para dentro), o que enviesa a mediana em
~E·σ_f e, extrapolado de colunas longe do centro, chegava a 0,4 ms. Por isso o ajuste é feito em **dois
passos**: o segundo reseleciona os pixels pelo `f` **previsto** pela reta do primeiro e usa o `f` observado
sem corte (não enviesado). A incerteza é propagada do ruído por pixel (`σ_t = E·√2·σ_px/|O − B|`) através
da mediana (fator π/2) e dos coeficientes do ajuste; o valor reportado é 3σ.

Pixels saturados dão limites: `f_obs ≥ 1−m` com ruído até `m` implica `f ≥ 1−2m ⇒ t_x ≤ t_ini + 2mE`;
`f_obs ≤ m ⇒ t_x ≥ t_ini + E·(1−2m)`. Só a coluna central dá limites (em outra coluna o limite valeria
para `t_x(dx)`, não para `t_c`). O quadro de referência (c−lag) é avaliado com a mesma regra, o que cobre
cruzamentos que caem na "janela cega" entre exposições. O é lido do quadro c+2·lag (platô).

Qualidade: **2** = ajuste completo com incerteza 3σ ≤ P/8 (tipicamente 0,01–0,1 ms); **1** = intervalo
(ajuste com incerteza grande, coluna única com faixa de velocidades plausíveis 800–4000 px/s, ou só
limites); **0** = meio da janela de exposição do quadro candidato, ±P/2. Com exposição curta (1/2000 s ou
menos) a maioria dos cruzamentos cai fora da janela e o resultado é 1 ou 0 — física, não defeito; por
isso o padrão é 1/480 s. Os números medidos na simulação estão em [`validacao-numerica.md`](validacao-numerica.md).

Por que não "primeira linha alterada" (rolling shutter como relógio): com exposição de 2 ms a rampa da
transição se espalha por ~470 linhas, maior que qualquer banda razoável, e a "primeira linha" fica
ambígua; a simulação mostrou isso antes de trocar de modelo. O rolling shutter continua compensado
por linha quando o skew é conhecido (Android: `SENSOR_ROLLING_SHUTTER_SKEW`), mas não é necessário.

### 3.5 Máquina de estados
`IDLE → CALIBRATING → ARMED → (CONFIRMING_START) → DEBOUNCE_START (1,5 s) → RUNNING → AWAITING_FINISH
→ (CONFIRMING_FINISH) → DEBOUNCE_FINISH (2,0 s) → FINISHED`, mais `ERROR` (interrupção da captura,
calibração instável), com `userReset` como única saída. Em RUNNING o pipeline é desligado
(`setFrameDelivery(false)`); volta aos 8,0 s só para ressemear (latência de retomada não é documentada
pela Apple nem pelo Android) e a detecção é armada aos 10,0 s. Todas as transições temporais são
efeitos `scheduleWakeup(t)` executados por timers na fila do engine e também checados pelo PTS de cada
quadro; o display link/Choreographer apenas lê o snapshot. O engine tem dono único (uma fila serial).

## 4. iOS — AVFoundation na prática
- Formato: subtipo `420v` **e** `maxFrameRate ≥ 240`, menor área (720p240). Não filtrar por binning.
  `sessionPreset = .inputPriority`, `automaticallyConfiguresCaptureDeviceForWideColor = false`.
  `activeFormat` **reseta** as frame durations: setar `CMTime(1, 240)` logo depois, no mesmo lock.
- Exposição: duração custom acima de 1/240 s alonga o quadro silenciosamente. Procedimento
  "convergir e travar": `activeMaxExposureDuration` = exposição desejada (≤ período) → AE/AF/AWB
  contínuos no centro da faixa → esperar `isAdjusting*` → `setExposureModeCustom(duration, iso)`,
  `setFocusModeLocked(lensPosition:)`, `setWhiteBalanceModeLocked(with:)` → verificar
  `activeVideoMinFrameDuration` (erro fatal na UI se saiu de 240).
- Guardas: `isVideoHDRSupported` antes de `isVideoHDREnabled` (lança exceção sem suporte),
  `isGeometricDistortionCorrectionSupported`, `isLowLightBoostSupported`, `isVideoStabilizationModeSupported(.off)`,
  `automaticallyAdjustsFaceDrivenAutoFocusEnabled = false`, `isSubjectAreaChangeMonitoringEnabled = false`.
- Relógio: PTS no `session.synchronizationClock` (host clock em câmera única); conversão única para
  nanossegundos inteiros com `CMTimeConvertScale`; o núcleo não usa `CMTime`.
- Orientação: a conexão do `AVCaptureVideoDataOutput` **não** é rotacionada (buffer nativo, paisagem);
  só o preview é. A ROI vai da tela para o buffer com `metadataOutputRectConverted(fromLayerRect:)`.
- Suspensão: `connection.isEnabled = false` na saída de dados (sessão e preview continuam); alternativa
  `.softGate` nas configurações. Térmico: `systemPressureState` + `ProcessInfo.thermalState`.
- Caminho quente: delegate retido pelo `CameraManager`; buffers nunca escapam do callback; faixa copiada
  para buffers alocados uma vez; `defer { Unlock }`; `bytesPerRowOfPlane` lido a cada quadro; fila
  `.userInteractive` com `autoreleaseFrequency: .workItem`; sem `print` por quadro (`os_signpost`).
- ProMotion: `CADisableMinimumFrameDurationOnPhone` + `preferredFrameRateRange(80…120)`;
  `UILaunchScreen = {}` obrigatório; `isIdleTimerDisabled = true`.

## 5. Android — o que o Camera2 permite a apps de terceiros
- ≥ 120 FPS só com `createConstrainedHighSpeedCaptureSession`, que aceita apenas superfícies de
  preview/gravação (não `ImageReader`). Solução: SurfaceTexture próprio + OpenGL ES numa thread
  dedicada; a cada quadro `updateTexImage()`, `getTimestamp()` (= SENSOR_TIMESTAMP), render **só da
  faixa** num FBO minúsculo com conversão para luminância no shader e `glReadPixels` de poucos KB;
  o preview é desenhado a cada 4 quadros na superfície do TextureView.
- Fallback: sessão normal com `ImageReader(YUV_420_888)` no maior `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`
  fixo (120/60/30). **Samsung expõe só 30 FPS a apps de terceiros**; a sonda (`CapabilityProbe`) informa
  o modo e a precisão esperada na tela.
- Travas: `CONTROL_AE_MODE_OFF` + `SENSOR_EXPOSURE_TIME`/`SENSOR_SENSITIVITY` (capacidade
  `MANUAL_SENSOR`) ou `CONTROL_AE_LOCK`; `CONTROL_AWB_LOCK`; estabilização, redução de ruído e
  realce desligados; `SENSOR_FRAME_DURATION` fixo. A exposição realmente aplicada é lida dos
  `CaptureResult` e alimenta o estimador (E).
- Relógio: `SENSOR_INFO_TIMESTAMP_SOURCE` REALTIME = `elapsedRealtimeNanos()`; UNKNOWN = relógio
  próprio; `SensorClock` estima o deslocamento (mínimo observado) só para o cronômetro de tela e wake-ups.
- Térmico: `PowerManager.addThermalStatusListener`; tela a 120 Hz via `preferredRefreshRate`;
  `FLAG_KEEP_SCREEN_ON`; `sensorLandscape`.

## 6. Regras da prova que afetam o produto
Uma única linha para largada e chegada; cronometragem em milésimos nas provas grandes; +5 s por
tambor derrubado; "sem tempo" (SAT). Padrão oficial de 27,5 m (1º–2º tambor) e 32 m (2º–3º).
Consequências: três casas decimais, penalidades e SAT no resultado, histórico exportável, e o
estimador no plano central para o sentido oposto do retorno não gerar viés.

## 7. Verificação
- Aqui (Linux, sem Xcode/SDK): 27 testes Kotlin passando (21 vetores + unitários); código Android de
  câmera/engine compilado contra o framework Android; projeto Xcode gerado e validado com o parser
  `pbxproj`; auto-teste físico do gerador de vetores.
- No Mac: `swift test` no pacote; build no iPhone. No Android Studio: `assembleDebug`.
- Em campo: taxa medida = 240,0; dedo sobre a faixa reage; retomada aos 8 s; 10 min armado sem
  pressão térmica; LED a 1,000 Hz → 1,000 ± 0,001 s.

## Fontes
- Apple TN2409 (formatos 240 FPS): https://developer.apple.com/library/archive/technotes/tn2409/_index.html
- Apple TN2445 (drops no VideoDataOutput): https://developer.apple.com/library/archive/technotes/tn2445/_index.html
- `CMClockGetHostTimeClock`: https://developer.apple.com/documentation/coremedia/cmclockgethosttimeclock()
- ProMotion / `CADisableMinimumFrameDurationOnPhone`: https://developer.apple.com/documentation/quartzcore/optimizing-iphone-and-ipad-apps-to-support-promotion-displays
- `requestGeometryUpdate` (iOS 16): https://developer.apple.com/documentation/uikit/uiwindowscene/requestgeometryupdate(_:errorhandler:)
- Exposição a 240 FPS (fórum Apple): https://developer.apple.com/forums/thread/26227
- `SENSOR_ROLLING_SHUTTER_SKEW`: https://learn.microsoft.com/en-us/dotnet/api/android.hardware.camera2.captureresult.sensorrollingshutterskew
- `CameraConstrainedHighSpeedCaptureSession`: https://learn.microsoft.com/en-us/dotnet/api/android.hardware.camera2.cameraconstrainedhighspeedcapturesession
- Samsung: 120 FPS indisponível a terceiros: https://forum.developer.samsung.com/t/recording-video-at-120fps-using-a-third-party-app-seems-not-possible-o/28043/2
- Rolling shutter e leitura sequencial: https://photographyicon.com/rolling-readout/
- Rolling shutter para detectar sinais de alta frequência (SPIE 2019): https://ui.adsabs.harvard.edu/abs/2019SPIE11137E..0HF/abstract
- Regras dos Três Tambores: https://www.atletapro.com.br/regras-tres-tambores/
