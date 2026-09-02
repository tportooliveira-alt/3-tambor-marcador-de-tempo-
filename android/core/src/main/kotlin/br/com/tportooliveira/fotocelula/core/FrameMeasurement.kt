package br.com.tportooliveira.fotocelula.core

/**
 * Resultado do processamento de um quadro na faixa. Os vetores de pixels são cópias
 * (W*H valores) — nunca referências ao buffer da câmera.
 */
class FrameMeasurement(
    val tsNs: Nanos,
    /** ΔY_f do enunciado: média de |Y_f - Y_ref| na faixa inteira. */
    val deltaFull: Double,
    /** Média de |Y_f - Y_ref| nas colunas centrais (gatilho). */
    val deltaCore: Double,
    /** Média de |Y_f - fundo| na faixa inteira (confirmação). */
    val deltaBackground: Double,
    /** Por linha da banda: média |Y_f - Y_ref| nas colunas centrais. */
    val rowCore: DoubleArray,
    /** Faixa inteira (W x H, linha a linha) do quadro de referência (c - lag), valores 0..255. */
    val stripPrev: IntArray,
    /** Faixa inteira do quadro atual. */
    val stripCur: IntArray,
    /** Faixa inteira da referência de fundo (mesma paridade quando lag == 2). */
    val stripBg: DoubleArray,
    /** ΔY contra o quadro c-2 (para detectar flicker); null se indisponível. */
    val deltaFullLag2: Double?,
    /** Atraso de referência usado nesta medição (1 ou 2). */
    val lag: Int,
)
