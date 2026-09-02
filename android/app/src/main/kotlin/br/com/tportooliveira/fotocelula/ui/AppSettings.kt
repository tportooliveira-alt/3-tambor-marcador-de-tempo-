package br.com.tportooliveira.fotocelula.ui

import android.content.Context
import br.com.tportooliveira.fotocelula.core.PhotocellConfig

/** Configurações persistidas (SharedPreferences). Padrões = especificação + decisões do estudo. */
data class AppSettings(
    val stripWidthPx: Int = 15,
    val coreWidth: Int = 3,
    val lineXFraction: Float = 0.5f,
    val bandTopFraction: Float = 0.25f,
    val bandBottomFraction: Float = 0.75f,
    val exposureNs: Long = 2_083_333L,
    val startLockoutMs: Int = 1500,
    val frameResumeS: Float = 8.0f,
    val finishArmS: Float = 10.0f,
    val finishLockoutMs: Int = 2000,
    val confirmRequired: Int = 2,
    val flickerAuto: Boolean = true,
    val feedbackSound: Boolean = true,
    val feedbackFlash: Boolean = true,
) {
    fun makeConfig(fps: Int, appliedExposureNs: Long): PhotocellConfig = PhotocellConfig(
        frameRateHz = fps,
        startLockoutNs = startLockoutMs * 1_000_000L,
        frameResumeNs = (frameResumeS * 1e9).toLong(),
        finishArmNs = (finishArmS * 1e9).toLong(),
        finishLockoutNs = finishLockoutMs * 1_000_000L,
        confirmRequired = confirmRequired,
        flickerAuto = flickerAuto,
        coreWidth = coreWidth,
        exposureNs = if (appliedExposureNs > 0) appliedExposureNs else exposureNs,
        calibrationSamples = fps,          // 1 s de amostras em qualquer taxa
    )

    companion object {
        val exposureChoices = listOf(
            "1/240 s (sem janela cega, mais blur)" to 4_166_666L,
            "1/480 s (padrão)" to 2_083_333L,
            "1/1000 s" to 1_000_000L,
            "1/2000 s (sol forte)" to 500_000L,
            "1/4000 s" to 250_000L,
        )

        fun load(ctx: Context): AppSettings {
            val p = ctx.getSharedPreferences("fotocelula", Context.MODE_PRIVATE)
            val d = AppSettings()
            return AppSettings(
                stripWidthPx = p.getInt("stripWidthPx", d.stripWidthPx),
                coreWidth = p.getInt("coreWidth", d.coreWidth),
                lineXFraction = p.getFloat("lineX", d.lineXFraction),
                bandTopFraction = p.getFloat("bandTop", d.bandTopFraction),
                bandBottomFraction = p.getFloat("bandBottom", d.bandBottomFraction),
                exposureNs = p.getLong("exposureNs", d.exposureNs),
                startLockoutMs = p.getInt("startLockoutMs", d.startLockoutMs),
                frameResumeS = p.getFloat("frameResumeS", d.frameResumeS),
                finishArmS = p.getFloat("finishArmS", d.finishArmS),
                finishLockoutMs = p.getInt("finishLockoutMs", d.finishLockoutMs),
                confirmRequired = p.getInt("confirmRequired", d.confirmRequired),
                flickerAuto = p.getBoolean("flickerAuto", d.flickerAuto),
                feedbackSound = p.getBoolean("feedbackSound", d.feedbackSound),
                feedbackFlash = p.getBoolean("feedbackFlash", d.feedbackFlash),
            )
        }
    }

    fun save(ctx: Context) {
        ctx.getSharedPreferences("fotocelula", Context.MODE_PRIVATE).edit()
            .putInt("stripWidthPx", stripWidthPx).putInt("coreWidth", coreWidth)
            .putFloat("lineX", lineXFraction).putFloat("bandTop", bandTopFraction).putFloat("bandBottom", bandBottomFraction)
            .putLong("exposureNs", exposureNs).putInt("startLockoutMs", startLockoutMs)
            .putFloat("frameResumeS", frameResumeS).putFloat("finishArmS", finishArmS).putInt("finishLockoutMs", finishLockoutMs)
            .putInt("confirmRequired", confirmRequired).putBoolean("flickerAuto", flickerAuto)
            .putBoolean("feedbackSound", feedbackSound).putBoolean("feedbackFlash", feedbackFlash)
            .apply()
    }
}
