import Foundation

/// Resultado do refinamento sub-quadro.
/// quality: 0 = sem refinamento; 1 = só limites/intervalo; 2 = ajuste completo.
public struct CrossingEstimate: Equatable, Sendable {
    public var quality: Int
    public var refinedTsNs: Nanos
    public var uncertaintyNs: Nanos
    public var interiorCount: Int
    public var boundCount: Int
    public var lowerNs: Nanos?
    public var upperNs: Nanos?
}

/// Estimador sub-quadro por fração de exposição (porte fiel de Tools/photocell_reference.py).
///
/// Cada pixel integra a luz durante [t_ini, t_ini + E]; se o bordo (luma O) cobre o pixel (fundo B)
/// em t_x dentro da janela, V = B + (O − B)·f com f = (t_ini + E − t_x)/E ⇒ t_x = t_ini + E·(1 − f).
/// O bordo se move a velocidade constante: t_x(coluna) = t_c + s·dx. Um ajuste linear ponderado
/// sobre as MEDIANAS por coluna dos pixels "interiores" de três quadros (c−lag, c, c+lag) devolve
/// t_c (cruzamento do plano central) e a velocidade, cancelando o viés de direção.
///
/// Passo 1 seleciona os pixels interiores pelo valor OBSERVADO (m < f < 1−m); como essa seleção é
/// correlacionada com o sinal do ruído perto dos cortes, o passo 2 reseleciona pelo valor PREVISTO
/// pelo ajuste e usa o f observado sem corte (não enviesado). A incerteza (3σ) é propagada do ruído
/// por pixel através do ajuste: pequena (≤ P/8) ⇒ qualidade 2; senão intervalo (qualidade 1).
/// Pixels saturados só dão limites; colunas com poucas linhas não entram; inclinação implausível ou
/// coluna única ⇒ intervalo (qualidade 1) pela faixa de velocidades.
public enum CrossingEstimator {
    private struct ColumnStats {
        var good: [Int]
        var t: [Int: Double]
        var variance: [Int: Double]
    }
    private struct LineFit {
        var tc: Double
        var slope: Double
        var varT: Double
    }

