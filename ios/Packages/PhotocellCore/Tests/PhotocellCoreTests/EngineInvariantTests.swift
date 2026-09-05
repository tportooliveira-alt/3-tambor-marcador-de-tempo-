import XCTest
@testable import PhotocellCore

/// Invariantes da máquina de estados sob sequências aleatórias de eventos (espelho do Kotlin).
final class EngineInvariantTests: XCTestCase {
    private var cfg: PhotocellConfig = {
        var c = PhotocellConfig()
        c.calibrationSamples = 24; c.calibrationMinSamplesForOutlier = 6
        c.frameResumeNs = 800_000_000; c.finishArmNs = 1_300_000_000
        c.startLockoutNs = 300_000_000; c.finishLockoutNs = 200_000_000
        return c
    }()
    private let roi = RoiRect(x: 8, width: 9, y0: 300, y1: 396)

    private func meas(_ ts: Int64, _ full: Double, _ core: Double, _ bg: Double) -> FrameMeasurement {
        FrameMeasurement(tsNs: ts, prevTsNs: ts - cfg.framePeriodNs, deltaFull: full, deltaCore: core, deltaBackground: bg,
                         stripPrev: UnsafeBufferPointer(start: nil, count: 0), stripCur: UnsafeBufferPointer(start: nil, count: 0),
                         stripBg: UnsafeBufferPointer(start: nil, count: 0), deltaFullLag2: nil, lag: 1)
    }

    func testRandomSequencesKeepInvariants() throws {
        var rng = Rng(seed: 4242)
        var finishedRuns = 0
        for seq in 0..<300 {
            let eng = try PhotocellEngine(cfg: cfg, roi: roi, planeHeight: 720)
            var ts: Int64 = 10_000_000_000
            let period = cfg.framePeriodNs
            var pending: [Int64] = []
            var lastState = eng.state
            var burst = 0
            for step in 0..<400 {
                let r = rng.uniform()
                let stateBefore = eng.state
                if r < 0.04 { eng.userArm() }
                else if r < 0.05 { eng.userCalibrate() }
                else if r < 0.07 { eng.userReset() }
                else if r < 0.075 { eng.captureInterrupted() }
                else if r < 0.20 {
                    if !pending.isEmpty && rng.uniform() < 0.8 {
                        let at = pending[Int(rng.uniform() * Double(pending.count))]
                        if rng.uniform() < 0.3 && at - 1 >= ts { eng.wakeup(nowNs: at - 1) } else { ts = max(ts, at); eng.wakeup(nowNs: ts) }
                    } else { eng.wakeup(nowNs: ts) }
                } else {
                    ts += period
                    if burst == 0 && rng.uniform() < 0.06 { burst = 6 }
                    if burst > 0 { burst -= 1; eng.frame(meas(ts, 20, 30, 40)) }
                    else { eng.frame(meas(ts, 1.0 + rng.uniform(), 0.9 + rng.uniform(), 0.8 + rng.uniform())) }
                }
                for e in eng.effects {
                    switch e {
                    case .scheduleWakeup(let at): pending.append(at)
                    case .cancelWakeups: pending.removeAll()
                    case .feedback(let kind):
                        let ok = (kind == .start && stateBefore == .confirmingStart) || (kind == .finish && stateBefore == .confirmingFinish)
                        XCTAssertTrue(ok, "gatilho \(kind) a partir de \(stateBefore) (seq \(seq) passo \(step))")
                    default: break
                    }
                }
                eng.effects.removeAll()
                if eng.state == .idle && stateBefore != .idle && r >= 0.05 && r < 0.07 {
                    XCTAssertNil(eng.start); XCTAssertNil(eng.result); XCTAssertTrue(pending.isEmpty, "reset deve cancelar wake-ups")
                }
                if let res = eng.result {
                    XCTAssertEqual(res.finish.rawTsNs - res.start.rawTsNs, res.elapsedRawNs)
                    XCTAssertGreaterThanOrEqual(res.finish.rawTsNs, res.start.rawTsNs + cfg.finishArmNs, "chegada antes de armar")
                    if lastState != .finished && eng.state == .finished { finishedRuns += 1 }
                }
                lastState = eng.state
            }
        }
        XCTAssertGreaterThanOrEqual(finishedRuns, 5, "poucas provas completas: \(finishedRuns)")
    }

