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

Dois achados do harness adversarial (`Tools/scenario_harness.py`) mudaram regras do fallback: a faixa
plausível de velocidade do bordo passou de 800–4000 para **400–12000 px/s** (câmera a 3 mm/px com cavalo a
18 m/s dá 6000 px/s, e o ajuste correto de 7 colunas estava sendo rejeitado como "implausível"); e o
sentido do bordo, quando só uma coluna é interior, é lido no **primeiro quadro em que a cobertura é
assimétrica** (cobertas atrás, descobertas à frente) — no candidato de um bordo rápido, ou a 60 FPS, a
faixa inteira já está coberta e não informa nada. A dispersão por coluna usa a MAD (robusta): um pixel
espúrio não marca a coluna como texturizada nem descarta os limites.

Qualidade: **2** = ajuste completo com incerteza 3σ ≤ P/8 (tipicamente 0,01–0,1 ms); **1** = intervalo
(ajuste com incerteza grande, coluna única com faixa de velocidades plausíveis 800–4000 px/s, ou só
limites); **0** = intervalo físico do gatilho, do início da exposição do último quadro **realmente
comparado** ao fim da exposição do candidato, mais o atraso até a coluna central à velocidade mínima
plausível e uma folga para bordo inclinado (≈ ±7,6 ms a 240 FPS com 1/480 s; cresce com quadros
perdidos e com o ressemeio do differencer) — o tempo bruto por quadro continua sendo o do candidato. Com exposição curta (1/2000 s ou
menos) a maioria dos cruzamentos cai fora da janela e o resultado é 1 ou 0 — física, não defeito; por
isso o padrão é 1/480 s. Os números medidos na simulação estão em [`validacao-numerica.md`](validacao-numerica.md).

**Efeitos reais que o modelo `V = B + (O − B)·f` não contém** (medidos numa cena mais realista —
curva de tom, bordo inclinado, textura presa ao objeto, flicker integrado dentro da exposição, desfoque):

| Efeito | Sem tratamento | Tratamento no estimador |
|---|---|---|
| Curva de tom (gamma 2,2) | viés −0,07 ms, cancela em ΔT | `PhotocellConfig.gamma` lineariza B, O e V antes de `f` (padrão 1,0 = desligado; 2,2 quando a câmera aplica a curva de vídeo padrão); viés → 0,003 ms |
| Bordo inclinado 0,05–0,15 px/linha | +0,01 a +0,03 ms | a mediana por coluna absorve; a dispersão entre linhas entra na variância empírica e marca a coluna como "texturizada" (`textured_columns` no diagnóstico) → qualidade 1 |
| Desfoque (PSF 2–4 px) | ≤ 0,05 ms | nada a fazer; tolerável |
| Flicker integrado na exposição | ≤ 0,01 ms | referência de mesma fase (lag 2) |
| **Textura no objeto** (pelagem, peiteira, arreios: ±30 níveis) | viés +0,2 a +1,9 ms **com qualidade 2 declarada** | (1) `O` **local**: mediana de até 3 colunas já cobertas atrás do bordo, na mesma linha e no mesmo quadro (distância bordo→amostra de O cai de ~40 px para 1–3 px); (2) variância **empírica** por coluna e χ² reduzido, com o erro coerente entre colunas somado após a propagação; (3) margem `m` aumentada pela amplitude de textura `a_tex` estimada no platô (variância espacial menos o ruído); (4) limites descartados quando há textura ou colunas texturizadas; limites contraditórios ⇒ qualidade 0. Resultado: **nunca declara qualidade 2 sob textura**; cai para 1 ou 0 (±P/2) |

A varredura física ganhou o eixo textura ∈ {0, ±30}: 3.840 cenários, sem textura erro médio 0,007 ms,
p95 0,03 ms, máximo 0,31 ms (qualidade 2 em 61 % dos cenários e em 99 % dos favoráveis: exposição ≥ P/2 e
SNR suficiente); **com textura ±30 o estimador cai para qualidade 0 em 100 % dos casos** — honesto, mas é o
principal limite prático conhecido: um cavalo real tem textura, e o refinamento sub-quadro só entra onde a
banda escolhida (peito/pescoço uniforme, sem peiteira) tem contraste limpo. A comparação com vídeo real
decide isso (importador de clipes previsto).

**Rodada 2 do loop (187 cenários, 5 achados).** (1) Depois de um drop, de armar ou da retomada dos
quadros, o differencer precisa de `lag+1` quadros para voltar a medir: o limite inferior do intervalo de
qualidade 0 passou a ser o último quadro **efetivamente comparado** (não o último quadro recebido), senão
um cruzamento ocorrido durante o ressemeio caía fora do intervalo declarado (erro de −10 ms num intervalo
de ±6,7 ms). (2) Um bordo inclinado adianta o gatilho — a primeira linha da banda cruza antes da linha
média —, então o limite superior de q0 ganhou a folga `(h/2)·0,05 px/linha ÷ v_min`; o envelope de
operação documentado passou a exigir o celular nivelado (≤ 0,05 px/linha ≈ 1,4°) e bordo a ≥ 800 px/s.
(3) **Limitação sem sinal detectável**: dois bordos verticais paralelos a menos de ~10 px dentro da faixa
(peito do cavalo seguido de arreio/perna do cavaleiro a menos de 1 ms) enviesam o ajuste de forma coerente
entre linhas e colunas — nem a variância empírica nem o χ² percebem, e o erro medido foi de 0,58 ms com
±0,24 ms declarados. Mitigação: posicionar a banda onde o bordo do peito está isolado.

