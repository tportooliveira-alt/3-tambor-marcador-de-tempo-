package br.com.tportooliveira.fotocelula.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer

/** Testes unitários locais do differencer (stride, sentinela, semente, ROI nos limites). */
class StripDifferencerTest {
    private val planeW = 32
    private val planeH = 64
    private val stride = 40   // > largura: bytes de preenchimento nunca podem ser lidos

    private fun plane(fill: Int, bandFill: Int? = null, roi: RoiRect? = null): ByteBuffer {
        val b = ByteArray(stride * planeH) { 0xEE.toByte() }
        for (y in 0 until planeH) for (x in 0 until planeW) b[y * stride + x] = fill.toByte()
        if (bandFill != null && roi != null) {
            for (y in roi.y0 until roi.y1) for (x in roi.x until roi.x + roi.width) b[y * stride + x] = bandFill.toByte()
        }
        return ByteBuffer.wrap(b)
    }

    @Test
    fun seedThenExactDifference() {
        val roi = RoiRect(x = 10, width = 9, y0 = 8, y1 = 40)
        val d = StripDifferencer(roi, planeW, planeH, 3)
        assertNull(d.process(plane(16), stride, 0L))
        val m = d.process(plane(26), stride, 4_166_666L)
        assertNotNull(m)
        assertEquals(10.0, m!!.deltaFull, 1e-12)
        assertEquals(10.0, m.deltaCore, 1e-12)
        assertEquals(10.0, m.deltaBackground, 1e-12)
        assertEquals(0L, m.prevTsNs, "timestamp do quadro de referência")
    }

    @Test
    fun sentinelPaddingIsNeverRead() {
        val roi = RoiRect(x = planeW - 9, width = 9, y0 = 0, y1 = planeH)   // encostada na borda direita
        val d = StripDifferencer(roi, planeW, planeH, 3)
        d.process(plane(50), stride, 0L)
        val m = d.process(plane(50), stride, 1L)!!
        assertEquals(0.0, m.deltaFull, 0.0)
    }

    @Test
    fun halfRowsChanged() {
        val roi = RoiRect(x = 0, width = 5, y0 = 0, y1 = 10)
        val d = StripDifferencer(roi, planeW, planeH, 1)
        d.process(plane(100), stride, 0L)
        val half = RoiRect(x = 0, width = 5, y0 = 0, y1 = 5)
        val m = d.process(plane(100, 120, half), stride, 1L)!!
        assertEquals(10.0, m.deltaFull, 1e-12)
    }

    @Test
    fun resetReseeds() {
        val roi = RoiRect(x = 4, width = 7, y0 = 4, y1 = 20)
        val d = StripDifferencer(roi, planeW, planeH, 3)
        d.process(plane(10), stride, 0L)
        assertNotNull(d.process(plane(10), stride, 1L))
        d.reset()
        assertNull(d.process(plane(10), stride, 2L))
    }

    @Test
    fun lagTwoNeedsTwoSeeds() {
        val roi = RoiRect(x = 4, width = 7, y0 = 4, y1 = 20)
        val d = StripDifferencer(roi, planeW, planeH, 3)
        d.setLag(2)
        assertNull(d.process(plane(10), stride, 0L))
        assertNull(d.process(plane(12), stride, 1L))
        val m = d.process(plane(13), stride, 2L)!!
        assertEquals(3.0, m.deltaFull, 1e-12)   // compara com o quadro c-2 (10)
        assertEquals(2, m.lag)
    }

    @Test
    fun invalidRoiRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            StripDifferencer(RoiRect(x = 30, width = 9, y0 = 0, y1 = 10), planeW, planeH, 3)
        }
        assertThrows(IllegalArgumentException::class.java) {
            StripDifferencer(RoiRect(x = 0, width = 3, y0 = 0, y1 = 10), planeW, planeH, 5)
        }
    }
}
