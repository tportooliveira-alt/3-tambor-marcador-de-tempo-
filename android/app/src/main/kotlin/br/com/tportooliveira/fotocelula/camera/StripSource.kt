package br.com.tportooliveira.fotocelula.camera

import java.nio.ByteBuffer

/**
 * Entrega de um quadro (só a luminância) para o processamento: [plane] com posição absoluta,
 * [stride] bytes por linha e o timestamp do sensor. Para o leitor GL, o plano contém apenas a
 * faixa (planeHeight = altura da banda, ROI local em x=0,y0=0); para o ImageReader, o plano Y inteiro.
 */
interface StripSink {
    fun onFrame(plane: ByteBuffer, stride: Int, planeWidth: Int, planeHeight: Int, tsNs: Long, localRoi: Boolean)
    fun onDropped()
}

/** Região de interesse em coordenadas normalizadas do buffer do sensor (imagem não rotacionada). */
data class NormalizedRoi(
    val centerX: Double = 0.5,
    val top: Double = 0.25,
    val bottom: Double = 0.75,
    val widthPx: Int = 15,
) {
    /**
     * Conversão ÚNICA para pixels (usada pelo leitor GL e pelo serviço, para que os dois
     * concordem exatamente no tamanho da faixa). Truncamento, nunca arredondamento.
     */
    fun toPixels(sensorWidth: Int, sensorHeight: Int): br.com.tportooliveira.fotocelula.core.RoiRect {
        val w = widthPx.coerceIn(1, sensorWidth)
        val y0 = (top * sensorHeight).toInt().coerceIn(0, sensorHeight - 1)
        val y1 = (bottom * sensorHeight).toInt().coerceIn(y0 + 1, sensorHeight)
        var x0 = (centerX * sensorWidth).toInt() - w / 2
        x0 = x0.coerceIn(0, sensorWidth - w)
        return br.com.tportooliveira.fotocelula.core.RoiRect(x0, w, y0, y1)
    }
}
