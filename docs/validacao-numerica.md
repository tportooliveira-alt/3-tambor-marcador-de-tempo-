# Validação numérica do estimador sub-quadro

Gerado por `Tools/accuracy_report.py` com a referência Python (`Tools/photocell_reference.py`): cena sintética com
rolling shutter (skew 3,2 ms), exposição integrada, ruído gaussiano por pixel, flicker de 120 Hz opcional, faixa de
15 px × 96 linhas a 240 FPS, contraste cavalo/fundo ≈ 88 níveis, 6 mm/px. Para cada condição, 6 cruzamentos
(dois sentidos × três fases do quadro). A varredura completa (~1.900 cenários, inclusive contraste baixo) roda nos
testes `PhysicsSweepTest` (Kotlin) e `PhysicsSweepTests` (Swift).

Qualidade 2 = ajuste completo (erro comparado ao tempo por quadro); 1 = intervalo honesto (conta quantos contêm a
verdade); 0 = intervalo físico do gatilho, do último quadro realmente comparado ao fim da exposição do candidato,
mais o atraso até a coluna central (≈ ±7,6 ms a 240 FPS; maior com quadros perdidos). A coluna 'textura' simula
pelagem/sela: variação de luma
±30 níveis presa ao objeto (senoide de ~7 px), o efeito real que mais degrada o estimador; com textura o resultado
deve cair para intervalo ou tempo do quadro, nunca para um número falso.

