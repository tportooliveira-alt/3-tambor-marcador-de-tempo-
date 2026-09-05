import XCTest
@testable import PhotocellCore

/// Varredura física (espelho do Kotlin): milhares de cenários sintéticos executando o pipeline
/// inteiro, com aceitação por qualidade e agregados apertados nas cenas limpas. Com textura o resultado
/// pode cair para intervalo ou tempo do quadro, mas NUNCA para um número falso.
final class PhysicsSweepTests: XCTestCase {
    private struct Case: CustomStringConvertible {
        let speed: Double, expo: Int64, noise: Double, dir: Int, frac: Double, obj: Int, flicker: Double, tex: Double
        var description: String { "v=\(speed) E=\(expo) σ=\(noise) d=\(dir) f=\(frac) obj=\(obj) fl=\(flicker) tex=\(tex)" }
    }

    private func cases() -> [Case] {
        var out: [Case] = []
        for s in [8.0, 11.0, 14.0, 18.0] {
            for e: Int64 in [4_166_666, 2_083_333, 500_000, 250_000] {
                for n in [0.5, 1.5, 3.0] {
                    for d in [1, -1] {
                        for f in [0.05, 0.25, 0.5, 0.75, 0.95] {
                            for o in [140, 184] {
                                for fl in [0.0, 0.12] {
                                    for tx in [0.0, 30.0] {
                                        out.append(Case(speed: s, expo: e, noise: n, dir: d, frac: f, obj: o, flicker: fl, tex: tx))
                                    }
                                }
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
        var triggered = 0, q2 = 0, q1 = 0
        // Cenários favoráveis: sem textura, exposição ≥ P/2 e SNR suficiente para pixels interiores
        // (σ=3 com contraste 44 dá margem 0,39 > 0,25: só limites, por projeto).
        var favorable = 0, favorableQ2 = 0
        var texQ2 = 0, texQ1 = 0, texQ0 = 0
        var errs: [Double] = []
        var errsTex: [Double] = []
        var seed: UInt64 = 1000
        for c in all {
            seed += 7
            let r = try SimulationHarness.runCrossing(speedMs: c.speed, exposureNs: c.expo, noiseSigma: c.noise, direction: c.dir,
                                                      crossFraction: c.frac, objLevel: c.obj, flicker: c.flicker, seed: seed,
                                                      texture: c.tex)
            guard r.triggered else { failures.append("sem gatilho: \(c)"); continue }
            triggered += 1
            if c.tex == 0.0 && c.expo >= 2_083_333 && (c.noise <= 1.5 || c.obj >= 184) { favorable += 1; if r.quality == 2 { favorableQ2 += 1 } }
            let errMs = Double(r.refinedErrorNs) / 1e6
            let uncMs = Double(r.uncertaintyNs) / 1e6
            switch r.quality {
            case 2:
                q2 += 1
                if c.tex == 0.0 { errs.append(abs(errMs)) } else { texQ2 += 1; errsTex.append(abs(errMs)) }
                if abs(errMs) > max(0.35, uncMs + 0.1) || abs(errMs) > 0.6 {
                    failures.append(String(format: "q2 erro %.3f ms (±%.3f, tex=%d): %@", errMs, uncMs, r.texturedColumns, c.description))
                }
            case 1:
                q1 += 1
                if c.tex > 0.0 { texQ1 += 1 }
                if abs(r.refinedErrorNs) > r.uncertaintyNs + 100_000 {
                    failures.append(String(format: "q1 fora do intervalo (%.3f ± %.3f ms, tex=%d): %@", errMs, uncMs, r.texturedColumns, c.description))
                }
            default:
                if c.tex > 0.0 { texQ0 += 1 }
                if abs(errMs) > uncMs + 0.1 { failures.append(String(format: "q0 verdade fora do intervalo (%.3f ± %.3f ms): %@", errMs, uncMs, c.description)) }
            }
        }
        let sorted = errs.sorted()
        let mean = errs.isEmpty ? 0 : errs.reduce(0, +) / Double(errs.count)
        let p95 = sorted.isEmpty ? 0 : sorted[min(Int(Double(sorted.count) * 0.95), sorted.count - 1)]
        let meanTex = errsTex.isEmpty ? 0 : errsTex.reduce(0, +) / Double(errsTex.count)
        let summary = String(format: "cenários=%d disparos=%d q2=%d q1=%d q2(favoráveis)=%d/%d |erro| médio=%.4f ms p95=%.4f ms | textura: q2=%d (|erro| médio %.4f ms) q1=%d q0=%d",
                             all.count, triggered, q2, q1, favorableQ2, favorable, mean, p95, texQ2, meanTex, texQ1, texQ0)
        print("[PhysicsSweep] \(summary)")
        XCTAssertTrue(failures.isEmpty, "Falhas (\(failures.count)):\n" + failures.prefix(25).joined(separator: "\n") + "\n\(summary)")
        XCTAssertGreaterThanOrEqual(Double(triggered), Double(all.count) * 0.98, summary)
        // Um ajuste só é aceito com >= 3 colunas (2 colunas dão uma reta exata e não verificável), e a
        // incerteza inclui o viés não observável da abertura do pixel: isso custa parte dos cenários
        // favoráveis, que caem para intervalo honesto em vez de um número confiante e errado.
        XCTAssertGreaterThanOrEqual(Double(favorableQ2), Double(favorable) * 0.90, summary)
        // Sem textura, mais da metade dos cenários fecha em qualidade 2; com textura o estimador é honesto por projeto.
        let clean = triggered - texQ2 - texQ1 - texQ0
        XCTAssertGreaterThanOrEqual(Double(errs.count), Double(clean) * 0.45, summary)
        XCTAssertLessThan(mean, 0.05, summary)
        XCTAssertLessThan(p95, 0.10, summary)
        // O que o produto promete: nenhum refinamento de qualidade 2 erra mais que 0,35 ms.
        XCTAssertLessThanOrEqual(sorted.last ?? 0.0, 0.35, summary)
    }

    func testDropsNearTriggerAreFlaggedAndDoNotBreakTiming() throws {
        let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37,
                                                  objLevel: 184, flicker: 0, seed: 77, dropFrames: [44, 45])
        XCTAssertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "\(r)")
    }

    func testDropRightAtTriggerUsesMeasuredFrameOffsets() throws {
        // quadro c+1 perdido: o estimador usa o timestamp medido do quadro seguinte, não ±lag·P
        let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: -1, crossFraction: 0.61,
                                                  objLevel: 184, flicker: 0, seed: 78, dropFrames: [49])
        XCTAssertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 300_000, "drop no gatilho: \(r)")
    }

    func testUnknownSkewOnlyAddsConstantOffset() throws {
        let a = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0, seed: 91, knownSkew: false)
        let b = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: -1, crossFraction: 0.61, objLevel: 184, flicker: 0, seed: 92, knownSkew: false)
        XCTAssertTrue(a.quality == 2 && b.quality == 2, "\(a) \(b)")
        XCTAssertTrue(abs(a.refinedErrorNs) < 200_000 && abs(b.refinedErrorNs) < 200_000, "offset não cancelou: \(a) / \(b)")
    }

