import XCTest
@testable import PhotocellCore

/// Prova completa simulada com pixels sintéticos (espelho do Kotlin): largada, janela cega,
/// retomada aos 8 s, chegada aos ~12,3 s no sentido oposto, lockout e resultado.
final class FullRunSimulationTests: XCTestCase {
    func testFullRunElapsedMatchesGroundTruth() throws {
        var cfg = PhotocellConfig()
        cfg.calibrationSamples = 32; cfg.calibrationMinSamplesForOutlier = 8
        cfg.skewNs = 3_200_000; cfg.exposureNs = 2_083_333
        let p = cfg.framePeriodNs
        let planeWidth = 32, stride = 40, planeHeight = 720
        let roi = RoiRect(x: 8, width: 15, y0: 300, y1: 396)
        let speedPx = 14.0 * 1000.0 / 6.0
        let t0: Int64 = 500_000_000_000
        let startFrame = 60
        let tStart = t0 + Int64(startFrame) * p + Int64(0.41 * Double(p))
        let finishOffset: Int64 = 12_300_000_000 + 1_234_567
        let tFinish = tStart + finishOffset
        var sceneStart = Scene(planeWidth: planeWidth, stride: stride, planeHeight: planeHeight, roi: roi, skewNs: 3_200_000, exposureNs: cfg.exposureNs, periodNs: p, direction: 1, speedPxPerS: speedPx, tCrossCenterNs: tStart, rowsA: 312, rowsB: 383, seed: 5)
        var sceneFinish = Scene(planeWidth: planeWidth, stride: stride, planeHeight: planeHeight, roi: roi, skewNs: 3_200_000, exposureNs: cfg.exposureNs, periodNs: p, direction: -1, speedPxPerS: speedPx, tCrossCenterNs: tFinish, rowsA: 312, rowsB: 383, seed: 6)
        var quiet = Scene(planeWidth: planeWidth, stride: stride, planeHeight: planeHeight, roi: roi, skewNs: 3_200_000, exposureNs: cfg.exposureNs, periodNs: p, direction: 1, speedPxPerS: speedPx, tCrossCenterNs: tFinish + 100_000_000_000, rowsA: 312, rowsB: 383, seed: 9)
        let diff = try StripDifferencer(roi: roi, planeWidth: planeWidth, planeHeight: planeHeight, coreWidth: cfg.coreWidth)
        let eng = PhotocellEngine(cfg: cfg, roi: roi, planeHeight: planeHeight)
        var plane = [UInt8](repeating: 0xEE, count: stride * planeHeight)
        func feed(_ band: [UInt8], _ ts: Int64) {
            plane.replaceSubrange((roi.y0 * stride)..<(roi.y0 * stride + band.count), with: band)
            let m = plane.withUnsafeBufferPointer { diff.process(plane: $0.baseAddress!, stride: stride, tsNs: ts) }
            if let m = m { eng.frame(m) } else { eng.frame(nil, tsNs: ts) }
            SimulationHarness.applyEffects(eng, diff, cfg)
        }
        eng.userArm(); SimulationHarness.applyEffects(eng, diff, cfg)
        for i in 0..<(startFrame + 12) { feed(sceneStart.frameBytes(t0 + Int64(i) * p), t0 + Int64(i) * p) }
        XCTAssertEqual(eng.state, .debounceStart, "largada não detectada")
        let start = try XCTUnwrap(eng.start)
        eng.wakeup(nowNs: start.rawTsNs + cfg.startLockoutNs); SimulationHarness.applyEffects(eng, diff, cfg)
        XCTAssertEqual(eng.state, .running)
        eng.wakeup(nowNs: start.rawTsNs + cfg.frameResumeNs); SimulationHarness.applyEffects(eng, diff, cfg)
        var ts = start.rawTsNs + cfg.frameResumeNs + p
        while ts < tFinish - 6 * p { feed(quiet.frameBytes(ts), ts); ts += p }
        XCTAssertEqual(eng.state, .awaitingFinish, "chegada não foi armada aos 10 s")
        for _ in 0..<14 { feed(sceneFinish.frameBytes(ts), ts); ts += p }
        XCTAssertEqual(eng.state, .debounceFinish, "chegada não detectada")
        let finish = try XCTUnwrap(eng.finish)
        eng.wakeup(nowNs: finish.rawTsNs + cfg.finishLockoutNs); SimulationHarness.applyEffects(eng, diff, cfg)
        XCTAssertEqual(eng.state, .finished)
        let res = try XCTUnwrap(eng.result)
        let errRefined = res.elapsedRefinedNs - finishOffset
        let errRaw = res.elapsedRawNs - finishOffset
        print("[FullRun] ΔT verdade=\(finishOffset) refinado erro=\(Double(errRefined) / 1e6) ms bruto erro=\(Double(errRaw) / 1e6) ms q=\(res.start.quality)/\(res.finish.quality)")
        XCTAssertEqual(res.start.quality, 2); XCTAssertEqual(res.finish.quality, 2)
        XCTAssertLessThan(abs(errRefined), 200_000, "erro refinado \(Double(errRefined) / 1e6) ms")
        XCTAssertLessThanOrEqual(abs(errRaw), 2 * p)
        XCTAssertEqual(TimeFormatter.formatElapsed(res.elapsedRefinedNs), "12.301")
    }
}
