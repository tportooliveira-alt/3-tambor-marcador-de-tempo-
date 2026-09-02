import XCTest
@testable import PhotocellCore

/// Executa os vetores compartilhados (arquivos JSON em shared/test-vectors) gerados pela referência
/// Python. O núcleo Swift precisa reproduzir exatamente as mesmas medições, transições, efeitos e tempos.
final class SharedVectorTests: XCTestCase {

    // MARK: - localização dos vetores
    static var vectorsDir: URL {
        if let env = ProcessInfo.processInfo.environment["PHOTOCELL_VECTORS"] {
            return URL(fileURLWithPath: env)
        }
        // <repo>/ios/Packages/PhotocellCore/Tests/PhotocellCoreTests/SharedVectorTests.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("shared/test-vectors")
    }

    private func loadJSON(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: Self.vectorsDir.appendingPathComponent(name))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func vectors(kind: String) throws -> [[String: Any]] {
        let index = try loadJSON("index.json")
        let list = try XCTUnwrap(index["vectors"] as? [[String: Any]])
        return try list.filter { ($0["kind"] as? String) == kind }.map { try loadJSON($0["file"] as! String) }
    }

    // MARK: - conversões
    private func int(_ v: Any?) -> Int { (v as! NSNumber).intValue }
    private func int64(_ v: Any?) -> Int64 { (v as! NSNumber).int64Value }
    private func dbl(_ v: Any?) -> Double { (v as! NSNumber).doubleValue }
    private func bool(_ v: Any?) -> Bool { (v as! NSNumber).boolValue }
    private func isNull(_ v: Any?) -> Bool { v == nil || v is NSNull }

    private func config(_ j: [String: Any]) -> PhotocellConfig {
        var c = PhotocellConfig()
        c.frameRateHz = int(j["frame_rate_hz"])
        c.startLockoutNs = int64(j["start_lockout_ns"])
        c.frameResumeNs = int64(j["frame_resume_ns"])
        c.finishArmNs = int64(j["finish_arm_ns"])
        c.finishLockoutNs = int64(j["finish_lockout_ns"])
        c.calibrationSamples = int(j["calibration_samples"])
        c.calibrationMinSamplesForOutlier = int(j["calibration_min_samples_for_outlier"])
        c.calibrationOutlierSigma = dbl(j["calibration_outlier_sigma"])
        c.calibrationMaxRetries = int(j["calibration_max_retries"])
        c.thresholdFloor = dbl(j["threshold_floor"])
        c.thresholdSigmaK = dbl(j["threshold_sigma_k"])
        c.thresholdMeanMultiplier = dbl(j["threshold_mean_multiplier"])
        c.confirmWindow = int(j["confirm_window"])
        c.confirmRequired = int(j["confirm_required"])
        c.backgroundThresholdMultiplier = dbl(j["background_threshold_multiplier"])
        c.backgroundEmaAlpha = dbl(j["background_ema_alpha"])
        c.dropGapFactor = dbl(j["drop_gap_factor"])
        c.degradedDropWindowNs = int64(j["degraded_drop_window_ns"])
        c.coreWidth = int(j["core_width"])
        c.exposureNs = int64(j["exposure_ns"])
        c.minContrast = dbl(j["min_contrast"])
        c.fractionMarginMin = dbl(j["fraction_margin_min"])
        c.fractionMarginSigmas = dbl(j["fraction_margin_sigmas"])
        c.fractionMarginMax = dbl(j["fraction_margin_max"])
        c.speedPxPerSMin = dbl(j["speed_px_per_s_min"])
        c.speedPxPerSMax = dbl(j["speed_px_per_s_max"])
        c.minInteriorRowsPerColumn = int(j["min_interior_rows_per_column"])
        c.minInteriorRowsFraction = dbl(j["min_interior_rows_fraction"])
        c.skewNs = isNull(j["skew_ns"]) ? nil : int64(j["skew_ns"])
        c.readoutTopToBottom = bool(j["readout_top_to_bottom"])
        c.flickerRatio = dbl(j["flicker_ratio"])
        c.flickerAuto = bool(j["flicker_auto"])
        c.gamma = dbl(j["gamma"])
        return c
    }