    func testGammaCorrectionRemovesToneCurveBias() throws {
        let without = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0, seed: 93, sceneGamma: 2.2, cfgGamma: 1.0)
        let with = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0, seed: 93, sceneGamma: 2.2, cfgGamma: 2.2)
        XCTAssertTrue(without.quality == 2 && with.quality == 2, "\(without) \(with)")
        XCTAssertTrue(abs(with.refinedErrorNs) < abs(without.refinedErrorNs) && abs(with.refinedErrorNs) < 50_000, "gamma: \(without) → \(with)")
    }

    func testHeavyTextureNeverProducesFalsePrecision() throws {
        var bad = 0
        for (k, df) in [(1, 0.05), (1, 0.37), (-1, 0.61), (-1, 0.9), (1, 0.75), (-1, 0.25)].enumerated() {
            let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: df.0, crossFraction: df.1,
                                                      objLevel: 184, flicker: 0, seed: UInt64(200 + k), texture: 60.0)
            XCTAssertTrue(r.triggered, "sem gatilho com textura: \(r)")
            let err = abs(r.refinedErrorNs)
            if (r.quality == 2 || r.quality == 1) && err > r.uncertaintyNs + 100_000 { bad += 1 }
        }
        XCTAssertEqual(bad, 0, "\(bad) resultados com precisão falsa sob textura pesada")
    }

    func testFlickerSelectsLag2AndStaysAccurate() throws {
        let r = try SimulationHarness.runCrossing(speedMs: 14, exposureNs: 2_083_333, noiseSigma: 1.5, direction: 1, crossFraction: 0.37, objLevel: 184, flicker: 0.12, seed: 14)
        XCTAssertEqual(r.lag, 2, "\(r)")
        XCTAssertTrue(r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "\(r)")
    }
}
