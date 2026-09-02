package br.com.tportooliveira.fotocelula.core

import java.nio.ByteBuffer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** RNG determinístico (xorshift64*) — o mesmo do gerador Python, para cenas reproduzíveis. */
class Rng(seed: Long) {
    private var s: Long = if (seed == 0L) 0x9E3779B97F4A7C15uL.toLong() else seed
    fun nextU64(): Long {
        var x = s
        x = x xor (x ushr 12); x = x xor (x shl 25); x = x xor (x ushr 27)
        s = x
        return x * 2685821657736338717L // 0x2545F4914F6CDD1D
    }
    fun uniform(): Double = (nextU64() ushr 11).toDouble() / (1L shl 53).toDouble()
    fun gauss(sigma: Double): Double {
        val u1 = maxOf(uniform(), 1e-12)
        val u2 = uniform()
        return sigma * sqrt(-2.0 * ln(u1)) * cos(2.0 * PI * u2)
    }
}

/**
 * Cena sintética (porte fiel de Tools/gen_test_vectors.py): fundo estático com padrão espacial e
 * ruído gaussiano por quadro; objeto (luma alta) cujo bordo vertical cruza a faixa a velocidade
 * constante; rolling shutter linha a linha (skew) e integração da exposição (E).
 *
 * Efeitos "reais" opcionais: curva de tom (gamma), bordo inclinado (px por linha), textura presa ao
 * objeto (senoide em x e y, amplitude em níveis), flicker integrado ao longo da exposição e desfoque
 * (caixa de psf px, 5 amostras).
 */
class Scene(
    val planeWidth: Int, val stride: Int, val planeHeight: Int, val roi: RoiRect,
    val skewNs: Long, val exposureNs: Long, val periodNs: Long, val direction: Int,
    speedPxPerS: Double, val tCrossCenterNs: Long, val rowsA: Int, val rowsB: Int,
    val bgLevel: Int = 96, val objLevel: Int = 184, val noiseSigma: Double = 1.5,
    val flickerAmp: Double = 0.0, seed: Long = 1,
    val gamma: Double = 1.0, val tiltPxPerRow: Double = 0.0, val textureAmp: Double = 0.0,
    val flickerIntegrated: Boolean = false, val psfPx: Double = 0.0,
) {
    private val v = speedPxPerS / 1e9
    private val xc = roi.x + roi.width / 2
    private val rng = Rng(seed)

    fun edgeTimeAt(x: Int): Double = tCrossCenterNs + (x - xc) * direction / v
    private fun edgeTimeAtX(xe: Double): Double = tCrossCenterNs + (xe - xc) * direction / v

    /** Linhas y0..y1 da faixa (height*stride bytes), preenchimento 0xEE fora das colunas do plano. */
    fun frameBytes(tFrame: Long): ByteArray {
        val buf = ByteArray(stride * roi.height) { 0xEE.toByte() }
        val mid = (rowsA + rowsB) / 2.0
        for (row in 0 until roi.height) {
            val g = roi.y0 + row
            val tRow = tFrame + (g.toLong() * skewNs) / planeHeight
            val flick = if (flickerIntegrated && flickerAmp > 0.0) {
                val wf = 2.0 * PI * 120.0 / 1e9
                1.0 + flickerAmp * (cos(wf * tRow) - cos(wf * (tRow + exposureNs))) / (wf * exposureNs)
            } else {
                1.0 + flickerAmp * sin(2.0 * PI * 120.0 * (tRow / 1e9))
            }
            for (x in 0 until planeWidth) {
                val base = bgLevel + ((x * 7 + g * 3) % 11)
                var frac = 0.0
                if (g in rowsA..rowsB) {
                    val xe = x - (g - mid) * tiltPxPerRow
                    if (psfPx > 0.0) {
                        var acc = 0.0
                        for (k in 0 until 5) {
                            val xk = xe + (k - 2.0) * psfPx / 4.0
                            val fk = (tRow + exposureNs - edgeTimeAtX(xk)) / exposureNs
                            acc += if (fk < 0.0) 0.0 else if (fk > 1.0) 1.0 else fk
                        }
                        frac = acc / 5.0
                    } else {
                        frac = ((tRow + exposureNs - edgeTimeAtX(xe)) / exposureNs).coerceIn(0.0, 1.0)
                    }
                }
                var obj = objLevel.toDouble()
                if (textureAmp > 0.0) {
                    // textura presa ao objeto: fase relativa ao bordo (px atrás do bordo no meio da exposição)
                    val rel = (x - xc) * direction - (tRow + exposureNs / 2.0 - tCrossCenterNs) * v
                    obj = objLevel + textureAmp * sin(rel * 0.9 + g * 0.3)
                }
                val lin = base + (obj - base) * frac
                val shaped = if (gamma != 1.0) 255.0 * ((if (lin > 0.0) lin else 0.0) / 255.0).pow(1.0 / gamma) else lin
                val value = shaped * flick + rng.gauss(noiseSigma)
                buf[row * stride + x] = floor(value + 0.5).toInt().coerceIn(0, 255).toByte()
            }
        }
        return buf
    }
}

