/**
 * Tempo em nanossegundos do relógio da fonte de quadros. No app nativo é o timestamp do sensor;
 * na web é o `mediaTime` do vídeo (o relógio do contêiner), que dentro de um mesmo clipe tem a
 * mesma qualidade para medir ΔT.
 *
 * Aqui é `number` (double), não inteiro de 64 bits: um clipe de prova tem dezenas de segundos, e
 * 2^53 ns são 104 dias — folga de sobra para representar cada nanossegundo exatamente.
 */
export type Nanos = number;

export const NS_PER_SEC = 1_000_000_000;

/** E|X-Y| = 2σ/√π para X,Y ~ N(·, σ): converte ΔY médio (calibração) em σ por pixel. */
export const MEAN_ABS_DIFF_TO_SIGMA = 1.1283791670955126;
