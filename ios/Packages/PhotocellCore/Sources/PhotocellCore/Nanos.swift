import Foundation

/// Tempo em nanossegundos inteiros do relógio do sensor (PTS do `CMSampleBuffer` convertido para
/// escala 1e9 no iOS; `SENSOR_TIMESTAMP` no Android). Nunca use relógio de CPU/thread aqui.
public typealias Nanos = Int64

public let nsPerSecond: Int64 = 1_000_000_000

/// E|X−Y| = 2σ/√π para X,Y ~ N(·, σ): converte o ΔY médio da calibração em σ por pixel.
public let meanAbsDiffToSigma: Double = 1.1283791670955126

@inline(__always)
func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
}
