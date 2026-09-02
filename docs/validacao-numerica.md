# Validação numérica do estimador sub-quadro

Gerado por `Tools/accuracy_report.py` com a referência Python (`Tools/photocell_reference.py`): cena sintética com
rolling shutter (skew 3,2 ms), exposição integrada, ruído gaussiano por pixel, flicker de 120 Hz opcional, faixa de
15 px × 96 linhas a 240 FPS, contraste cavalo/fundo ≈ 88 níveis, 6 mm/px. Para cada condição, 6 cruzamentos
(dois sentidos × três fases do quadro). A varredura completa (~1.900 cenários, inclusive contraste baixo) roda nos
testes `PhysicsSweepTest` (Kotlin) e `PhysicsSweepTests` (Swift).

Qualidade 2 = ajuste completo (erro comparado ao tempo por quadro); 1 = intervalo honesto (conta quantos contêm a
verdade); 0 = meio da janela de exposição (±2,08 ms).

| Velocidade | Exposição | Ruído σ | Flicker | Erro por quadro (médio) | Q2: n / erro médio / máx | Q1: n / dentro | Q0 |
|---|---|---|---|---|---|---|---|
| 8 m/s | 1/240 s | 0.5 | — | 3.47 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 8 m/s | 1/240 s | 0.5 | 120 Hz | 3.47 ms | 6 / 0.003 ms / 0.006 ms | 0 | 0 |
| 8 m/s | 1/240 s | 1.5 | — | 3.47 ms | 6 / 0.003 ms / 0.005 ms | 0 | 0 |
| 8 m/s | 1/240 s | 1.5 | 120 Hz | 3.47 ms | 6 / 0.009 ms / 0.018 ms | 0 | 0 |
| 8 m/s | 1/240 s | 3.0 | — | 3.47 ms | 6 / 0.006 ms / 0.017 ms | 0 | 0 |
| 8 m/s | 1/240 s | 3.0 | 120 Hz | 3.47 ms | 6 / 0.020 ms / 0.068 ms | 0 | 0 |
| 8 m/s | 1/480 s | 0.5 | — | 2.08 ms | 6 / 0.002 ms / 0.002 ms | 0 | 0 |
| 8 m/s | 1/480 s | 0.5 | 120 Hz | 2.08 ms | 6 / 0.002 ms / 0.006 ms | 0 | 0 |
| 8 m/s | 1/480 s | 1.5 | — | 2.08 ms | 6 / 0.003 ms / 0.008 ms | 0 | 0 |
| 8 m/s | 1/480 s | 1.5 | 120 Hz | 2.08 ms | 6 / 0.003 ms / 0.007 ms | 0 | 0 |
| 8 m/s | 1/480 s | 3.0 | — | 2.08 ms | 6 / 0.008 ms / 0.014 ms | 0 | 0 |
| 8 m/s | 1/480 s | 3.0 | 120 Hz | 2.08 ms | 6 / 0.028 ms / 0.062 ms | 0 | 0 |
| 8 m/s | 1/2000 s | 0.5 | — | 0.97 ms | 6 / 0.001 ms / 0.001 ms | 0 | 0 |
| 8 m/s | 1/2000 s | 0.5 | 120 Hz | 0.97 ms | 2 / 0.001 ms / 0.002 ms | 4 / 4 (±1.26 ms) | 0 |
| 8 m/s | 1/2000 s | 1.5 | — | 0.97 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 8 m/s | 1/2000 s | 1.5 | 120 Hz | 0.97 ms | 2 / 0.004 ms / 0.006 ms | 4 / 4 (±1.28 ms) | 0 |
| 8 m/s | 1/2000 s | 3.0 | — | 0.97 ms | 4 / 0.002 ms / 0.005 ms | 2 / 2 (±1.53 ms) | 0 |
| 8 m/s | 1/2000 s | 3.0 | 120 Hz | 0.97 ms | 0 | 4 / 4 (±1.29 ms) | 2 |
| 14 m/s | 1/240 s | 0.5 | — | 3.47 ms | 6 / 0.002 ms / 0.003 ms | 0 | 0 |
| 14 m/s | 1/240 s | 0.5 | 120 Hz | 3.47 ms | 6 / 0.001 ms / 0.005 ms | 0 | 0 |
| 14 m/s | 1/240 s | 1.5 | — | 3.47 ms | 6 / 0.004 ms / 0.007 ms | 0 | 0 |
| 14 m/s | 1/240 s | 1.5 | 120 Hz | 3.47 ms | 6 / 0.008 ms / 0.011 ms | 0 | 0 |
| 14 m/s | 1/240 s | 3.0 | — | 3.47 ms | 6 / 0.004 ms / 0.016 ms | 0 | 0 |
| 14 m/s | 1/240 s | 3.0 | 120 Hz | 3.47 ms | 6 / 0.018 ms / 0.045 ms | 0 | 0 |
| 14 m/s | 1/480 s | 0.5 | — | 0.97 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 14 m/s | 1/480 s | 0.5 | 120 Hz | 0.97 ms | 6 / 0.004 ms / 0.012 ms | 0 | 0 |
| 14 m/s | 1/480 s | 1.5 | — | 2.08 ms | 6 / 0.001 ms / 0.004 ms | 0 | 0 |
| 14 m/s | 1/480 s | 1.5 | 120 Hz | 2.08 ms | 6 / 0.006 ms / 0.023 ms | 0 | 0 |
| 14 m/s | 1/480 s | 3.0 | — | 0.97 ms | 6 / 0.004 ms / 0.013 ms | 0 | 0 |
| 14 m/s | 1/480 s | 3.0 | 120 Hz | 0.97 ms | 5 / 0.051 ms / 0.166 ms | 1 / 1 (±0.54 ms) | 0 |
| 14 m/s | 1/2000 s | 0.5 | — | 0.97 ms | 6 / 0.001 ms / 0.001 ms | 0 | 0 |
| 14 m/s | 1/2000 s | 0.5 | 120 Hz | 0.97 ms | 5 / 0.003 ms / 0.006 ms | 0 | 1 |
| 14 m/s | 1/2000 s | 1.5 | — | 0.97 ms | 6 / 0.002 ms / 0.003 ms | 0 | 0 |
| 14 m/s | 1/2000 s | 1.5 | 120 Hz | 0.97 ms | 2 / 0.002 ms / 0.002 ms | 2 / 2 (±1.53 ms) | 2 |
| 14 m/s | 1/2000 s | 3.0 | — | 0.97 ms | 4 / 0.001 ms / 0.003 ms | 2 / 2 (±0.48 ms) | 0 |
| 14 m/s | 1/2000 s | 3.0 | 120 Hz | 0.97 ms | 0 | 4 / 4 (±1.00 ms) | 2 |
| 18 m/s | 1/240 s | 0.5 | — | 3.47 ms | 6 / 0.001 ms / 0.002 ms | 0 | 0 |
| 18 m/s | 1/240 s | 0.5 | 120 Hz | 3.47 ms | 6 / 0.002 ms / 0.003 ms | 0 | 0 |
| 18 m/s | 1/240 s | 1.5 | — | 3.47 ms | 6 / 0.004 ms / 0.006 ms | 0 | 0 |
| 18 m/s | 1/240 s | 1.5 | 120 Hz | 3.47 ms | 6 / 0.007 ms / 0.019 ms | 0 | 0 |
| 18 m/s | 1/240 s | 3.0 | — | 3.47 ms | 6 / 0.009 ms / 0.034 ms | 0 | 0 |
| 18 m/s | 1/240 s | 3.0 | 120 Hz | 3.47 ms | 6 / 0.015 ms / 0.028 ms | 0 | 0 |
| 18 m/s | 1/480 s | 0.5 | — | 0.97 ms | 6 / 0.001 ms / 0.003 ms | 0 | 0 |
| 18 m/s | 1/480 s | 0.5 | 120 Hz | 0.97 ms | 6 / 0.007 ms / 0.026 ms | 0 | 0 |
| 18 m/s | 1/480 s | 1.5 | — | 0.97 ms | 6 / 0.002 ms / 0.007 ms | 0 | 0 |
| 18 m/s | 1/480 s | 1.5 | 120 Hz | 0.97 ms | 4 / 0.007 ms / 0.020 ms | 0 | 2 |
| 18 m/s | 1/480 s | 3.0 | — | 0.97 ms | 6 / 0.007 ms / 0.014 ms | 0 | 0 |
| 18 m/s | 1/480 s | 3.0 | 120 Hz | 0.97 ms | 4 / 0.017 ms / 0.036 ms | 0 | 2 |
| 18 m/s | 1/2000 s | 0.5 | — | 0.97 ms | 6 / 0.001 ms / 0.005 ms | 0 | 0 |
| 18 m/s | 1/2000 s | 0.5 | 120 Hz | 0.97 ms | 6 / 0.004 ms / 0.017 ms | 0 | 0 |
| 18 m/s | 1/2000 s | 1.5 | — | 0.97 ms | 6 / 0.008 ms / 0.022 ms | 0 | 0 |
| 18 m/s | 1/2000 s | 1.5 | 120 Hz | 0.97 ms | 6 / 0.009 ms / 0.022 ms | 0 | 0 |
| 18 m/s | 1/2000 s | 3.0 | — | 0.97 ms | 2 / 0.001 ms / 0.002 ms | 4 / 4 (±1.00 ms) | 0 |
| 18 m/s | 1/2000 s | 3.0 | 120 Hz | 0.97 ms | 4 / 0.010 ms / 0.028 ms | 2 / 2 (±1.27 ms) | 0 |

Erro médio (qualidade 2) sobre todas as condições: **0.006 ms**; tempo por quadro: **1.97 ms**. Tempo de geração: 159 s.

Leitura: exposições mais longas dão mais pixels "interiores" (mais qualidade 2); com exposição curta e cavalo
lento só uma coluna vê o bordo e o resultado cai para um intervalo (qualidade 1) que usa a faixa de velocidades
plausível; ruído alto com contraste baixo reduz a qualidade em vez de produzir um número falso.
