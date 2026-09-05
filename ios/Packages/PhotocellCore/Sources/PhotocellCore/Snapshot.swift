import Foundation

/// Valor imutável publicado pelo engine para a interface (lido pelo display link a 120 Hz).
public struct PhotocellSnapshot: Equatable, Sendable {
    public var state: PhotocellState = .idle
    public var errorReason: String? = nil
    public var threshold: Double? = nil
    public var lag: Int = 1
    public var startNs: Nanos? = nil
    public var finishNs: Nanos? = nil
    public var result: RunResult? = nil
    public var drops: Int = 0
    public var lastDeltaFull: Double = 0
    public var lastDeltaCore: Double = 0
    public var noiseMean: Double = 0

    public init() {}

    public init(engine: PhotocellEngine, lastDeltaFull: Double, lastDeltaCore: Double) {
        state = engine.state
        errorReason = engine.errorReason
        threshold = engine.threshold
        lag = engine.lag
        startNs = engine.start?.rawTsNs
        finishNs = engine.finish?.rawTsNs
        result = engine.result
        drops = engine.drops
        self.lastDeltaFull = lastDeltaFull
        self.lastDeltaCore = lastDeltaCore
        noiseMean = engine.noiseMean
    }
}
