package br.com.tportooliveira.fotocelula.core

/**
 * Todos os parâmetros ajustáveis do algoritmo. Os valores padrão são os da especificação
 * (lockouts de 1,5 s / 2,0 s, janela cega até 10,0 s) e da referência Python
 * (Tools/photocell_reference.py) — mantenha os dois em sincronia.
 */
data class PhotocellConfig(
    val frameRateHz: Int = 240,
    /** DEBOUNCE_START: janela de bloqueio após a largada. */
    val startLockoutNs: Nanos = 1_500_000_000L,
    /** RUNNING: instante (relativo à largada) em que o pipeline volta a receber quadros, só para ressemear. */
    val frameResumeNs: Nanos = 8_000_000_000L,
    /** RUNNING -> AWAITING_FINISH: instante em que a detecção da chegada é armada. */
    val finishArmNs: Nanos = 10_000_000_000L,
    /** DEBOUNCE_FINISH: janela de bloqueio após a chegada. */
    val finishLockoutNs: Nanos = 2_000_000_000L,
    val calibrationSamples: Int = 240,
    val calibrationMinSamplesForOutlier: Int = 30,
    val calibrationOutlierSigma: Double = 10.0,
    val calibrationMaxRetries: Int = 3,
    val thresholdFloor: Double = 4.0,
    val thresholdSigmaK: Double = 6.0,
    val thresholdMeanMultiplier: Double = 2.0,
    val confirmWindow: Int = 4,
    val confirmRequired: Int = 2,
    val backgroundThresholdMultiplier: Double = 1.0,
    val backgroundEmaAlpha: Double = 0.02,
    val dropGapFactor: Double = 1.5,
    val degradedDropWindowNs: Nanos = 50_000_000L,
    /** Colunas centrais da faixa usadas para o gatilho (o "plano" da fotocélula). */
    val coreWidth: Int = 3,
    /** Duração de exposição REAL aplicada pela câmera (lida do aparelho após a trava; 1/480 s por padrão). */
    val exposureNs: Nanos = 2_083_333L,
    /** |O - B| mínimo (níveis de luma) para um pixel participar do refinamento sub-quadro. */
    val minContrast: Double = 20.0,
    val fractionMarginMin: Double = 0.03,
    val fractionMarginSigmas: Double = 4.0,
    /** Acima desta margem (contraste/ruído baixo) o pixel só fornece limites. */
    val fractionMarginMax: Double = 0.25,
    /** Piso da incerteza reportada em qualidade 2 (erro de modelo: gamma desconhecida, desfoque). */
    val systematicUncNs: Nanos = 100_000L,
    /** Pixels saturados (ou pretos) não seguem V = B + (O−B)f: ficam fora do ajuste e dos limites. */
    val saturationLow: Int = 5,
    val saturationHigh: Int = 250,
    /** Bordo inclinado (celular fora de nível): folga do limite superior do intervalo de qualidade 0. */
    val q0TiltAllowancePxPerRow: Double = 0.05,
    /**
     * Abertura efetiva de um pixel do plano de luma (o pixel integra área; demosaico e reamostragem
     * alargam mais). Enquanto o bordo atravessa essa abertura a resposta não é linear em f: com as
     * amostras concentradas num extremo da rampa sobra um viés comum, invisível nos resíduos,
     * limitado pelo tempo que o bordo leva para atravessar a abertura.
     */
    val aperturePx: Double = 1.5,
    /**
     * Faixa plausível de velocidade do bordo, em px/s: 5 m/s a 12 mm/px até 20 m/s a ~1,7 mm/px (câmera
     * perto). Um ajuste com inclinação fora dela é rejeitado; o fallback de 1 coluna usa a faixa inteira.
     */
    val speedPxPerSMin: Double = 400.0,
    val speedPxPerSMax: Double = 12000.0,
    /** Uma coluna só participa do ajuste com pelo menos N linhas interiores. */
    val minInteriorRowsPerColumn: Int = 3,
    /** ... e pelo menos esta fração das linhas da banda. */
    val minInteriorRowsFraction: Double = 0.08,
    /** Tempo de leitura do sensor (rolling shutter). null = ignora o offset por linha (cancela em ΔT). */
    val skewNs: Nanos? = null,
    val readoutTopToBottom: Boolean = true,
    /** Se ΔY(lag 2) < ratio * ΔY(lag 1) na calibração, usa o quadro c-2 como referência (flicker 120 Hz). */
    val flickerRatio: Double = 0.5,
    val flickerAuto: Boolean = true,
    /** Curva de tom a desfazer antes da fração f (1.0 = desligado; ~2.2 para vídeo com tone curve padrão). */
    val gamma: Double = 1.0,
) {
    val framePeriodNs: Nanos get() = NS_PER_SEC / frameRateHz

    /** Janelas coerentes: os quadros voltam depois do bloqueio e a chegada arma depois de voltarem. */
    fun validate() {
        require(frameRateHz >= 1) { "frameRateHz inválido" }
        require(frameResumeNs >= startLockoutNs + 500_000_000L) { "frameResumeNs precisa ser >= startLockoutNs + 0,5 s" }
        require(finishArmNs >= frameResumeNs + 500_000_000L) { "finishArmNs precisa ser >= frameResumeNs + 0,5 s" }
        require(exposureNs >= 1L && gamma > 0.0) { "exposureNs/gamma inválidos" }
        // sob flicker de 120 Hz a referência vai para o quadro c−2 e o platô só chega em seen == 4:
        // com uma janela menor o gatilho seria impossível (silenciosamente) nessa iluminação
        require(confirmWindow >= 4) { "confirmWindow precisa ser >= 4 (platô do estimador com lag 2)" }
        require(confirmRequired in 1..confirmWindow) { "confirmRequired precisa estar entre 1 e confirmWindow" }
    }
}