**Rodada 1 do loop de agentes (achados que viraram regra).** (1) Pixels **saturados** (≥ 250 ou ≤ 5)
ficam fora do ajuste e dos limites: um cavalo branco ao sol ou flicker forte com curva de tom levava a
qualidade 2 com erros de 1–6 ms (o modelo `V = B + (O − B)·f` não vale num pixel cortado em 255). (2) A
incerteza reportada tem piso de **0,1 ms** (erro de modelo: gamma desconhecida, desfoque), então "±0,04 ms"
deixou de existir. (3) O intervalo de qualidade 0 passou a ser o físico e sem hipóteses sobre contraste: do início da
exposição do **último quadro visto** (primeira linha da banda) ao fim da exposição do candidato (última
linha), mais o atraso até a coluna central à velocidade mínima plausível (400 px/s); um drop do próprio
quadro candidato alarga o intervalo em vez de errar por 5–16 ms. Custo: q0 passa de ±2,1 para ≈ ±4,6 ms —
honesto; apertar isso exige uma estimativa grosseira de velocidade pelas colunas cobertas por quadro
(item do loop). (4) O
simulador aplicava o flicker depois da curva de tom; o flicker modula a luz, antes dela (corrigido nos
três simuladores).

**Tempo por linha (rolling shutter) e semântica dos timestamps.** No Android, `SENSOR_TIMESTAMP` é o
início da exposição da **primeira linha**; `SENSOR_ROLLING_SHUTTER_SKEW` é o intervalo do início da
exposição da primeira linha ao início da linha seguinte à última (tempo de leitura); `SENSOR_FRAME_DURATION`
é início-a-início. O modelo `t_ini(linha) = ts + linha·skew/H` está, portanto, correto; o app lê o skew
do `CaptureResult` e o passa a `PhotocellConfig.skewNs`. No iOS o skew não é exposto e precisa ser
**medido** (LED a ~1 kHz atrás de um difusor → faixas horizontais; período em linhas → linhas/ms); sem
ele o offset por linha é ignorado e cancela em ΔT quando o cavalo cruza na mesma altura.

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
  contínuos no centro da faixa → esperar a transição `isAdjusting*` true→false (piso 400 ms, duas leituras
  estáveis) → `setExposureModeCustom(duration, iso)`, `setFocusModeLocked(lensPosition:)`,
  `setWhiteBalanceModeLocked(with:)` → medir ΔPTS por ≥ 1 s (o app só arma com a taxa **medida** ≥ 237,5).
  Há relato (fórum Apple, sem resposta oficial) de exposição mínima **presa a 1/240 s** no formato de
  240 fps em alguns modelos: por isso o app nunca assume 1/480 s — a exposição **real** (`device.exposureDuration`
  após a trava) alimenta `E` do estimador, que a 1/240 s continua dando qualidade 2 (varredura: erro médio 0,003 ms).
- Drops: `didDrop` com motivo; um drop `Discontinuity` (número desconhecido de quadros perdidos, TN2445)
  invalida o candidato em confirmação e marca a prova como degradada (`framesDropped()` no núcleo).
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
  faixa** num FBO minúsculo com conversão para luminância (faixa de vídeo, como o plano Y) no shader e
  `glReadPixels` de poucos KB; o preview é desenhado a cada 4 quadros na superfície do TextureView.
- **Uma única superfície na sessão restrita.** Pelo código do framework
  (`CameraConstrainedHighSpeedCaptureSessionImpl.createHighSpeedRequestList`): o lote tem
  `fps/30` pedidos; com **duas** saídas só o primeiro pedido do lote inclui a de preview (ela recebe 30 FPS,
  a de gravação recebe tudo — é o comportamento que o CameraX documenta); com **uma** saída todos os
  pedidos a têm como alvo e ela recebe a taxa cheia. Por isso a sessão de alta velocidade do app tem só a
  SurfaceTexture do leitor GL, e o preview sai do próprio leitor. Como garantia, o leitor mede a taxa real
  nos timestamps e o controlador cai para a sessão normal (120/60/30 fixos) se ela ficar abaixo de 80 %.
- Lotes: o HAL só reporta o shutter do último pedido do lote e o framework sintetiza os demais timestamps
  (`camera3.h`, CONSTRAINED_HIGH_SPEED_MODE); jitter dentro do lote é invisível e um drop no lote pode não
  aparecer no timestamp. O app trata `SENSOR_FRAME_DURATION` como fonte da verdade do período e conta
  quadros por janela de 1 s; a validação com LED a 1 kHz é o teste definitivo por aparelho.