/** Resultado de uma simulação completa do pipeline (differencer → calibração → engine → estimador). */
data class SimulationResult(
    val triggered: Boolean,
    val rawErrorNs: Long,
    val refinedErrorNs: Long,
    val quality: Int,
    val uncertaintyNs: Long,
    val lag: Int,
    val threshold: Double,
    val finalState: PhotocellState,
    val texturedColumns: Int = 0,
)

/** Harness idêntico ao do gerador: aplica os efeitos do engine ao differencer. */
object SimulationHarness {
    fun applyEffects(eng: PhotocellEngine, diff: StripDifferencer, cfg: PhotocellConfig) {
        for (e in eng.effects) {
            when (e) {
                Effect.ResetDifferencer -> diff.reset()
                Effect.UpdateBackground -> diff.updateBackground(cfg.backgroundEmaAlpha)
                is Effect.SetReferenceLag -> diff.setLag(e.lag)
                else -> Unit
            }
        }
        eng.effects.clear()
    }

    /**
     * Cruzamento único: calibração (32 amostras), quadros parados, cruzamento e passagem.
     * Devolve o erro do gatilho contra a verdade da cena.
     */
    fun runCrossing(
        speedMs: Double, exposureNs: Long, noiseSigma: Double, direction: Int, crossFraction: Double,
        objLevel: Int, flicker: Double, seed: Long, dropFrames: Set<Int> = emptySet(), mmPerPx: Double = 6.0,
        skewNs: Long = 3_200_000L, knownSkew: Boolean = true, stripWidth: Int = 15,
        texture: Double = 0.0, sceneGamma: Double = 1.0, cfgGamma: Double = 1.0, tilt: Double = 0.0, psf: Double = 0.0,
    ): SimulationResult {
        val cfg = PhotocellConfig(calibrationSamples = 32, calibrationMinSamplesForOutlier = 8,
            skewNs = if (knownSkew) skewNs else null, exposureNs = exposureNs, gamma = cfgGamma)
        val period = cfg.framePeriodNs
        val planeWidth = 32; val stride = 40; val planeHeight = 720
        val roi = RoiRect(8, stripWidth, 300, 396)
        val speedPx = speedMs * 1000.0 / mmPerPx
        val nPre = 1 + cfg.calibrationSamples + 12
        val t0 = 1_000_000_000_000L
        val crossFrame = nPre + 3
        val tCross = t0 + crossFrame * period + (crossFraction * period).toLong()
        val scene = Scene(planeWidth, stride, planeHeight, roi, skewNs, exposureNs, period, direction, speedPx, tCross,
            roi.y0 + 12, roi.y1 - 1 - 12, objLevel = objLevel, noiseSigma = noiseSigma, flickerAmp = flicker, seed = seed,
            gamma = sceneGamma, tiltPxPerRow = tilt, textureAmp = texture, psfPx = psf)
        val diff = StripDifferencer(roi, planeWidth, planeHeight, cfg.coreWidth)
        val eng = PhotocellEngine(cfg, roi, planeHeight)
        val plane = ByteArray(stride * planeHeight) { 0xEE.toByte() }
        eng.userArm(); applyEffects(eng, diff, cfg)
        for (i in 0 until crossFrame + 10) {
            if (i in dropFrames) continue
            val ts = t0 + i * period
            val band = scene.frameBytes(ts)
            System.arraycopy(band, 0, plane, roi.y0 * stride, band.size)
            val m = diff.process(ByteBuffer.wrap(plane), stride, ts)
            if (m == null) eng.frame(null, ts) else eng.frame(m)
            applyEffects(eng, diff, cfg)
        }
        val st = eng.start
        // sem skew conhecido a verdade carrega o offset médio das linhas da banda (cancela em ΔT)
        val rowOffset = if (knownSkew) 0L else (roi.y0 until roi.y1).sumOf { (it.toLong() * skewNs) / planeHeight } / roi.height
        return if (st == null) SimulationResult(false, 0, 0, 0, 0, eng.lag, eng.threshold ?: 0.0, eng.state)
        else SimulationResult(true, st.rawTsNs - tCross, st.refinedTsNs + rowOffset - tCross, st.quality, st.uncertaintyNs,
            eng.lag, eng.threshold ?: 0.0, eng.state, st.texturedColumns)
    }
}
