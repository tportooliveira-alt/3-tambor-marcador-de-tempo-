import XCTest
@testable import PhotocellCore

/// Varredura física: centenas de cenários sintéticos executando o pipeline inteiro (espelho do
/// PhysicsSweepTest em Kotlin). Cada cenário precisa disparar e o refinamento precisa respeitar a
/// tolerância da sua qualidade; agregados apertados.
final class PhysicsSweepTests: XCTestCase {
    private struct Case: CustomStringConvertible {
        let speed: Double, expo: Int64, noise: Double, dir: Int, frac: Double, obj: Int, flicker: Double
        var description: String { "v=\(speed) E=\(expo) σ=\(noise) d=\(dir) f=\(frac) obj=\(obj) fl=\(flicker)" }
    }

    private func cases() -> [Case] {
        var out: [Case] = []
        for s in [8.0, 11.0, 14.0, 18.0] {
            for e: Int64 in [4_166_666, 2_083_333, 500_000, 250_000] {
                for n in [0.5, 1.5, 3.0] {
                    for d in [1, -1] {
                        for f in [0.05, 0.25, 0.5, 0.75, 0.95] {
                            for o in [140, 184] {
                                for fl in [0.0, 0.12] { out.append(Case(speed: s, expo: e, noise: n, dir: d, frac: f, obj: o, flicker: fl)) }
                            }
                        }
                    }
                }
            }
        }
        return out
    }

    func testSweepAllScenarios() throws {
        let all = cases()
        var failures: [String] = []
        var triggered = 0, q2 = 0
        // Cenários favoráveis: exposição ≥ P/2 (o bordo é visto dentro da janela) e SNR suficiente para pixels
        // interiores (σ=3 com contraste 44 dá margem 0,39 > 0,25: só limites, por projeto).
        var favorable = 0, favorableQ2 = 0
        var errs: [Double] = []
        var seed: UInt64 = 1000
        for c in all {
            seed += 7
            let r = try SimulationHarness.runCrossing(speedMs: c.speed, exposureNs: c.expo, noiseSigma: c.noise, direction: c.dir,
                                                      crossFraction: c.frac, objLevel: c.obj, flicker: c.flicker, seed: seed)
            guard r.triggered else { failures.append("sem gatilho: \(c)"); continue }
            triggered += 1
            if c.expo >= 2_083_333 && (c.noise <= 1.5 || c.obj >= 184) { favorable += 1; if r.quality == 2 { favorableQ2 += 1 } }
            let errMs = Double(r.refinedErrorNs) / 1e6
            switch r.quality {
            case 2:
                q2 += 1; errs.append(abs(errMs))
                if abs(errMs) > max(0.35, Double(r.uncertaintyNs) / 1e6 + 0.1) { failures.append(String(format: "q2 erro %.3f ms (±%.3f): %@", errMs, Double(r.uncertaintyNs) / 1e6, c.description)) }
            case 1:
                if abs(r.refinedErrorNs) > r.uncertaintyNs + 100_000 { failures.append(String(format: "q1 fora do intervalo (%.3f ± %.3f ms): %@", errMs, Double(r.uncertaintyNs) / 1e6, c.description)) }
            default:
                if abs(r.refinedErrorNs) > 4_200_000 { failures.append(String(format: "q0 erro %.3f ms: %@", errMs, c.description)) }
            }
        }
        let sorted = errs.sorted()
        let mean = errs.isEmpty ? 0 : errs.reduce(0, +) / Double(errs.count)
        let p95 = sorted.isEmpty ? 0 : sorted[min(Int(Double(sorted.count) * 0.95), sorted.count - 1)]
        let summary = String(format: "cenários=%d disparos=%d q2=%d q2(favoráveis)=%d/%d |erro| médio=%.4f ms p95=%.4f ms", all.count, triggered, q2, favorableQ2, favorable, mean, p95)
        print("[PhysicsSweep] \(summary)")
        XCTAssertTrue(failures.isEmpty, "Falhas (\(failures.count)):\n" + failures.prefix(25).joined(separator: "\n") + "\n\(summary)")
        XCTAssertGreaterThanOrEqual(Double(triggered), Double(all.count) * 0.98, summary)
        // Com exposição curta (1/2000, 1/4000 s) o cruzamento cai fora da janela na maioria dos quadros:
        // só limites/intervalo (qualidade 1) ou tempo do quadro (qualidade 0) — é física, não defeito.
        XCTAssertGreaterThanOrEqual(Double(favorableQ2), Double(favorable) * 0.95, summary)
        XCTAssertGreaterThanOrEqual(Double(q2), Double(triggered) * 0.55, summary)
        XCTAssertLessThan(mean, 0.10, summary)
        XCTAssertLessThan(p95, 0.25, summary)
    }

    func testDropsNearTriggerAreFlaggedAndDoNotBreakTiming() throws {
        let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37,
                                                  objLevel: 184, flicker: 0, seed: 77, dropFrames: [44, 45])
        XCTAssertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "\(r)")
    }

    func testUnknownSkewOnlyAddsConstantOffset() throws {
        let a = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0, seed: 91, knownSkew: false)
        let b = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: -1, crossFraction: 0.61, objLevel: 184, flicker: 0, seed: 92, knownSkew: false)
        XCTAssertTrue(a.quality == 2 && b.quality == 2)
        XCTAssertTrue(abs(a.refinedErrorNs) < 200_000 && abs(b.refinedErrorNs) < 200_000, "\(a) \(b)")
    }

    func testFlickerSelectsLagTwo() throws {
        let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0.12, seed: 14)
        XCTAssertEqual(r.lag, 2, "\(r)")
        XCTAssertTrue(r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "\(r)")
    }
}
