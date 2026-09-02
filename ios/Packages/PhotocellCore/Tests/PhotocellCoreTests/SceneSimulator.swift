import Foundation
@testable import PhotocellCore

/// RNG determinístico (xorshift64*) — o mesmo do gerador Python, para cenas reproduzíveis.
struct Rng {
    private var s: UInt64
    init(seed: UInt64) { s = seed == 0 ? 0x9E3779B97F4A7C15 : seed }
    mutating func nextU64() -> UInt64 {
        var x = s
        x ^= x >> 12; x ^= x << 25; x ^= x >> 27
        s = x
        return x &* 0x2545F4914F6CDD1D
    }
    mutating func uniform() -> Double { Double(nextU64() >> 11) / Double(UInt64(1) << 53) }
    mutating func gauss(_ sigma: Double) -> Double {
        let u1 = max(uniform(), 1e-12)
        let u2 = uniform()
        return sigma * (-2.0 * log(u1)).squareRoot() * cos(2.0 * .pi * u2)
    }
}

/// Cena sintética (porte fiel de Tools/gen_test_vectors.py): fundo estático com padrão espacial e
/// ruído gaussiano por quadro; objeto (luma alta) cujo bordo vertical cruza a faixa a velocidade
/// constante; rolling shutter linha a linha (skew) e integração da exposição (E).
struct Scene {
    let planeWidth: Int, stride: Int, planeHeight: Int, roi: RoiRect
    let skewNs: Int64, exposureNs: Int64, periodNs: Int64, direction: Int
    let v: Double
    let tCrossCenterNs: Int64
    let rowsA: Int, rowsB: Int
    let bgLevel: Int, objLevel: Int
    let noiseSigma: Double, flickerAmp: Double
    var rng: Rng
    private let xc: Int

    init(planeWidth: Int, stride: Int, planeHeight: Int, roi: RoiRect, skewNs: Int64, exposureNs: Int64, periodNs: Int64,
         direction: Int, speedPxPerS: Double, tCrossCenterNs: Int64, rowsA: Int, rowsB: Int,
         bgLevel: Int = 96, objLevel: Int = 184, noiseSigma: Double = 1.5, flickerAmp: Double = 0.0, seed: UInt64 = 1) {
        self.planeWidth = planeWidth; self.stride = stride; self.planeHeight = planeHeight; self.roi = roi
        self.skewNs = skewNs; self.exposureNs = exposureNs; self.periodNs = periodNs; self.direction = direction
        self.v = speedPxPerS / 1e9
        self.tCrossCenterNs = tCrossCenterNs; self.rowsA = rowsA; self.rowsB = rowsB
        self.bgLevel = bgLevel; self.objLevel = objLevel; self.noiseSigma = noiseSigma; self.flickerAmp = flickerAmp
        self.rng = Rng(seed: seed)
        self.xc = roi.x + roi.width / 2
    }

    func edgeTimeAt(_ x: Int) -> Double { Double(tCrossCenterNs) + Double(x - xc) * Double(direction) / v }

    /// Linhas y0..y1 da faixa (height*stride bytes), preenchimento 0xEE fora das colunas do plano.
    mutating func frameBytes(_ tFrame: Int64) -> [UInt8] {
        var buf = [UInt8](repeating: 0xEE, count: stride * roi.height)
        for row in 0..<roi.height {
            let g = roi.y0 + row
            let tRow = tFrame + (Int64(g) * skewNs) / Int64(planeHeight)
            let flick = 1.0 + flickerAmp * sin(2.0 * .pi * 120.0 * (Double(tRow) / 1e9))
            for x in 0..<planeWidth {
                let base = Double(bgLevel + ((x * 7 + g * 3) % 11))
                var frac = 0.0
                if g >= rowsA && g <= rowsB {
                    let tx = edgeTimeAt(x)
                    frac = min(max((Double(tRow) + Double(exposureNs) - tx) / Double(exposureNs), 0.0), 1.0)
                }
                let value = (base + (Double(objLevel) - base) * frac) * flick + rng.gauss(noiseSigma)
                buf[row * stride + x] = UInt8(min(max(Int(value.rounded()), 0), 255))
            }
        }
        return buf
    }
}

struct SimulationResult {
    var triggered: Bool
    var rawErrorNs: Int64
    var refinedErrorNs: Int64
    var quality: Int
    var uncertaintyNs: Int64
    var lag: Int
    var threshold: Double
    var finalState: PhotocellState
}