    private func roi(_ j: [String: Any]) -> RoiRect {
        RoiRect(x: int(j["x"]), width: int(j["width"]), y0: int(j["y0"]), y1: int(j["y1"]))
    }

    private func assertClose(_ expected: Double, _ actual: Double, _ what: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let tol = 1e-9 * max(1.0, abs(expected))
        XCTAssertLessThanOrEqual(abs(expected - actual), tol, "\(what): esperado \(expected), obtido \(actual)",
                                 file: file, line: line)
    }

    private func assertTrigger(_ exp: Any?, _ act: TriggerInfo?, _ what: String) {
        guard let e = exp as? [String: Any] else {
            XCTAssertNil(act, what); return
        }
        guard let a = act else { XCTFail("\(what): esperado gatilho"); return }
        XCTAssertEqual(int64(e["rawTs"]), a.rawTsNs, "\(what).rawTs")
        XCTAssertLessThanOrEqual(abs(int64(e["refinedTs"]) - a.refinedTsNs), 1, "\(what).refinedTs")
        XCTAssertEqual(int(e["quality"]), a.quality, "\(what).quality")
        XCTAssertLessThanOrEqual(abs(int64(e["uncertaintyNs"]) - a.uncertaintyNs), 1, "\(what).uncertainty")
        XCTAssertEqual(int(e["interiorCount"]), a.interiorCount, "\(what).interiorCount")
        XCTAssertEqual(bool(e["degraded"]), a.degraded, "\(what).degraded")
        XCTAssertEqual(isNull(e["texturedColumns"]) ? 0 : int(e["texturedColumns"]), a.texturedColumns, "\(what).texturedColumns")
    }

    private func assertEffects(_ expected: [[String: Any]], _ actual: [(String, [String])], _ name: String) {
        XCTAssertEqual(expected.count, actual.count, "\(name): número de blocos de efeitos")
        for (i, e) in expected.enumerated() where i < actual.count {
            XCTAssertEqual(e["at"] as? String, actual[i].0, "\(name): efeitos[\(i)].at")
            XCTAssertEqual(e["effects"] as? [String], actual[i].1, "\(name): efeitos[\(i)] em \(e["at"] ?? "")")
        }
    }

    private final class EffectApplier {
        let diff: StripDifferencer?
        let cfg: PhotocellConfig
        var log: [(String, [String])] = []
        init(diff: StripDifferencer?, cfg: PhotocellConfig) { self.diff = diff; self.cfg = cfg }
        func apply(_ eng: PhotocellEngine, _ tag: String) {
            for e in eng.effects {
                switch e {
                case .resetDifferencer: diff?.reset()
                case .updateBackground: diff?.updateBackground(alpha: cfg.backgroundEmaAlpha)
                case .setReferenceLag(let l): diff?.setLag(l)
                default: break
                }
            }
            if !eng.effects.isEmpty { log.append((tag, eng.effects.map { $0.wire })) }
            eng.effects.removeAll()
        }
    }

    private func userEvent(_ eng: PhotocellEngine, _ name: String) {
        switch name {
        case "user_arm": eng.userArm()
        case "user_calibrate": eng.userCalibrate()
        case "user_reset": eng.userReset()
        case "capture_interrupted": eng.captureInterrupted()
        default: XCTFail("evento desconhecido \(name)")
        }
    }

