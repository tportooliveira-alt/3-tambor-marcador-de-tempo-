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
    /// Duração de exposição fixa configurada na câmera (1/480 s por padrão).
    public var exposureNs: Nanos = 2_083_333
    /// |O − B| mínimo (níveis de luma) para um pixel participar do refinamento sub-quadro.
    public var minContrast: Double = 20.0
    public var fractionMarginMin: Double = 0.03
    public var fractionMarginSigmas: Double = 4.0
    /// Acima desta margem (contraste/ruído baixo) o pixel só fornece limites.
    public var fractionMarginMax: Double = 0.25
    /// Faixa plausível de velocidade do bordo, em px/s (fallback quando só uma coluna é interior).
    public var speedPxPerSMin: Double = 800.0
    public var speedPxPerSMax: Double = 4000.0
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

    public init() {}

    public var framePeriodNs: Nanos { nsPerSecond / Int64(frameRateHz) }
}