    func testDuplicateAndEarlyWakeupsAreNoOps() throws {
        let eng = try PhotocellEngine(cfg: cfg, roi: roi, planeHeight: 720)
        eng.userArm(); eng.effects.removeAll()
        var ts: Int64 = 5_000_000_000
        let p = cfg.framePeriodNs
        eng.frame(nil, tsNs: ts)
        for _ in 0..<cfg.calibrationSamples { ts += p; eng.frame(meas(ts, 1.2, 1.1, 0.9)) }
        XCTAssertEqual(eng.state, .armed)
        ts += p; eng.frame(meas(ts, 20, 30, 25))
        let start = ts
        for _ in 0..<2 { ts += p; eng.frame(meas(ts, 18, 22, 40)) }
        XCTAssertEqual(eng.state, .debounceStart)
        eng.effects.removeAll()
        eng.wakeup(nowNs: start + cfg.startLockoutNs - 1)
        XCTAssertEqual(eng.state, .debounceStart, "wake-up antecipado não pode transitar")
        eng.wakeup(nowNs: start + cfg.startLockoutNs)
        XCTAssertEqual(eng.state, .running)
        let before = eng.effects.count
        eng.wakeup(nowNs: start + cfg.startLockoutNs)
        XCTAssertEqual(before, eng.effects.count, "wake-up duplicado deve ser no-op")
        eng.wakeup(nowNs: start + cfg.finishArmNs)
        XCTAssertEqual(eng.state, .awaitingFinish)
    }

    func testInvalidWindowsAreRejectedUpFront() {
        // retomada antes do fim do bloqueio: o engine nunca religaria os quadros e a prova travaria
        var c1 = cfg
        c1.frameResumeNs = cfg.startLockoutNs + 100_000_000
        XCTAssertThrowsError(try PhotocellEngine(cfg: c1, roi: roi, planeHeight: 720))
        // chegada armada antes da retomada dos quadros: idem
        var c2 = cfg
        c2.frameResumeNs = 1_500_000_000; c2.finishArmNs = 1_000_000_000
        XCTAssertThrowsError(try PhotocellEngine(cfg: c2, roi: roi, planeHeight: 720))
    }

    func testFramesDroppedDiscardsCandidateAndMarksDegraded() throws {
        let eng = try PhotocellEngine(cfg: cfg, roi: roi, planeHeight: 720)
        eng.userArm(); eng.effects.removeAll()
        var ts: Int64 = 5_000_000_000
        let p = cfg.framePeriodNs
        eng.frame(nil, tsNs: ts)
        for _ in 0..<cfg.calibrationSamples { ts += p; eng.frame(meas(ts, 1.2, 1.1, 0.9)) }
        XCTAssertEqual(eng.state, .armed)
        ts += p; eng.frame(meas(ts, 20, 30, 25))
        XCTAssertEqual(eng.state, .confirmingStart)
        eng.effects.removeAll()
        eng.framesDropped()                       // TN2445 "Discontinuity" no meio da confirmação
        XCTAssertEqual(eng.state, .armed, "candidato sem base de tempo tem de ser descartado")
        XCTAssertTrue(eng.effects.contains(.resetDifferencer))
        XCTAssertEqual(eng.drops, 1)
        ts += p; eng.frame(meas(ts, 20, 30, 25))
        for _ in 0..<2 { ts += p; eng.frame(meas(ts, 18, 22, 40)) }
        XCTAssertEqual(eng.state, .debounceStart)
        XCTAssertTrue(eng.start?.degraded ?? false, "gatilho a < 50 ms de um drop precisa ser degradado")
    }
}