    // MARK: - strip
    func testStripVectors() throws {
        for v in try vectors(kind: "strip") {
            let name = v["name"] as! String
            let cfg = config(v["config"] as! [String: Any])
            let roi = roi(v["roi"] as! [String: Any])
            let planeWidth = int(v["planeWidth"]), planeHeight = int(v["planeHeight"]), stride = int(v["stride"])
            let sentinel = UInt8(int(v["sentinel"]))
            let timestamps = v["timestamps"] as! [Any]
            let frames = v["frames"] as! [String]
            let userEvents = v["userEvents"] as! [String: String]
            let diff = try StripDifferencer(roi: roi, planeWidth: planeWidth, planeHeight: planeHeight, coreWidth: cfg.coreWidth)
            let eng = try PhotocellEngine(cfg: cfg, roi: roi, planeHeight: planeHeight)
            let applier = EffectApplier(diff: diff, cfg: cfg)
            var plane = [UInt8](repeating: sentinel, count: stride * planeHeight)
            let exp = v["expected"] as! [String: Any]
            let expMeas = exp["measurements"] as! [Any]
            for i in 0..<frames.count {
                if let ev = userEvents[String(i)] {
                    userEvent(eng, ev)
                    applier.apply(eng, "before:\(i)")
                }
                let band = try XCTUnwrap(Data(base64Encoded: frames[i]))
                plane.replaceSubrange((roi.y0 * stride)..<(roi.y0 * stride + band.count), with: band)
                let ts = int64(timestamps[i])
                let m = plane.withUnsafeBufferPointer { diff.process(plane: $0.baseAddress!, stride: stride, tsNs: ts) }
                if let m = m {
                    let e = try XCTUnwrap(expMeas[i] as? [String: Any], "\(name): quadro \(i) deveria ter medição")
                    XCTAssertEqual(int64(e["ts"]), m.tsNs, "\(name): ts do quadro \(i)")
                    assertClose(dbl(e["full"]), m.deltaFull, "\(name): deltaFull quadro \(i)")
                    assertClose(dbl(e["core"]), m.deltaCore, "\(name): deltaCore quadro \(i)")
                    assertClose(dbl(e["bg"]), m.deltaBackground, "\(name): deltaBackground quadro \(i)")
                    eng.frame(m)
                } else {
                    XCTAssertTrue(isNull(expMeas[i]), "\(name): quadro \(i) deveria ser semente")
                    eng.frame(nil, tsNs: ts)
                }
                applier.apply(eng, "frame:\(i)")
            }
            XCTAssertEqual(exp["transitions"] as? [String], eng.transitions.map { $0.rawValue }, "\(name): transições")
            assertEffects(exp["effects"] as! [[String: Any]], applier.log, name)
            XCTAssertEqual(exp["finalState"] as? String, eng.state.rawValue, "\(name): estado final")
            assertClose(dbl(exp["threshold"]), try XCTUnwrap(eng.threshold), "\(name): limiar")
            XCTAssertEqual(int(exp["lag"]), eng.lag, "\(name): lag")
            assertTrigger(exp["start"], eng.start, "\(name): start")
            XCTAssertEqual(int(exp["drops"]), eng.drops, "\(name): drops")
        }
    }

    // MARK: - calibração
    func testCalibrationVectors() throws {
        for v in try vectors(kind: "calibration") {
            let name = v["name"] as! String
            let cfg = config(v["config"] as! [String: Any])
            var cal = NoiseCalibrator(cfg: cfg)
            let samples = v["samples"] as! [Any]
            let exp = v["expected"] as! [String: Any]
            let results = exp["results"] as! [String]
            for (i, s) in samples.enumerated() {
                XCTAssertEqual(results[i], cal.addSample(dbl(s)).rawValue, "\(name): resultado da amostra \(i)")
            }
            if isNull(exp["threshold"]) { XCTAssertNil(cal.threshold) } else { assertClose(dbl(exp["threshold"]), try XCTUnwrap(cal.threshold), "\(name): limiar") }
            XCTAssertEqual(int(exp["retries"]), cal.retries, "\(name): retries")
            XCTAssertEqual(bool(exp["failed"]), cal.failed, "\(name): failed")
            assertClose(dbl(exp["mean"]), cal.stats.mean, "\(name): média")
            assertClose(dbl(exp["sigma"]), cal.stats.sigma, "\(name): sigma")
            XCTAssertEqual(int(exp["count"]), cal.stats.count, "\(name): count")
        }
    }