    public static func estimate(cfg: PhotocellConfig, roi: RoiRect, planeHeight: Int,
                                cand: FrameMeasurement, nextStrip: [UInt8]?, plateauStrip: [UInt8]?,
                                noiseSigmaPx: Double) -> CrossingEstimate {
        let p = cfg.framePeriodNs
        // Sem refinamento possível, a melhor estimativa é o meio da janela de exposição da banda.
        var midRowOffset: Int64 = 0
        if let skew = cfg.skewNs { midRowOffset = floorDiv(Int64(roi.y0 + roi.height / 2) * skew, Int64(planeHeight)) }
        let none = CrossingEstimate(quality: 0, refinedTsNs: cand.tsNs + midRowOffset + cfg.exposureNs / 2, uncertaintyNs: p / 2,
                                    interiorCount: 0, boundCount: 0, lowerNs: nil, upperNs: nil)
        let n = cand.stripCur.count
        guard n > 0, let plateau = plateauStrip, plateau.count == n,
              cand.stripPrev.count == n, cand.stripBg.count == n else { return none }
        let h = roi.height
        let w = roi.width
        if w * h != n { return none }
        let e = Double(cfg.exposureNs)
        let lag = Int64(cand.lag)
        let kSig = cfg.fractionMarginSigmas
        let noiseTerm = kSig * (2.0).squareRoot() * noiseSigmaPx
        let center = Double(w - 1) / 2.0
        var frames: [([UInt8], Double)] = [(cand.stripPrev, -Double(lag * p)), (cand.stripCur, 0.0)]
        if let nx = nextStrip, nx.count == n { frames.append((nx, Double(lag * p))) }
        let sMin = 1e9 / cfg.speedPxPerSMax
        let sMax = 1e9 / cfg.speedPxPerSMin
        let minRows = max(max(1, cfg.minInteriorRowsPerColumn), Int((cfg.minInteriorRowsFraction * Double(h)).rounded(.up)))
        let uncFloor = max(1, cfg.exposureNs / 50)
        let uncQ2Max = p / 8                      // acima disso o ajuste vira intervalo (qualidade 1)
        func rowTime(_ row: Int) -> Int64 {
            if let skew = cfg.skewNs { return cand.tsNs + floorDiv(Int64(roi.y0 + row) * skew, Int64(planeHeight)) }
            return cand.tsNs
        }

        var interior = 0
        var bounds = 0
        var lower: Double? = nil
        var upper: Double? = nil
        var coveredColsCand = Set<Int>()

        // ---- passo 1: seleção pelo valor observado + limites --------------------------------
        var colSumW: [Int: Double] = [:]
        var colTimes: [Int: [Double]] = [:]   // t_x por coluna (mediana resiste a pixels espúrios)
        var colS2: [Int: Double] = [:]        // soma das variâncias de t por pixel
        var colN: [Int: Int] = [:]
        for row in 0..<h {
            let tRow = rowTime(row)
            for i in 0..<w {
                let idx = row * w + i
                let b = cand.stripBg[idx]
                let o = Double(plateau[idx])
                let contrast = o - b
                let c = contrast >= 0.0 ? contrast : -contrast
                if c < cfg.minContrast { continue }
                let dx = Double(i) - center
                // Limites só da coluna central (dx = 0): em outra coluna o limite valeria para t_x(dx),
                // não para t_c. Com largura par (dx = ±0,5) aplica-se uma folga de |dx|·s_max.
                let isCenterCol = abs(dx) <= 0.5
                let centerSlack = abs(dx) * sMax
                var m = noiseTerm / c
                if m < cfg.fractionMarginMin { m = cfg.fractionMarginMin }
                if m >= 0.5 { continue }
                let usableInterior = m <= cfg.fractionMarginMax
                let lo = m
                let hi = 1.0 - m
                // Limites: f_obs >= 1-m com ruído até m implica f >= 1-2m, logo t_x <= t_ini + 2mE
                // (e simetricamente t_x >= t_ini + E(1-2m) para f_obs <= m).
                let upOff = e * 2.0 * m
                let loOff = e * (1.0 - 2.0 * m)
                let wgt = contrast * contrast
                let st = e * m / kSig                  // σ de t deste pixel (E·√2·σ_px/C)
                for k in 0..<frames.count {
                    let f = (Double(frames[k].0[idx]) - b) / contrast
                    let tIni = Double(tRow) + frames[k].1
                    if f > lo && f < hi {
                        if usableInterior {
                            let t = tIni + e * (1.0 - f)
                            colSumW[i, default: 0.0] += wgt
                            colTimes[i, default: []].append(t)
                            colS2[i, default: 0.0] += st * st
                            colN[i, default: 0] += 1
                            interior += 1
                        }
                    } else if f >= hi {
                        if k == 1 { coveredColsCand.insert(i) }
                        if isCenterCol {
                            bounds += 1
                            let u = tIni + upOff + centerSlack
                            if upper == nil || u < upper! { upper = u }
                        }
                    } else if f <= lo {
                        if isCenterCol {
                            bounds += 1
                            let lw = tIni + loOff - centerSlack
                            if lower == nil || lw > lower! { lower = lw }
                        }
                    }
                }
            }
        }
        let lowerI: Int64? = lower.map { Int64(($0 + 0.5).rounded(.down)) }
        let upperI: Int64? = upper.map { Int64(($0 + 0.5).rounded(.down)) }

        func intervalResult(_ loNs: Int64?, _ hiNs: Int64?, _ quality: Int) -> CrossingEstimate? {
            guard let lo = loNs, let hi = hiNs else { return nil }
            let a = lo <= hi ? lo : hi
            let bb = lo <= hi ? hi : lo
            if floorDiv(bb - a, 2) > p / 2 { return nil }
            let mid = floorDiv(a + bb, 2)
            return CrossingEstimate(quality: quality, refinedTsNs: mid, uncertaintyNs: floorDiv(bb - a, 2),
                                    interiorCount: interior, boundCount: bounds, lowerNs: a, upperNs: bb)
        }

        /// Qualidade 2 se a incerteza (3σ) propagada do ajuste é pequena; senão intervalo.
        func fittedResult(_ tEst: Double, _ varT: Double) -> CrossingEstimate? {
            var unc = Int64((3.0 * varT.squareRoot() + 0.5).rounded(.down))
            if unc < uncFloor { unc = uncFloor }
            let refined = Int64((tEst + 0.5).rounded(.down))
            if unc <= uncQ2Max {
                return CrossingEstimate(quality: 2, refinedTsNs: refined, uncertaintyNs: unc, interiorCount: interior,
                                        boundCount: bounds, lowerNs: lowerI, upperNs: upperI)
            }
            let a0 = refined - unc
            let b0 = refined + unc
            var a = a0
            var bb = b0
            if let l = lowerI, l > a { a = l }
            if let u = upperI, u < bb { bb = u }
            if a > bb { a = a0; bb = b0 }
            return intervalResult(a, bb, 1)
        }

        /// Colunas confiáveis (≥ minRows pixels), mediana e variância da mediana por coluna.
        func columnStats(_ sumW: [Int: Double], _ times: [Int: [Double]], _ s2: [Int: Double], _ cnt: [Int: Int]) -> ColumnStats {
            let good = sumW.keys.filter { (cnt[$0] ?? 0) >= minRows }.sorted()
            // Tempo por coluna = MEDIANA dos t_x dos pixels interiores: um único pixel saturado que o ruído
            // classificou como interior (erro ~P) não desloca a coluna, ao contrário da média ponderada.
            var t: [Int: Double] = [:]
            for (c, list) in times { t[c] = median(list) }
            // variância da mediana da coluna ~ (π/2) · variância da média
            var variance: [Int: Double] = [:]
            for (c, v) in s2 { variance[c] = (Double.pi / 2.0) * v / (Double(cnt[c]!) * Double(cnt[c]!)) }
            return ColumnStats(good: good, t: t, variance: variance)
        }

        /// Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
        /// fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou nil.
        func fitLine(_ good: [Int], _ sumW: [Int: Double], _ colT: [Int: Double], _ colVar: [Int: Double]) -> LineFit? {
            var fitCols = good
            for _ in 0..<3 {
                var gw = 0.0, gx = 0.0, gt = 0.0, gxx = 0.0, gxt = 0.0
                for col in fitCols {
                    let wc = sumW[col]!
                    let tc = colT[col]!
                    let dxc = Double(col) - center
                    gw += wc; gx += wc * dxc; gt += wc * tc; gxx += wc * dxc * dxc; gxt += wc * dxc * tc
                }
                let spread = fitCols.last! - fitCols.first!
                let denom = gw * gxx - gx * gx
                if !(spread >= 1 && denom > 1e-9 * gw * gxx && denom > 0.0) { return nil }
                let slope = (gw * gxt - gx * gt) / denom
                let tc = (gt - slope * gx) / gw
                var worst: Int? = nil
                var worstRes = 0.0
                for col in fitCols {
                    let res = abs(colT[col]! - (tc + slope * (Double(col) - center)))
                    if res > worstRes { worstRes = res; worst = col }
                }
                if let wcol = worst, worstRes > e + Double(p) / 4.0, fitCols.count > 2 {
                    fitCols.removeAll { $0 == wcol }
                    continue
                }
                if worstRes <= e + Double(p) / 4.0 && abs(slope) >= sMin && abs(slope) <= sMax {
                    // propagação: t_c = Σ a_c·t_col(c), a_c = w_c/gw − gx·w_c·(gw·dx_c − gx)/(denom·gw)
                    var varT = 0.0
                    for col in fitCols {
                        let wc = sumW[col]!
                        let dxc = Double(col) - center
                        let ac = wc / gw - gx * wc * (gw * dxc - gx) / (denom * gw)
                        varT += ac * ac * colVar[col]!
                    }
                    return LineFit(tc: tc, slope: slope, varT: varT)
                }
                return nil
            }
            return nil
        }

        let stats1 = columnStats(colSumW, colTimes, colS2, colN)
        let goodCols = stats1.good
        let colT = stats1.t
        let colVar = stats1.variance
        if !goodCols.isEmpty {
            var fit = fitLine(goodCols, colSumW, colT, colVar)
            // ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO ----------------------
            for _ in 0..<2 {
                guard let f1 = fit else { break }
                var sumW2: [Int: Double] = [:]
                var times2: [Int: [Double]] = [:]
                var s22: [Int: Double] = [:]
                var n2: [Int: Int] = [:]
                for row in 0..<h {
                    let tRow = rowTime(row)
                    for i in 0..<w {
                        let idx = row * w + i
                        let b = cand.stripBg[idx]
                        let o = Double(plateau[idx])
                        let contrast = o - b
                        let c = contrast >= 0.0 ? contrast : -contrast
                        if c < cfg.minContrast { continue }
                        var m = noiseTerm / c
                        if m < cfg.fractionMarginMin { m = cfg.fractionMarginMin }
                        if m > cfg.fractionMarginMax { continue }
                        let tPred = f1.tc + f1.slope * (Double(i) - center)
                        let wgt = contrast * contrast
                        let st = e * m / kSig
                        for k in 0..<frames.count {
                            let tIni = Double(tRow) + frames[k].1
                            let fPred = (tIni + e - tPred) / e
                            if fPred > m && fPred < 1.0 - m {
                                let f = (Double(frames[k].0[idx]) - b) / contrast
                                let t = tIni + e * (1.0 - f)
                                sumW2[i, default: 0.0] += wgt
                                times2[i, default: []].append(t)
                                s22[i, default: 0.0] += st * st
                                n2[i, default: 0] += 1
                            }
                        }
                    }
                }
                let stats2 = columnStats(sumW2, times2, s22, n2)
                let fit2 = stats2.good.isEmpty ? nil : fitLine(stats2.good, sumW2, stats2.t, stats2.variance)
                guard let f2 = fit2 else { break }
                fit = f2
            }
            if let f = fit, let r = fittedResult(f.tc, f.varT) { return r }
            // uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
            var col = goodCols[0]
            for c2 in goodCols where colSumW[c2]! > colSumW[col]! { col = c2 }
            let dx0 = Double(col) - center
            let tInt = colT[col]!
            if abs(dx0) < 0.5, let r = fittedResult(tInt, colVar[col]!) { return r }
            // sentido: colunas já cobertas no candidato ficam do lado de onde o bordo veio
            let leftCov = coveredColsCand.contains { $0 < col }
            let rightCov = coveredColsCand.contains { $0 > col }
            var cands: [Double] = []
            if leftCov || !rightCov { cands += [tInt - dx0 * sMin, tInt - dx0 * sMax] }
            if rightCov || !leftCov { cands += [tInt + dx0 * sMin, tInt + dx0 * sMax] }
            // incerteza da média da coluna: ±E·m/sqrt(n)
            let mCol = noiseTerm / max(cfg.minContrast, 1.0)
            let colUnc = e * min(mCol, 0.5) / Double(max(1, colN[col] ?? 1)).squareRoot()
            let a0 = Int64((cands.min()! - colUnc + 0.5).rounded(.down))
            let b0 = Int64((cands.max()! + colUnc + 0.5).rounded(.down))
            var a = a0
            var bb = b0
            if let l = lowerI, l > a { a = l }
            if let u = upperI, u < bb { bb = u }
            if a > bb { a = a0; bb = b0 }   // limites inconsistentes (ruído): só a faixa de velocidades
            if let r = intervalResult(a, bb, 1) { return r }
        }
        return intervalResult(lowerI, upperI, 1) ?? none
    }

    /// Mediana determinística (n par: média dos dois centrais) — mesma definição em Python/Kotlin.
    private static func median(_ values: [Double]) -> Double {
        let v = values.sorted()
        let n = v.count
        return n % 2 == 1 ? v[n / 2] : (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}