/// Harness idêntico ao do gerador: aplica os efeitos do engine ao differencer.
enum SimulationHarness {
    static func applyEffects(_ eng: PhotocellEngine, _ diff: StripDifferencer, _ cfg: PhotocellConfig) {
        for e in eng.effects {
            switch e {
            case .resetDifferencer: diff.reset()
            case .updateBackground: diff.updateBackground(alpha: cfg.backgroundEmaAlpha)
            case .setReferenceLag(let l): diff.setLag(l)
            default: break
            }
        }
        eng.effects.removeAll()
    }

    /// Cruzamento único: calibração (32 amostras), quadros parados, cruzamento e passagem.
    static func runCrossing(speedMs: Double, exposureNs: Int64, noiseSigma: Double, direction: Int, crossFraction: Double,
                            objLevel: Int, flicker: Double, seed: UInt64, dropFrames: Set<Int> = [], mmPerPx: Double = 6.0,
                            skewNs: Int64 = 3_200_000, knownSkew: Bool = true, stripWidth: Int = 15) throws -> SimulationResult {
        var cfg = PhotocellConfig()
        cfg.calibrationSamples = 32
        cfg.calibrationMinSamplesForOutlier = 8
        cfg.skewNs = knownSkew ? skewNs : nil
        cfg.exposureNs = exposureNs
        let period = cfg.framePeriodNs
        let planeWidth = 32, stride = 40, planeHeight = 720
        let roi = RoiRect(x: 8, width: stripWidth, y0: 300, y1: 396)
        let speedPx = speedMs * 1000.0 / mmPerPx
        let nPre = 1 + cfg.calibrationSamples + 12
        let t0: Int64 = 1_000_000_000_000
        let crossFrame = nPre + 3
        let tCross = t0 + Int64(crossFrame) * period + Int64(crossFraction * Double(period))
        var scene = Scene(planeWidth: planeWidth, stride: stride, planeHeight: planeHeight, roi: roi, skewNs: skewNs,
                          exposureNs: exposureNs, periodNs: period, direction: direction, speedPxPerS: speedPx,
                          tCrossCenterNs: tCross, rowsA: roi.y0 + 12, rowsB: roi.y1 - 1 - 12, objLevel: objLevel,
                          noiseSigma: noiseSigma, flickerAmp: flicker, seed: seed)
        let diff = try StripDifferencer(roi: roi, planeWidth: planeWidth, planeHeight: planeHeight, coreWidth: cfg.coreWidth)
        let eng = PhotocellEngine(cfg: cfg, roi: roi, planeHeight: planeHeight)
        var plane = [UInt8](repeating: 0xEE, count: stride * planeHeight)
        eng.userArm(); applyEffects(eng, diff, cfg)
        for i in 0..<(crossFrame + 10) {
            if dropFrames.contains(i) { continue }
            let ts = t0 + Int64(i) * period
            let band = scene.frameBytes(ts)
            plane.replaceSubrange((roi.y0 * stride)..<(roi.y0 * stride + band.count), with: band)
            let m = plane.withUnsafeBufferPointer { diff.process(plane: $0.baseAddress!, stride: stride, tsNs: ts) }
            if let m = m { eng.frame(m) } else { eng.frame(nil, tsNs: ts) }
            applyEffects(eng, diff, cfg)
        }
        var rowOffset: Int64 = 0
        if !knownSkew {
            var sum: Int64 = 0
            for g in roi.y0..<roi.y1 { sum += (Int64(g) * skewNs) / Int64(planeHeight) }
            rowOffset = sum / Int64(roi.height)
        }
        guard let st = eng.start else {
            return SimulationResult(triggered: false, rawErrorNs: 0, refinedErrorNs: 0, quality: 0, uncertaintyNs: 0,
                                    lag: eng.lag, threshold: eng.threshold ?? 0, finalState: eng.state)
        }
        return SimulationResult(triggered: true, rawErrorNs: st.rawTsNs - tCross, refinedErrorNs: st.refinedTsNs + rowOffset - tCross,
                                quality: st.quality, uncertaintyNs: st.uncertaintyNs, lag: eng.lag,
                                threshold: eng.threshold ?? 0, finalState: eng.state)
    }
}