    // MARK: - FSM
    func testFsmVectors() throws {
        for v in try vectors(kind: "fsm") {
            let name = v["name"] as! String
            let cfg = config(v["config"] as! [String: Any])
            let roi = roi(v["roi"] as! [String: Any])
            let planeHeight = int(v["planeHeight"])
            let eng = try PhotocellEngine(cfg: cfg, roi: roi, planeHeight: planeHeight)
            let applier = EffectApplier(diff: nil, cfg: cfg)
            var idx = 0
            for st in v["steps"] as! [[String: Any]] {
                switch st["type"] as! String {
                case "frames":
                    let prev = (st["stripPrev"] as? [Any])?.map { UInt8(int($0)) } ?? []
                    let cur = (st["stripCur"] as? [Any])?.map { UInt8(int($0)) } ?? []
                    let bg = (st["stripBg"] as? [Any])?.map { dbl($0) } ?? []
                    for k in 0..<int(st["count"]) {
                        let ts = int64(st["ts0"]) + Int64(k) * int64(st["period"])
                        // as faixas são vistas sobre arrays locais, válidas só dentro deste bloco (como no differencer)
                        prev.withUnsafeBufferPointer { prevP in
                            cur.withUnsafeBufferPointer { curP in
                                bg.withUnsafeBufferPointer { bgP in
                                    let m = FrameMeasurement(tsNs: ts, prevTsNs: ts - int64(st["period"]), deltaFull: dbl(st["full"]),
                                                             deltaCore: dbl(st["core"]), deltaBackground: dbl(st["bg"]),
                                                             stripPrev: prevP, stripCur: curP, stripBg: bgP, deltaFullLag2: nil, lag: 1)
                                    eng.frame(m)
                                }
                            }
                        }
                        applier.apply(eng, "frame:\(idx)")
                        idx += 1
                    }
                case "seed":
                    eng.frame(nil, tsNs: int64(st["ts"]))
                    applier.apply(eng, "seed:\(idx)")
                    idx += 1
                case "wakeup":
                    let ts = int64(st["ts"])
                    eng.wakeup(nowNs: ts)
                    applier.apply(eng, "wakeup:\(ts)")
                case "user":
                    let ev = st["event"] as! String
                    userEvent(eng, ev)
                    applier.apply(eng, "user:\(ev):\(idx)")
                default:
                    XCTFail("passo desconhecido")
                }
            }
            let exp = v["expected"] as! [String: Any]
            XCTAssertEqual(exp["transitions"] as? [String], eng.transitions.map { $0.rawValue }, "\(name): transições")
            assertEffects(exp["effects"] as! [[String: Any]], applier.log, name)
            XCTAssertEqual(exp["finalState"] as? String, eng.state.rawValue, "\(name): estado final")
            if isNull(exp["errorReason"]) { XCTAssertNil(eng.errorReason) } else { XCTAssertEqual(exp["errorReason"] as? String, eng.errorReason) }
            if isNull(exp["threshold"]) { XCTAssertNil(eng.threshold) } else { assertClose(dbl(exp["threshold"]), try XCTUnwrap(eng.threshold), "\(name): limiar") }
            assertTrigger(exp["start"], eng.start, "\(name): start")
            assertTrigger(exp["finish"], eng.finish, "\(name): finish")
            XCTAssertEqual(int(exp["drops"]), eng.drops, "\(name): drops")
            if let er = exp["result"] as? [String: Any] {
                let r = try XCTUnwrap(eng.result, "\(name): result")
                XCTAssertEqual(int64(er["elapsedRawNs"]), r.elapsedRawNs, "\(name): elapsedRaw")
                XCTAssertLessThanOrEqual(abs(int64(er["elapsedRefinedNs"]) - r.elapsedRefinedNs), 2, "\(name): elapsedRefined")
                XCTAssertEqual(int(er["drops"]), r.drops)
                XCTAssertEqual(bool(er["degraded"]), r.degraded)
                assertClose(dbl(er["thresholdStart"]), r.thresholdStart, "\(name): thresholdStart")
                assertClose(dbl(er["thresholdFinish"]), r.thresholdFinish, "\(name): thresholdFinish")
                XCTAssertEqual(er["elapsedText"] as? String, TimeFormatter.formatElapsed(r.elapsedRawNs), "\(name): elapsedText")
            } else {
                XCTAssertNil(eng.result, "\(name): result")
            }
        }
    }

    // MARK: - formatação
    func testFormatVectors() throws {
        for v in try vectors(kind: "format") {
            for c in v["cases"] as! [[String: Any]] {
                XCTAssertEqual(c["text"] as? String, TimeFormatter.formatElapsed(int64(c["ns"])), "ns=\(int64(c["ns"]))")
            }
        }
    }
}
