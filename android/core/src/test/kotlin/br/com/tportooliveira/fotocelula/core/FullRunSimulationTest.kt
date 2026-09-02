package br.com.tportooliveira.fotocelula.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.ByteBuffer
import kotlin.math.abs

/**
 * Prova completa simulada com pixels sintéticos: largada (cavalo entrando pela esquerda), janela
 * cega, retomada aos 8 s, chegada aos ~12,3 s (cavalo voltando pela direita), lockout e resultado.
 * O ΔT refinado precisa bater com a verdade da cena com erro < 0,2 ms.
 */
class FullRunSimulationTest {
    @Test
    fun fullRunElapsedMatchesGroundTruth() {
        val cfg = PhotocellConfig(calibrationSamples = 32, calibrationMinSamplesForOutlier = 8, skewNs = 3_200_000L, exposureNs = 2_083_333L)
        val p = cfg.framePeriodNs
        val planeWidth = 24; val stride = 32; val planeHeight = 720
        val roi = RoiRect(8, 9, 300, 396)
        val speedPx = 14.0 * 1000.0 / 6.0
        val t0 = 500_000_000_000L
        // largada no quadro 60 (fração 0,41), chegada 12,3 s depois (fração diferente)
        val startFrame = 60
        val tStart = t0 + startFrame * p + (0.41 * p).toLong()
        val finishOffset = 12_300_000_000L + 1_234_567L
        val tFinish = tStart + finishOffset
        val sceneStart = Scene(planeWidth, stride, planeHeight, roi, 3_200_000L, cfg.exposureNs, p, +1, speedPx, tStart, 312, 383, seed = 5)
        val sceneFinish = Scene(planeWidth, stride, planeHeight, roi, 3_200_000L, cfg.exposureNs, p, -1, speedPx, tFinish, 312, 383, seed = 6)
        val diff = StripDifferencer(roi, planeWidth, planeHeight, cfg.coreWidth)
        val eng = PhotocellEngine(cfg, roi, planeHeight)
        val plane = ByteArray(stride * planeHeight) { 0xEE.toByte() }
        fun feed(scene: Scene, ts: Long) {
            val band = scene.frameBytes(ts)
            System.arraycopy(band, 0, plane, roi.y0 * stride, band.size)
            val m = diff.process(ByteBuffer.wrap(plane), stride, ts)
            if (m == null) eng.frame(null, ts) else eng.frame(m)
            SimulationHarness.applyEffects(eng, diff, cfg)
        }
        eng.userArm(); SimulationHarness.applyEffects(eng, diff, cfg)
        // calibração + parado + largada + passagem
        for (i in 0 until startFrame + 12) feed(sceneStart, t0 + i * p)
        assertEquals(PhotocellState.DEBOUNCE_START, eng.state, "largada não detectada")
        assertNotNull(eng.start); val start = eng.start!!
        // lockout e janela cega (os quadros estão desligados: só wake-ups)
        eng.wakeup(start.rawTsNs + cfg.startLockoutNs); SimulationHarness.applyEffects(eng, diff, cfg)
        assertEquals(PhotocellState.RUNNING, eng.state)
        eng.wakeup(start.rawTsNs + cfg.frameResumeNs); SimulationHarness.applyEffects(eng, diff, cfg)
        // retomada: quadros parados a partir de 8 s (ressemeiam) até a chegada
        var ts = start.rawTsNs + cfg.frameResumeNs + p
        val quiet = Scene(planeWidth, stride, planeHeight, roi, 3_200_000L, cfg.exposureNs, p, +1, speedPx, tFinish + 100_000_000_000L, 312, 383, seed = 9)
        while (ts < tFinish - 6 * p) { feed(quiet, ts); ts += p }
        assertEquals(PhotocellState.AWAITING_FINISH, eng.state, "chegada não foi armada aos 10 s")
        // chegada: alinhar os quadros ao mesmo grid de tempo
        repeat(14) { feed(sceneFinish, ts); ts += p }
        assertEquals(PhotocellState.DEBOUNCE_FINISH, eng.state, "chegada não detectada")
        assertNotNull(eng.finish); val finish = eng.finish!!
        eng.wakeup(finish.rawTsNs + cfg.finishLockoutNs); SimulationHarness.applyEffects(eng, diff, cfg)
        assertEquals(PhotocellState.FINISHED, eng.state)
        assertNotNull(eng.result); val res = eng.result!!
        val errRefined = res.elapsedRefinedNs - finishOffset
        val errRaw = res.elapsedRawNs - finishOffset
        println("[FullRun] ΔT verdade=${finishOffset} refinado erro=${errRefined / 1e6} ms bruto erro=${errRaw / 1e6} ms q=${res.start.quality}/${res.finish.quality}")
        assertEquals(2, res.start.quality); assertEquals(2, res.finish.quality)
        assertTrue(abs(errRefined) < 200_000, "erro refinado ${errRefined / 1e6} ms")
        assertTrue(abs(errRaw) <= 2 * p, "erro bruto ${errRaw / 1e6} ms")
        assertEquals("12.301", TimeFormatter.formatElapsed(res.elapsedRefinedNs))
    }
}
