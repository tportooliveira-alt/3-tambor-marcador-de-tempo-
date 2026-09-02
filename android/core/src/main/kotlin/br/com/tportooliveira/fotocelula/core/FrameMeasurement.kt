package br.com.tportooliveira.fotocelula.core

/**
 * Resultado do processamento de um quadro na faixa.
 *
 * ATENÇÃO: [stripPrev], [stripCur] e [stripBg] são REFERÊNCIAS aos buffers rotativos do
 * [StripDifferencer], válidas só até o próximo `process()`/`updateBackground()`. Quem precisar
 * guardá-las (o engine, ao criar um candidato) copia — ver [CrossingInput]. Isso elimina três cópias
 * da faixa por quadro a 240 Hz no caminho quente.
 */
class FrameMeasurement(
    val tsNs: Nanos,
    /** Timestamp do quadro de referência (c - lag), medido — não o nominal ts - lag·P. */
    val prevTsNs: Nanos,
    /** ΔY_f do enunciado: média de |Y_f - Y_ref| na faixa inteira. */
    val deltaFull: Double,
    /** Média de |Y_f - Y_ref| nas colunas centrais (gatilho). */
    val deltaCore: Double,
    /** Média de |Y_f - fundo| na faixa inteira (confirmação). */
    val deltaBackground: Double,
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

/**
 * Dados do candidato usados pelo estimador sub-quadro: cópias feitas ao criar o candidato
 * (os buffers do differencer rotacionam) mais os quadros c+lag e c+2·lag com seus timestamps
 * medidos.
 */
class CrossingInput(
    val tsNs: Nanos,
    val prevTsNs: Nanos,
    val stripPrev: IntArray,
    val stripCur: IntArray,
    val stripBg: DoubleArray,
    val lag: Int,
) {
    var nextTsNs: Nanos? = null
    var nextStrip: IntArray? = null
    var plateauTsNs: Nanos? = null
    var plateauStrip: IntArray? = null
}
