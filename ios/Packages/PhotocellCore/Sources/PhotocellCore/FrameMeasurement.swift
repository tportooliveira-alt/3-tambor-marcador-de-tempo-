import Foundation

/// Resultado do processamento de um quadro na faixa.
///
/// ATENÇÃO: `stripPrev`, `stripCur` e `stripBg` são VISTAS (`UnsafeBufferPointer`) sobre os buffers
/// rotativos do `StripDifferencer`, válidas só até o próximo `process()`/`updateBackground()`. Quem
/// precisar guardá-las (o engine, ao criar um candidato) copia — ver `CrossingInput`. Isso elimina
/// três cópias da faixa por quadro a 240 Hz no caminho quente.
public struct FrameMeasurement {
    public var tsNs: Nanos
    /// Timestamp do quadro de referência (c − lag), medido — não o nominal ts − lag·P.
    public var prevTsNs: Nanos
    /// ΔY_f do enunciado: média de |Y_f − Y_ref| na faixa inteira.
    public var deltaFull: Double
    /// Média de |Y_f − Y_ref| nas colunas centrais (gatilho).
    public var deltaCore: Double
    /// Média de |Y_f − fundo| na faixa inteira (confirmação).
    public var deltaBackground: Double
    /// Faixa inteira (W×H, linha a linha) do quadro de referência (c − lag).
    public var stripPrev: UnsafeBufferPointer<UInt8>
    /// Faixa inteira do quadro atual.
    public var stripCur: UnsafeBufferPointer<UInt8>
    /// Faixa inteira da referência de fundo (mesma paridade quando lag == 2).
    public var stripBg: UnsafeBufferPointer<Double>
    /// ΔY contra o quadro c−2 (para detectar flicker); nil se indisponível.
    public var deltaFullLag2: Double?
    /// Atraso de referência usado nesta medição (1 ou 2).
    public var lag: Int

    public init(tsNs: Nanos, prevTsNs: Nanos, deltaFull: Double, deltaCore: Double, deltaBackground: Double,
                stripPrev: UnsafeBufferPointer<UInt8>, stripCur: UnsafeBufferPointer<UInt8>,
                stripBg: UnsafeBufferPointer<Double>, deltaFullLag2: Double?, lag: Int) {
        self.tsNs = tsNs; self.prevTsNs = prevTsNs; self.deltaFull = deltaFull; self.deltaCore = deltaCore
        self.deltaBackground = deltaBackground
        self.stripPrev = stripPrev; self.stripCur = stripCur; self.stripBg = stripBg
        self.deltaFullLag2 = deltaFullLag2; self.lag = lag
    }
}

/// Dados do candidato usados pelo estimador sub-quadro: cópias feitas ao criar o candidato
/// (os buffers do differencer rotacionam) mais os quadros c+lag e c+2·lag com seus timestamps medidos.
public struct CrossingInput: Sendable {
    public var tsNs: Nanos
    public var prevTsNs: Nanos
    public var stripPrev: [UInt8]
    public var stripCur: [UInt8]
    public var stripBg: [Double]
    public var lag: Int
    public var nextTsNs: Nanos? = nil
    public var nextStrip: [UInt8]? = nil
    public var plateauTsNs: Nanos? = nil
    public var plateauStrip: [UInt8]? = nil

    public init(tsNs: Nanos, prevTsNs: Nanos, stripPrev: [UInt8], stripCur: [UInt8], stripBg: [Double], lag: Int) {
        self.tsNs = tsNs; self.prevTsNs = prevTsNs
        self.stripPrev = stripPrev; self.stripCur = stripCur; self.stripBg = stripBg; self.lag = lag
    }
}
