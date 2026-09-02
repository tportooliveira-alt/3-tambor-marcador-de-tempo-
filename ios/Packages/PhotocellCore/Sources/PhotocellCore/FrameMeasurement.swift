import Foundation

/// Resultado do processamento de um quadro na faixa. Os vetores são cópias (W·H valores) —
/// nunca referências ao buffer da câmera.
public struct FrameMeasurement: Sendable {
    public var tsNs: Nanos
    /// ΔY_f do enunciado: média de |Y_f − Y_ref| na faixa inteira.
    public var deltaFull: Double
    /// Média de |Y_f − Y_ref| nas colunas centrais (gatilho).
    public var deltaCore: Double
    /// Média de |Y_f − fundo| na faixa inteira (confirmação).
    public var deltaBackground: Double
    /// Por linha da banda: média |Y_f − Y_ref| nas colunas centrais.
    public var rowCore: [Double]
    /// Faixa inteira (W×H, linha a linha) do quadro de referência (c − lag).
    public var stripPrev: [UInt8]
    /// Faixa inteira do quadro atual.
    public var stripCur: [UInt8]
    /// Faixa inteira da referência de fundo (mesma paridade quando lag == 2).
    public var stripBg: [Double]
    /// ΔY contra o quadro c−2 (para detectar flicker); nil se indisponível.
    public var deltaFullLag2: Double?
    /// Atraso de referência usado nesta medição (1 ou 2).
    public var lag: Int

    public init(tsNs: Nanos, deltaFull: Double, deltaCore: Double, deltaBackground: Double,
                rowCore: [Double], stripPrev: [UInt8], stripCur: [UInt8], stripBg: [Double],
                deltaFullLag2: Double?, lag: Int) {
        self.tsNs = tsNs; self.deltaFull = deltaFull; self.deltaCore = deltaCore
        self.deltaBackground = deltaBackground; self.rowCore = rowCore
        self.stripPrev = stripPrev; self.stripCur = stripCur; self.stripBg = stripBg
        self.deltaFullLag2 = deltaFullLag2; self.lag = lag
    }
}
