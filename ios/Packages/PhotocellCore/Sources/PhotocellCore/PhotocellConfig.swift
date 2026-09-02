import Foundation

/// Todos os parâmetros ajustáveis do algoritmo. Os valores padrão são os da especificação
/// (lockouts de 1,5 s / 2,0 s, janela cega até 10,0 s) e da referência Python
/// (Tools/photocell_reference.py) — mantenha os três (Python, Kotlin, Swift) em sincronia.
public struct PhotocellConfig: Equatable, Sendable {
    public var frameRateHz: Int = 240
    /// DEBOUNCE_START: janela de bloqueio após a largada.
    public var startLockoutNs: Nanos = 1_500_000_000
    /// RUNNING: instante (relativo à largada) em que o pipeline volta a receber quadros (só ressemeia).
    public var frameResumeNs: Nanos = 8_000_000_000
    /// RUNNING → AWAITING_FINISH: instante em que a detecção da chegada é armada.
    public var finishArmNs: Nanos = 10_000_000_000
    /// DEBOUNCE_FINISH: janela de bloqueio após a chegada.
    public var finishLockoutNs: Nanos = 2_000_000_000
    public var calibrationSamples: Int = 240
    public var calibrationMinSamplesForOutlier: Int = 30
    public var calibrationOutlierSigma: Double = 10.0
    public var calibrationMaxRetries: Int = 3
    public var thresholdFloor: Double = 4.0
    public var thresholdSigmaK: Double = 6.0
    public var thresholdMeanMultiplier: Double = 2.0
    public var confirmWindow: Int = 4
    public var confirmRequired: Int = 2
    public var backgroundThresholdMultiplier: Double = 1.0
    public var backgroundEmaAlpha: Double = 0.02
    public var dropGapFactor: Double = 1.5
    public var degradedDropWindowNs: Nanos = 50_000_000
    /// Colunas centrais da faixa usadas para o gatilho (o "plano" da fotocélula).
    public var coreWidth: Int = 3
    /// Duração de exposição REAL aplicada pela câmera (lida do aparelho após a trava; 1/480 s por padrão).
    public var exposureNs: Nanos = 2_083_333
    /// |O − B| mínimo (níveis de luma) para um pixel participar do refinamento sub-quadro.
    public var minContrast: Double = 20.0
    public var fractionMarginMin: Double = 0.03
    public var fractionMarginSigmas: Double = 4.0
    /// Acima desta margem (contraste/ruído baixo) o pixel só fornece limites.
    public var fractionMarginMax: Double = 0.25
    /// Piso da incerteza reportada em qualidade 2 (erro de modelo: gamma desconhecida, desfoque).
    public var systematicUncNs: Nanos = 100_000
    /// Pixels saturados (ou pretos) não seguem V = B + (O−B)f: ficam fora do ajuste e dos limites.
    public var saturationLow: Int = 5
    public var saturationHigh: Int = 250
    /// Bordo inclinado (celular fora de nível): folga do limite superior do intervalo de qualidade 0.
    public var q0TiltAllowancePxPerRow: Double = 0.05
    /// Faixa plausível de velocidade do bordo, em px/s: 5 m/s a 12 mm/px até 20 m/s a ~1,7 mm/px (câmera
    /// perto). Um ajuste com inclinação fora dela é rejeitado; o fallback de 1 coluna usa a faixa inteira.
    public var speedPxPerSMin: Double = 400.0
    public var speedPxPerSMax: Double = 12000.0
    /// Uma coluna só participa do ajuste com pelo menos N linhas interiores.
    public var minInteriorRowsPerColumn: Int = 3
    /// ... e pelo menos esta fração das linhas da banda.
    public var minInteriorRowsFraction: Double = 0.08
    /// Tempo de leitura do sensor (rolling shutter). nil = ignora o offset por linha (cancela em ΔT).
    public var skewNs: Nanos? = nil
    public var readoutTopToBottom: Bool = true
    /// Se ΔY(lag 2) < ratio·ΔY(lag 1) na calibração, usa o quadro c−2 como referência (flicker 120 Hz).
    public var flickerRatio: Double = 0.5
    public var flickerAuto: Bool = true
    /// Curva de tom a desfazer antes da fração f (1.0 = desligado; ~2.2 para vídeo com tone curve padrão).
    public var gamma: Double = 1.0

    public init() {}

    public var framePeriodNs: Nanos { nsPerSecond / Int64(frameRateHz) }

    public enum ValidationError: Error, Equatable {
        case invalidFrameRate
        case frameResumeBeforeLockoutEnds
        case finishArmBeforeFrameResume
        case invalidExposureOrGamma
    }

    /// Janelas coerentes: os quadros voltam depois do bloqueio e a chegada arma depois de voltarem.
    public func validate() throws {
        if frameRateHz < 1 { throw ValidationError.invalidFrameRate }
        if frameResumeNs < startLockoutNs + 500_000_000 { throw ValidationError.frameResumeBeforeLockoutEnds }
        if finishArmNs < frameResumeNs + 500_000_000 { throw ValidationError.finishArmBeforeFrameResume }
        if exposureNs < 1 || gamma <= 0.0 { throw ValidationError.invalidExposureOrGamma }
    }
}
