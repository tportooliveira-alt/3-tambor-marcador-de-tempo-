package br.com.tportooliveira.fotocelula.core

import java.nio.ByteBuffer

/**
 * Calcula a variação de luminância na faixa (ROI) a partir do plano Y de cada quadro.
 *
 * Mantém apenas as duas últimas faixas (c-1 e c-2) e as referências de fundo — nunca o quadro
 * inteiro. Todos os arrays são alocados uma vez no construtor e reutilizados: NÃO há alocação
 * por quadro no caminho quente. A [FrameMeasurement] devolvida referencia os buffers rotativos
 * (válidos até o próximo `process()`); quem precisa guardar as faixas copia (o engine, no candidato).
 *
 * Com `lag == 2` (flicker de 120 Hz a 240 FPS) a comparação é feita com o quadro de mesma
 * fase de iluminação e a referência de fundo é separada por paridade do quadro.
 */
class StripDifferencer(
    val roi: RoiRect,
    planeWidth: Int,
    val planeHeight: Int,
    val coreWidth: Int,
) {
    private val w = roi.width
    private val h = roi.height
    private val n = w * h
    private val c0 = (w - coreWidth) / 2

    var lag: Int = 1
        private set

    private var prev1: IntArray? = null
    private var prev2: IntArray? = null
    private var prev1Ts: Nanos = 0L
    private var prev2Ts: Nanos = 0L
    private val background = arrayOfNulls<DoubleArray>(2)
    private var frameIndex = 0

    // buffers rotativos para evitar alocação por quadro
    private val bufA = IntArray(n)
    private val bufB = IntArray(n)
    private val bufC = IntArray(n)
    private var nextBuf = 0

    init {
        roi.validate(planeWidth, planeHeight, coreWidth)
    }

    fun reset() {
        prev1 = null
        prev2 = null
        prev1Ts = 0L
        prev2Ts = 0L
        background[0] = null
        background[1] = null
        frameIndex = 0
    }

    fun setLag(newLag: Int) {
        val l = if (newLag == 2) 2 else 1
        if (l != lag) {
            // as referências acumuladas misturam fases de iluminação: ressemear por paridade
            background[0] = null
            background[1] = null
        }
        lag = l
    }

    private fun bgIndex(frameIdx: Int): Int = if (lag == 2) (frameIdx and 1) else 0

    private fun takeBuffer(): IntArray {
        val b = when (nextBuf) { 0 -> bufA; 1 -> bufB; else -> bufC }
        nextBuf = (nextBuf + 1) % 3
        return b
    }

    /**
     * Extrai a faixa do plano Y. [plane] é o buffer do plano 0 (posição absoluta),
     * [stride] = bytes por linha; Endereço(x, y) = y*stride + x.
     */
    private fun extract(plane: ByteBuffer, stride: Int, out: IntArray) {
        var k = 0
        for (y in roi.y0 until roi.y1) {
            val base = y * stride + roi.x
            for (i in 0 until w) {
                out[k++] = plane.get(base + i).toInt() and 0xFF
            }
        }
    }

    /** Retorna null para quadros-semente (1 com lag 1, 2 com lag 2). */
    fun process(plane: ByteBuffer, stride: Int, tsNs: Nanos): FrameMeasurement? {
        val cur = takeBuffer()
        extract(plane, stride, cur)
        val idxFrame = frameIndex
        frameIndex += 1
        val bi = bgIndex(idxFrame)
        if (background[bi] == null) {
            background[bi] = DoubleArray(n) { cur[it].toDouble() }
        }
        val ref = if (lag == 1) prev1 else prev2
        val refTs = if (lag == 1) prev1Ts else prev2Ts
        if (ref == null) {
            prev2 = prev1
            prev2Ts = prev1Ts
            prev1 = cur
            prev1Ts = tsNs
            return null
        }
        val bg = background[bi]!!
        var sumFull = 0L
        var sumCore = 0L
        var sumBg = 0.0
        for (row in 0 until h) {
            val o = row * w
            var rowSumCore = 0L
            for (i in 0 until w) {
                var d = cur[o + i] - ref[o + i]
                if (d < 0) d = -d
                sumFull += d
                sumBg += Math.abs(cur[o + i].toDouble() - bg[o + i])
            }
            for (i in c0 until c0 + coreWidth) {
                var d = cur[o + i] - ref[o + i]
                if (d < 0) d = -d
                rowSumCore += d
            }
            sumCore += rowSumCore
        }
        var lag2: Double? = null
        val p2 = prev2
        if (lag == 1 && p2 != null) {
            var s2 = 0L
            for (k in 0 until n) {
                var d = cur[k] - p2[k]
                if (d < 0) d = -d
                s2 += d
            }
            lag2 = s2.toDouble() / n
        }
        val m = FrameMeasurement(
            tsNs = tsNs,
            prevTsNs = refTs,
            deltaFull = sumFull.toDouble() / n,
            deltaCore = sumCore.toDouble() / (coreWidth * h),
            deltaBackground = sumBg / n,
            stripPrev = ref,
            stripCur = cur,
            stripBg = bg,
            deltaFullLag2 = lag2,
            lag = lag,
        )
        prev2 = prev1
        prev2Ts = prev1Ts
        prev1 = cur
        prev1Ts = tsNs
        return m
    }

    /** EMA lenta da referência de fundo (da paridade do último quadro) com a faixa atual. */
    fun updateBackground(alpha: Double) {
        val cur = prev1 ?: return
        val bg = background[bgIndex(frameIndex - 1)] ?: return
        for (i in 0 until n) {
            bg[i] = bg[i] + alpha * (cur[i].toDouble() - bg[i])
        }
    }
}
