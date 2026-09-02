package br.com.tportooliveira.fotocelula.core

/**
 * Tempo em nanossegundos inteiros do relógio do sensor (SENSOR_TIMESTAMP no Android,
 * PTS convertido para escala 1e9 no iOS). Nunca use relógio de CPU/thread aqui.
 */
typealias Nanos = Long

const val NS_PER_SEC: Long = 1_000_000_000L

/** E|X-Y| = 2σ/√π para X,Y ~ N(·, σ): converte ΔY médio (calibração) em σ por pixel. */
const val MEAN_ABS_DIFF_TO_SIGMA: Double = 1.1283791670955126
