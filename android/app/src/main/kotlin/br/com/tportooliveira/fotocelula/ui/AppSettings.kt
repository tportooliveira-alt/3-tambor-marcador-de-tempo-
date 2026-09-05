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
    /** Exposição DESEJADA; a aplicada é lida da câmera após a trava e é ela que entra no estimador. */
    val exposureNs: Long = 2_083_333L,
    val startLockoutMs: Int = 1500,
    val frameResumeS: Float = 8.0f,
    val finishArmS: Float = 10.0f,
    val finishLockoutMs: Int = 2000,
    val confirmRequired: Int = 2,
    val flickerAuto: Boolean = true,
    val feedbackSound: Boolean = true,
    val feedbackFlash: Boolean = true,
    /** Curva de tom a desfazer antes da fração de exposição (1,0 = desligado; 2,2 para vídeo padrão). */
    val gamma: Float = 1.0f,
    /** Pasta escolhida pelo usuário para a cópia automática do histórico (SAF; vazio = desligado). */
    val backupTreeUri: String = "",
) {
    /**
     * Valores coerentes: faixa 5..40 px com núcleo ≤ faixa; linha e banda dentro da tela; janelas
     * na ordem exigida por [PhotocellConfig.validate] (retomada ≥ bloqueio + 0,5 s; chegada ≥ retomada + 0,5 s).
     */
    fun fix(): AppSettings {
        val strip = stripWidthPx.coerceIn(5, 40)
        val core = coreWidth.coerceIn(1, minOf(5, strip))
        val lineX = lineXFraction.coerceIn(0.02f, 0.98f)
        var top = bandTopFraction.coerceIn(0f, 0.97f)
        var bottom = bandBottomFraction.coerceIn(0.03f, 1f)
        if (bottom < top + 0.03f) { bottom = (top + 0.03f).coerceAtMost(1f); top = bottom - 0.03f }
        val expo = exposureNs.coerceIn(100_000L, 33_333_333L)
        val lockout = startLockoutMs.coerceIn(500, 5000)
        val finishLock = finishLockoutMs.coerceIn(500, 5000)
        val resume = frameResumeS.coerceIn(lockout / 1000f + 0.5f, 60f)
        val arm = finishArmS.coerceIn(resume + 0.5f, 60f)
        val confirm = confirmRequired.coerceIn(1, 4)
        val g = if (gamma > 0f) gamma.coerceIn(0.5f, 3f) else 1f
        return copy(stripWidthPx = strip, coreWidth = core, lineXFraction = lineX, bandTopFraction = top, bandBottomFraction = bottom,
            exposureNs = expo, startLockoutMs = lockout, frameResumeS = resume, finishArmS = arm, finishLockoutMs = finishLock,
            confirmRequired = confirm, gamma = g)
    }

    fun makeConfig(fps: Int, appliedExposureNs: Long, skewNs: Long? = null): PhotocellConfig = PhotocellConfig(
        frameRateHz = fps.coerceAtLeast(1),
        startLockoutNs = startLockoutMs * 1_000_000L,
        frameResumeNs = (frameResumeS * 1e9).toLong(),
        finishArmNs = (finishArmS * 1e9).toLong(),
        finishLockoutNs = finishLockoutMs * 1_000_000L,
        confirmRequired = confirmRequired,
        flickerAuto = flickerAuto,
        coreWidth = coreWidth,
        exposureNs = if (appliedExposureNs > 0) appliedExposureNs else exposureNs,
        calibrationSamples = fps.coerceAtLeast(1),          // 1 s de amostras em qualquer taxa
        skewNs = skewNs?.takeIf { it > 0 },
        gamma = gamma.toDouble(),
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
                gamma = p.getFloat("gamma", d.gamma),
                backupTreeUri = p.getString("backupTreeUri", d.backupTreeUri) ?: d.backupTreeUri,
            ).fix()
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
            .putFloat("gamma", gamma).putString("backupTreeUri", backupTreeUri)
            .apply()
    }
}