- Fallback: sessão normal com `ImageReader(YUV_420_888)` no maior `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`
  **fixo** (`lower == upper`) num tamanho que o hardware entrega nessa taxa (`getOutputMinFrameDuration`,
  sem stall). **Samsung expõe só 30 FPS a apps de terceiros**; a sonda (`CapabilityProbe`) informa o modo
  e a precisão esperada na tela. Preferência pela câmera traseira física (não a lógica multi-câmera) e
  `CONTROL_ZOOM_RATIO = 1` quando for lógica.
- Travas: convergência com regiões AE/AF no centro da faixa (AE convergido, AF parado, exposição estável
  em duas leituras, 0,8–3,5 s) → sessão normal com `MANUAL_SENSOR`: `CONTROL_AE_MODE_OFF` +
  `SENSOR_EXPOSURE_TIME` (≤ período) + `SENSOR_SENSITIVITY` compensado + `SENSOR_FRAME_DURATION`; alta
  velocidade (o HAL ignora AE OFF): `CONTROL_AE_LOCK`; `CONTROL_AWB_LOCK`; foco `CONTROL_AF_MODE_OFF` +
  `LENS_FOCUS_DISTANCE` convergida (senão `AUTO` parado; nunca contínuo armado); estabilização, redução de
  ruído e realce desligados quando o hardware lista o modo OFF. A exposição realmente aplicada e o skew
  são lidos dos `CaptureResult` e alimentam o estimador; depois da trava o app confere por 1,3 s que a
  taxa medida se manteve.
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
- Aqui (Linux, sem Xcode/SDK): 42 testes Kotlin passando (25 vetores compartilhados, unitários,
  invariantes da FSM com eventos aleatórios, prova completa simulada e varredura física de 3.840
  cenários); código Android de câmera/engine compilado contra o framework Android; projeto Xcode gerado
  e validado com o parser `pbxproj`; auto-teste físico do gerador de vetores; os mesmos testes existem em
  Swift (XCTest) e rodam no Mac.
- No Mac: `swift test` no pacote; build no iPhone. No Android Studio: `assembleDebug`.
- Em campo, três protocolos (da literatura de validação de cronometragem por vídeo):
  1. **Fotocélula de referência** (duplo feixe, ~0,4 ms) a 50 cm da linha: o estudo do app "Photo
     Finish" (30 fps) contra Microgate Witty mediu viés de +5 a +12 ms e erro máximo de 90 ms — e dois
     celulares concordando entre si (ICC 0,999) **não** provam exatidão, porque o viés é comum.
  2. **Dois celulares + flash comum**: sincronização por rolling shutter com flashes atinge 0,3–0,5 ms
     (Šmíd & Matas); serve para comparar largada/chegada entre dois aparelhos na mesma linha.
  3. **LED a 1,000 Hz** (ou tela piscando) cruzando a faixa: ΔT = 1,000 ± 0,001 s no modo refinado;
     com GPS 1PPS dá para checar a continuidade dos timestamps por horas (10.000 quadros sem discrepância
     na literatura).
  Mais: taxa medida = 240,0 após a trava; dedo sobre a faixa reage; retomada aos 8 s; 10 min armado sem
  pressão térmica; histograma de ΔPTS com espiga única em 4,167 ms.

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
- `CaptureResult` (SENSOR_TIMESTAMP, SENSOR_ROLLING_SHUTTER_SKEW, SENSOR_FRAME_DURATION): https://developer.android.com/reference/android/hardware/camera2/CaptureResult
- `createHighSpeedRequestList` (lote e alvo por pedido): https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/hardware/camera2/impl/CameraConstrainedHighSpeedCaptureSessionImpl.java
- HAL3 `camera3.h` (CONSTRAINED_HIGH_SPEED_MODE, timestamps sintetizados no lote): https://android.googlesource.com/platform/hardware/libhardware/+/refs/heads/main/include/hardware/camera3.h
- CameraX 1.5 alta velocidade (preview a 30 fps, gravação na taxa alta): https://android-developers.googleblog.com/2025/10/high-speed-capture-and-slow-motion.html
- Exposição mínima 1/240 s a 240 fps (fórum Apple, relato): https://developer.apple.com/forums/thread/674180
- Šmíd & Matas, sincronização por rolling shutter com flashes (0,3–0,5 ms): https://arxiv.org/abs/1902.11084
- Validação do app Photo Finish contra fotocélulas Witty (MDPI Sensors 24(20):6719): https://www.mdpi.com/1424-8220/24/20/6719
- Verificação de timestamps com LED e GPS 1PPS: https://arxiv.org/abs/1503.05705
- Medição do tempo de leitura (rolling shutter) com LED ~1 kHz: https://github.com/gyroflow/rollingshutter
- NBHA Rulebook (cronômetro eletrônico, 0,001 s): https://www.nbha.com/
