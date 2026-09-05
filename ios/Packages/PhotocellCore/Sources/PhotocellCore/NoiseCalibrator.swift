import Foundation

/// Média/variância incremental (Welford).
public struct NoiseStats: Sendable {
    public private(set) var count: Int = 0
    public private(set) var mean: Double = 0.0
    private var m2: Double = 0.0

    public init() {}

    public mutating func add(_ x: Double) {
        count += 1
        let delta = x - mean
        mean += delta / Double(count)
        m2 += delta * (x - mean)
    }

    public var variance: Double { count > 1 ? m2 / Double(count - 1) : 0.0 }
    public var sigma: Double { variance.squareRoot() }
}

public enum CalibrationStep: String, Sendable {
    case collecting, restarted, done, failed
}

public func computeThreshold(_ cfg: PhotocellConfig, mean: Double, sigma: Double) -> Double {
    max(cfg.thresholdFloor, max(mean + cfg.thresholdSigmaK * sigma, cfg.thresholdMeanMultiplier * mean))
}

/// Coleta N amostras de ΔY com a pista vazia; um outlier (> μ + kσ) reinicia a coleta (até
/// `calibrationMaxRetries` vezes) e o limiar adaptativo é max(piso, μ + kσ, m·μ).
public struct NoiseCalibrator: Sendable {
    private let cfg: PhotocellConfig
    public private(set) var stats = NoiseStats()
    public private(set) var retries = 0
    public private(set) var threshold: Double? = nil
    public private(set) var failed = false

    public init(cfg: PhotocellConfig) { self.cfg = cfg }

    public mutating func reset() {
        stats = NoiseStats()
        retries = 0
        threshold = nil
        failed = false
    }

    public mutating func addSample(_ x: Double) -> CalibrationStep {
        if threshold != nil { return .done }
        if failed { return .failed }
        if stats.count >= cfg.calibrationMinSamplesForOutlier {
            if x > stats.mean + cfg.calibrationOutlierSigma * stats.sigma {
                retries += 1
                stats = NoiseStats()
                if retries > cfg.calibrationMaxRetries {
                    failed = true
                    return .failed
                }
                return .restarted
            }
        }
        stats.add(x)
        if stats.count >= cfg.calibrationSamples {
            threshold = computeThreshold(cfg, mean: stats.mean, sigma: stats.sigma)
            return .done
        }
        return .collecting
    }
}