| Velocidade | Exposição | Ruído σ | Flicker | Textura | Erro por quadro (médio) | Q2: n / erro médio / máx | Q1: n / dentro | Q0 |
|---|---|---|---|---|---|---|---|---|
| 8 m/s | 1/240 s | 0.5 | — | — | 3.47 ms | 6 / 0.002 ms / 0.005 ms | 0 | 0 |
| 8 m/s | 1/240 s | 0.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/240 s | 0.5 | 120 Hz | — | 3.47 ms | 6 / 0.005 ms / 0.011 ms | 0 | 0 |
| 8 m/s | 1/240 s | 0.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/240 s | 1.5 | — | — | 3.47 ms | 6 / 0.003 ms / 0.007 ms | 0 | 0 |
| 8 m/s | 1/240 s | 1.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/240 s | 1.5 | 120 Hz | — | 3.47 ms | 6 / 0.009 ms / 0.017 ms | 0 | 0 |
| 8 m/s | 1/240 s | 1.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/240 s | 3.0 | — | — | 3.47 ms | 6 / 0.006 ms / 0.012 ms | 0 | 0 |
| 8 m/s | 1/240 s | 3.0 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/240 s | 3.0 | 120 Hz | — | 3.47 ms | 0 | 1 / 1 (±1.53 ms) | 5 |
| 8 m/s | 1/240 s | 3.0 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 0.5 | — | — | 2.08 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 8 m/s | 1/480 s | 0.5 | — | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 0.5 | 120 Hz | — | 2.08 ms | 6 / 0.024 ms / 0.058 ms | 0 | 0 |
| 8 m/s | 1/480 s | 0.5 | 120 Hz | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 1.5 | — | — | 2.08 ms | 6 / 0.003 ms / 0.006 ms | 0 | 0 |
| 8 m/s | 1/480 s | 1.5 | — | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 1.5 | 120 Hz | — | 2.08 ms | 4 / 0.007 ms / 0.011 ms | 2 / 2 (±1.09 ms) | 0 |
| 8 m/s | 1/480 s | 1.5 | 120 Hz | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 3.0 | — | — | 2.08 ms | 6 / 0.010 ms / 0.015 ms | 0 | 0 |
| 8 m/s | 1/480 s | 3.0 | — | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/480 s | 3.0 | 120 Hz | — | 2.08 ms | 2 / 0.048 ms / 0.070 ms | 2 / 2 (±1.03 ms) | 2 |
| 8 m/s | 1/480 s | 3.0 | 120 Hz | ±30 | 2.08 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 0.5 | — | — | 0.97 ms | 6 / 0.017 ms / 0.029 ms | 0 | 0 |
| 8 m/s | 1/2000 s | 0.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 0.5 | 120 Hz | — | 0.97 ms | 2 / 0.117 ms / 0.118 ms | 0 | 4 |
| 8 m/s | 1/2000 s | 0.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 1.5 | — | — | 0.97 ms | 6 / 0.017 ms / 0.023 ms | 0 | 0 |
| 8 m/s | 1/2000 s | 1.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 1.5 | 120 Hz | — | 0.97 ms | 2 / 0.096 ms / 0.099 ms | 0 | 4 |
| 8 m/s | 1/2000 s | 1.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 3.0 | — | — | 0.97 ms | 4 / 0.012 ms / 0.020 ms | 2 / 2 (±1.87 ms) | 0 |
| 8 m/s | 1/2000 s | 3.0 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 8 m/s | 1/2000 s | 3.0 | 120 Hz | — | 0.97 ms | 2 / 0.076 ms / 0.077 ms | 0 | 4 |
| 8 m/s | 1/2000 s | 3.0 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 0.5 | — | — | 3.47 ms | 6 / 0.002 ms / 0.004 ms | 0 | 0 |
| 14 m/s | 1/240 s | 0.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 0.5 | 120 Hz | — | 3.47 ms | 6 / 0.002 ms / 0.008 ms | 0 | 0 |
| 14 m/s | 1/240 s | 0.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 1.5 | — | — | 3.47 ms | 6 / 0.004 ms / 0.005 ms | 0 | 0 |
| 14 m/s | 1/240 s | 1.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 1.5 | 120 Hz | — | 3.47 ms | 6 / 0.007 ms / 0.017 ms | 0 | 0 |
| 14 m/s | 1/240 s | 1.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 3.0 | — | — | 3.47 ms | 6 / 0.006 ms / 0.011 ms | 0 | 0 |
| 14 m/s | 1/240 s | 3.0 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 3.0 | 120 Hz | — | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/240 s | 3.0 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 0.5 | — | — | 0.97 ms | 6 / 0.001 ms / 0.001 ms | 0 | 0 |
| 14 m/s | 1/480 s | 0.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 0.5 | 120 Hz | — | 0.97 ms | 6 / 0.013 ms / 0.039 ms | 0 | 0 |
| 14 m/s | 1/480 s | 0.5 | 120 Hz | ±30 | 2.08 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 1.5 | — | — | 2.08 ms | 6 / 0.004 ms / 0.006 ms | 0 | 0 |
| 14 m/s | 1/480 s | 1.5 | — | ±30 | 2.08 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 1.5 | 120 Hz | — | 2.08 ms | 6 / 0.010 ms / 0.023 ms | 0 | 0 |
| 14 m/s | 1/480 s | 1.5 | 120 Hz | ±30 | 2.08 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 3.0 | — | — | 0.97 ms | 6 / 0.004 ms / 0.009 ms | 0 | 0 |
| 14 m/s | 1/480 s | 3.0 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/480 s | 3.0 | 120 Hz | — | 0.97 ms | 4 / 0.014 ms / 0.033 ms | 0 | 2 |
| 14 m/s | 1/480 s | 3.0 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 0.5 | — | — | 0.97 ms | 4 / 0.001 ms / 0.002 ms | 2 / 2 (±1.11 ms) | 0 |
| 14 m/s | 1/2000 s | 0.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 0.5 | 120 Hz | — | 0.97 ms | 0 | 2 / 2 (±1.11 ms) | 4 |
| 14 m/s | 1/2000 s | 0.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 1.5 | — | — | 0.97 ms | 4 / 0.003 ms / 0.005 ms | 2 / 2 (±1.10 ms) | 0 |
| 14 m/s | 1/2000 s | 1.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 1.5 | 120 Hz | — | 0.97 ms | 0 | 2 / 2 (±1.11 ms) | 4 |
| 14 m/s | 1/2000 s | 1.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 3.0 | — | — | 0.97 ms | 4 / 0.004 ms / 0.007 ms | 2 / 2 (±1.11 ms) | 0 |
| 14 m/s | 1/2000 s | 3.0 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 14 m/s | 1/2000 s | 3.0 | 120 Hz | — | 0.97 ms | 0 | 2 / 2 (±1.11 ms) | 4 |
| 14 m/s | 1/2000 s | 3.0 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 0.5 | — | — | 3.47 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 18 m/s | 1/240 s | 0.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 0.5 | 120 Hz | — | 3.47 ms | 6 / 0.001 ms / 0.002 ms | 0 | 0 |
| 18 m/s | 1/240 s | 0.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 1.5 | — | — | 3.47 ms | 6 / 0.003 ms / 0.006 ms | 0 | 0 |
| 18 m/s | 1/240 s | 1.5 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 1.5 | 120 Hz | — | 3.47 ms | 6 / 0.008 ms / 0.019 ms | 0 | 0 |
| 18 m/s | 1/240 s | 1.5 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 3.0 | — | — | 3.47 ms | 6 / 0.011 ms / 0.022 ms | 0 | 0 |
| 18 m/s | 1/240 s | 3.0 | — | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/240 s | 3.0 | 120 Hz | — | 3.47 ms | 0 | 1 / 1 (±1.51 ms) | 5 |
| 18 m/s | 1/240 s | 3.0 | 120 Hz | ±30 | 3.47 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 0.5 | — | — | 0.97 ms | 6 / 0.002 ms / 0.003 ms | 0 | 0 |
| 18 m/s | 1/480 s | 0.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 0.5 | 120 Hz | — | 0.97 ms | 4 / 0.002 ms / 0.002 ms | 0 | 2 |
| 18 m/s | 1/480 s | 0.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 1.5 | — | — | 0.97 ms | 6 / 0.005 ms / 0.012 ms | 0 | 0 |
| 18 m/s | 1/480 s | 1.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 1.5 | 120 Hz | — | 0.97 ms | 4 / 0.012 ms / 0.038 ms | 0 | 2 |
| 18 m/s | 1/480 s | 1.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 3.0 | — | — | 0.97 ms | 6 / 0.010 ms / 0.029 ms | 0 | 0 |
| 18 m/s | 1/480 s | 3.0 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/480 s | 3.0 | 120 Hz | — | 0.97 ms | 4 / 0.037 ms / 0.103 ms | 0 | 2 |
| 18 m/s | 1/480 s | 3.0 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 0.5 | — | — | 0.97 ms | 6 / 0.047 ms / 0.120 ms | 0 | 0 |
| 18 m/s | 1/2000 s | 0.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 0.5 | 120 Hz | — | 0.97 ms | 4 / 0.068 ms / 0.116 ms | 0 | 2 |
| 18 m/s | 1/2000 s | 0.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 1.5 | — | — | 0.97 ms | 2 / 0.003 ms / 0.005 ms | 4 / 4 (±1.44 ms) | 0 |
| 18 m/s | 1/2000 s | 1.5 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 1.5 | 120 Hz | — | 0.97 ms | 1 / 0.029 ms / 0.029 ms | 1 / 1 (±1.14 ms) | 4 |
| 18 m/s | 1/2000 s | 1.5 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 3.0 | — | — | 0.97 ms | 2 / 0.002 ms / 0.004 ms | 4 / 4 (±1.48 ms) | 0 |
| 18 m/s | 1/2000 s | 3.0 | — | ±30 | 0.97 ms | 0 | 0 | 6 |
| 18 m/s | 1/2000 s | 3.0 | 120 Hz | — | 0.97 ms | 0 | 2 / 2 (±1.14 ms) | 4 |
| 18 m/s | 1/2000 s | 3.0 | 120 Hz | ±30 | 0.97 ms | 0 | 0 | 6 |

Erro médio (qualidade 2) sobre todas as condições: **0.016 ms** (sem textura: **0.016 ms**); intervalos de qualidade 1 que contêm a verdade: **31/31**; tempo por quadro: **1.98 ms**. Tempo de geração: 433 s.

Leitura: exposições mais longas dão mais pixels "interiores" (mais qualidade 2); com exposição curta e cavalo
lento só uma coluna vê o bordo e o resultado cai para um intervalo (qualidade 1) que usa a faixa de velocidades
plausível; ruído alto com contraste baixo reduz a qualidade em vez de produzir um número falso.
