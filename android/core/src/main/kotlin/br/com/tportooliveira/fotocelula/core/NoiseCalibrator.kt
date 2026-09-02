package br.com.tportooliveira.fotocelula.core

import kotlin.math.sqrt

/** Média/variância incremental (Welford). */
class NoiseStats {
    var count: Int = 0
        private set
    var mean: Double = 0.0
        private set
    private var m2: Double = 0.0

    fun add(x: Double) {
        count += 1
        val delta = x - mean
        mean += delta / count
        m2 += delta * (x - mean)
    }

    val variance: Double get() = if (count > 1) m2 / (count - 1) else 0.0
    val sigma: Double get() = sqrt(variance)
}

enum class CalibrationStep { COLLECTING, RESTARTED, DONE, FAILED }

fun computeThreshold(cfg: PhotocellConfig, mean: Double, sigma: Double): Double =
    maxOf(cfg.thresholdFloor, mean + cfg.thresholdSigmaK * sigma, cfg.thresholdMeanMultiplier * mean)

/**
 * Coleta N amostras de ΔY com a pista vazia; um outlier (> μ + kσ) reinicia a coleta
 * (até [PhotocellConfig.calibrationMaxRetries] vezes) e o limiar adaptativo é
 * max(piso, μ + kσ, m·μ).
 */
class NoiseCalibrator(private val cfg: PhotocellConfig) {
    var stats = NoiseStats()
        private set
    var retries = 0
        private set
    var threshold: Double? = null
        private set
    var failed = false
        private set

    fun reset() {
        stats = NoiseStats()
        retries = 0
        threshold = null
        failed = false
    }

    fun addSample(x: Double): CalibrationStep {
        if (threshold != null) return CalibrationStep.DONE
        if (failed) return CalibrationStep.FAILED
        val s = stats
        if (s.count >= cfg.calibrationMinSamplesForOutlier) {
            if (x > s.mean + cfg.calibrationOutlierSigma * s.sigma) {
                retries += 1
                stats = NoiseStats()
                if (retries > cfg.calibrationMaxRetries) {
                    failed = true
                    return CalibrationStep.FAILED
                }
                return CalibrationStep.RESTARTED
            }
        }
        s.add(x)
        if (s.count >= cfg.calibrationSamples) {
            threshold = computeThreshold(cfg, s.mean, s.sigma)
            return CalibrationStep.DONE
        }
        return CalibrationStep.COLLECTING
    }
}
