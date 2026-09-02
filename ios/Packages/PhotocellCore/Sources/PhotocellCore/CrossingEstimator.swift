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
    /// Colunas cuja dispersão de tempos excede o que o ruído explica (textura/inclinação).
    public var texturedColumns: Int = 0
}

/// Estimador sub-quadro por fração de exposição (porte fiel de Tools/photocell_reference.py).
///
/// Cada pixel integra a luz durante [t_ini, t_ini + E]; se o bordo (luma O) cobre o pixel (fundo B)
/// em t_x dentro da janela, V = B + (O − B)·f com f = (t_ini + E − t_x)/E ⇒ t_x = t_ini + E·(1 − f).
/// O bordo se move a velocidade constante: t_x(coluna) = t_c + s·dx. Um ajuste linear ponderado
/// sobre as MEDIANAS por coluna dos pixels "interiores" de três quadros (c−lag, c, c+lag; deslocamentos
/// de tempo MEDIDOS pelos timestamps) devolve t_c (cruzamento do plano central) e a velocidade.
///
/// Passo 1 seleciona os pixels interiores pelo valor OBSERVADO usando o platô (c+2·lag) como O; o
/// passo 2 reseleciona pelo valor PREVISTO pelo ajuste (sem viés de seleção) e usa um O LOCAL: a
/// mediana das 3 colunas logo atrás do bordo, na mesma linha e quadro (textura do objeto). A incerteza
/// (3σ) é propagada do ruído por pixel, usando por coluna o maior entre a variância do modelo e a
/// amostral, mais um termo de textura (variância espacial do platô) e a dispersão residual entre
/// colunas quando há colunas "texturizadas". Incerteza ≤ P/8 ⇒ qualidade 2; senão intervalo (1); sem
/// informação ⇒ tempo do quadro (0).
public enum CrossingEstimator {
    private struct ColumnStats {
        var good: [Int]
        var t: [Double]
        var variance: [Double]
        var textured: Int
        var crms: [Double]
    }
    private struct LineFit {
        var tc: Double
        var slope: Double
        var varT: Double
    }

    /// Desfaz a curva de tom (gamma) para que V seja linear em f; gamma == 1 desliga.
    public static func linearize(_ v: Double, gamma: Double) -> Double {
        if gamma == 1.0 { return v }
        if v <= 0.0 { return 0.0 }
        return 255.0 * pow(v / 255.0, gamma)
    }

    public static func estimate(cfg: PhotocellConfig, roi: RoiRect, planeHeight: Int,
                                input inp: CrossingInput, noiseSigmaPx: Double) -> CrossingEstimate {
        let p = cfg.framePeriodNs
        // Intervalo físico do gatilho, sem hipóteses sobre contraste: do início da exposição do último
        // quadro VISTO (primeira linha da banda) ao fim da exposição do candidato (última linha), mais o
        // atraso até o centro ((core−1)/2 px à velocidade mínima plausível).
        func rowOffset(_ row: Int) -> Int64 {
            if let skew = cfg.skewNs { return floorDiv(Int64(roi.y0 + row) * skew, Int64(planeHeight)) }
            return 0
        }
        let coreHalfPx = Double(cfg.coreWidth - 1) / 2.0 + cfg.q0TiltAllowancePxPerRow * (Double(roi.height) / 2.0)
        let coreLagNs = Int64((coreHalfPx * 1e9 / cfg.speedPxPerSMin + 0.5).rounded(.down))
        var lastSeen = inp.tsNs - p
        if let seen = inp.lastSeenTsNs, seen < inp.tsNs { lastSeen = seen }
        let noneLo = lastSeen + rowOffset(0)
        let noneHi = inp.tsNs + rowOffset(roi.height - 1) + cfg.exposureNs + coreLagNs
        let none = CrossingEstimate(quality: 0, refinedTsNs: floorDiv(noneLo + noneHi, 2), uncertaintyNs: floorDiv(noneHi - noneLo, 2),
                                    interiorCount: 0, boundCount: 0, lowerNs: nil, upperNs: nil, texturedColumns: 0)
        let n = inp.stripCur.count
        guard n > 0, let plateauStrip = inp.plateauStrip, plateauStrip.count == n,
              inp.stripPrev.count == n, inp.stripBg.count == n else { return none }
        let h = roi.height
        let w = roi.width
        if w * h != n { return none }
        let e = Double(cfg.exposureNs)
        let gamma = cfg.gamma
        let kSig = cfg.fractionMarginSigmas
        let noiseTerm = kSig * (2.0).squareRoot() * noiseSigmaPx
        let center = Double(w - 1) / 2.0
        var frameStrips: [[UInt8]] = [inp.stripPrev, inp.stripCur]
        var frameOffsets: [Double] = [Double(inp.prevTsNs - inp.tsNs), 0.0]
        if let nx = inp.nextStrip, nx.count == n, let nxTs = inp.nextTsNs {
            frameStrips.append(nx)
            frameOffsets.append(Double(nxTs - inp.tsNs))
        }
        let nFrames = frameStrips.count
        let sMin = 1e9 / cfg.speedPxPerSMax
        let sMax = 1e9 / cfg.speedPxPerSMin
        let minRows = max(max(1, cfg.minInteriorRowsPerColumn), Int((cfg.minInteriorRowsFraction * Double(h)).rounded(.up)))
        let uncFloor = max(max(1, cfg.exposureNs / 50), cfg.systematicUncNs)
        let satLo = Double(cfg.saturationLow)
        let satHi = Double(cfg.saturationHigh)
        func saturated(_ raw: Double) -> Bool { raw <= satLo || raw >= satHi }
        let uncQ2Max = p / 8                      // acima disso o ajuste vira intervalo (qualidade 1)
        func rowTime(_ row: Int) -> Int64 {
            if let skew = cfg.skewNs { return inp.tsNs + floorDiv(Int64(roi.y0 + row) * skew, Int64(planeHeight)) }
            return inp.tsNs
        }

        // fundo e platô linearizados uma vez
        var bgLin = [Double](repeating: 0, count: n)
        var plateauLin = [Double](repeating: 0, count: n)
        for i in 0..<n {
            bgLin[i] = linearize(inp.stripBg[i], gamma: gamma)
            plateauLin[i] = linearize(Double(plateauStrip[i]), gamma: gamma)
        }
        // Textura do objeto: variância espacial do platô ao longo das colunas (mediana das linhas), além
        // do ruído. Entra como variância adicional COERENTE por coluna (não cai com sqrt(n)).
        var rowVars = [Double](repeating: 0, count: h)
        for row in 0..<h {
            let o = row * w
            var meanP = 0.0
            for i in 0..<w { meanP += plateauLin[o + i] }
            meanP = meanP / Double(w)
            var ssP = 0.0
            for i in 0..<w {
                let d = plateauLin[o + i] - meanP
                ssP += d * d
            }
            rowVars[row] = ssP / Double(w)
        }
        let texVarPx = median(rowVars, count: h) - noiseSigmaPx * noiseSigmaPx
        let aTex = texVarPx > 0.0 ? texVarPx.squareRoot() : 0.0
        // A textura também limita a classificação coberto/interior: margem = maior entre ruído e ~1,5·aTex
        let texTerm = 1.5 * aTex
        let marginTerm = noiseTerm >= texTerm ? noiseTerm : texTerm

        var interior = 0
        var bounds = 0
        var lower: Double? = nil
        var upper: Double? = nil
        // colunas cobertas / descobertas por quadro (contagem de linhas): sentido do bordo no fallback
        var covCnt = [Int](repeating: 0, count: nFrames * w)
        var uncCnt = [Int](repeating: 0, count: nFrames * w)
        let maxPerCol = h * nFrames

        // ---- passo 1: seleção pelo valor observado + limites --------------------------------
        var colSumW = [Double](repeating: 0, count: w)
        var colTimes = [[Double]](repeating: [Double](repeating: 0, count: maxPerCol), count: w)
        var devs = [Double](repeating: 0, count: maxPerCol)   // desvios |t − mediana| para a MAD (reutilizado)
        var colS2 = [Double](repeating: 0, count: w)
        var colN = [Int](repeating: 0, count: w)
        for row in 0..<h {
            let tRow = rowTime(row)
            for i in 0..<w {
                let idx = row * w + i
                // fundo ou platô saturados: o modelo linear não vale neste pixel
                if saturated(inp.stripBg[idx]) || saturated(Double(plateauStrip[idx])) { continue }
                let b = bgLin[idx]
                let o = plateauLin[idx]
                let contrast = o - b
                let c = contrast >= 0.0 ? contrast : -contrast
                if c < cfg.minContrast { continue }
                let dx = Double(i) - center
                let isCenterCol = abs(dx) <= 0.5
                let centerSlack = abs(dx) * sMax
                var m = marginTerm / c
                if m < cfg.fractionMarginMin { m = cfg.fractionMarginMin }
                if m >= 0.5 { continue }
                let usableInterior = m <= cfg.fractionMarginMax
                let lo = m
                let hi = 1.0 - m
                let upOff = e * 2.0 * m
                let loOff = e * (1.0 - 2.0 * m)
                let wgt = contrast * contrast
                let st = e * m / kSig
                for k in 0..<nFrames {
                    let raw = Double(frameStrips[k][idx])
                    if saturated(raw) { continue }
                    let f = (linearize(raw, gamma: gamma) - b) / contrast
                    let tIni = Double(tRow) + frameOffsets[k]
                    if f > lo && f < hi {
                        if usableInterior {
                            let t = tIni + e * (1.0 - f)
                            colSumW[i] += wgt
                            colTimes[i][colN[i]] = t
                            colS2[i] += st * st
                            colN[i] += 1
                            interior += 1
                        }
                    } else if f >= hi {
                        covCnt[k * w + i] += 1
                        if isCenterCol {
                            bounds += 1
                            let u = tIni + upOff + centerSlack
                            if upper == nil || u < upper! { upper = u }
                        }
                    } else if f <= lo {
                        uncCnt[k * w + i] += 1
                        if isCenterCol {
                            bounds += 1
                            let lw = tIni + loOff - centerSlack
                            if lower == nil || lw > lower! { lower = lw }
                        }
                    }
                }
            }
        }
        var lowerI: Int64? = lower.map { Int64(($0 + 0.5).rounded(.down)) }
        var upperI: Int64? = upper.map { Int64(($0 + 0.5).rounded(.down)) }
        var texturedCols = 0

        func intervalResult(_ loNs: Int64?, _ hiNs: Int64?, _ quality: Int) -> CrossingEstimate? {
            guard let lo = loNs, let hi = hiNs else { return nil }
            // limites contraditórios (classificação corrompida, p.ex. textura): sem informação honesta
            if lo > hi { return nil }
            let a = lo
            let bb = hi
            if floorDiv(bb - a, 2) > p / 2 { return nil }
            let mid = floorDiv(a + bb, 2)
            return CrossingEstimate(quality: quality, refinedTsNs: mid, uncertaintyNs: floorDiv(bb - a, 2),
                                    interiorCount: interior, boundCount: bounds, lowerNs: a, upperNs: bb,
                                    texturedColumns: texturedCols)
        }

        /// Qualidade 2 se a incerteza (3σ) propagada do ajuste é pequena; senão intervalo.
        func fittedResult(_ tEst: Double, _ varT: Double) -> CrossingEstimate? {
            var unc = Int64((3.0 * varT.squareRoot() + 0.5).rounded(.down))
            if unc < uncFloor { unc = uncFloor }
            let refined = Int64((tEst + 0.5).rounded(.down))
            if unc <= uncQ2Max {
                return CrossingEstimate(quality: 2, refinedTsNs: refined, uncertaintyNs: unc, interiorCount: interior,
                                        boundCount: bounds, lowerNs: lowerI, upperNs: upperI, texturedColumns: texturedCols)
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

        /// Colunas confiáveis, mediana, variância da mediana por coluna e número de colunas texturizadas.
        func columnStats(_ sumW: [Double], _ times: [[Double]], _ s2: [Double], _ cnt: [Int]) -> ColumnStats {
            var good: [Int] = []
            for c in 0..<w where cnt[c] > 0 && cnt[c] >= minRows { good.append(c) }
            var t = [Double](repeating: 0, count: w)
            var variance = [Double](repeating: 0, count: w)
            var crms = [Double](repeating: 0, count: w)
            var textured = 0
            for c in 0..<w {
                let nc = cnt[c]
                if nc == 0 { continue }
                let fn = Double(nc)
                t[c] = median(times[c], count: nc)
                // variância da mediana da coluna ~ (π/2) · variância da média (modelo de ruído)
                let varModel = (Double.pi / 2.0) * s2[c] / (fn * fn)
                // dispersão amostral ROBUSTA: (1,4826·MAD)² — pixels espúrios isolados não marcam a coluna
                // como texturizada nem inflam a incerteza; textura de verdade é coerente e aparece na MAD
                let medC = t[c]
                for k in 0..<nc { devs[k] = abs(times[c][k] - medC) }
                let mad = nc >= 2 ? median(devs, count: nc) : 0.0
                let sigR = 1.4826 * mad
                let varS = sigR * sigR
                let varEmp = (Double.pi / 2.0) * varS / fn
                variance[c] = varModel >= varEmp ? varModel : varEmp
                // contraste RMS da coluna (sumW = soma de contrast²), para o termo coerente de textura
                crms[c] = (sumW[c] / fn).squareRoot()
                if nc >= minRows {
                    let sigmaModelPx = (s2[c] / fn).squareRoot()
                    if varS.squareRoot() > 3.0 * sigmaModelPx + e / 10.0 { textured += 1 }
                }
            }
            return ColumnStats(good: good, t: t, variance: variance, textured: textured, crms: crms)
        }

        /// Variância COERENTE (não cai com o número de pixels/colunas) de t causada pela textura do objeto.
        func texVar(_ crms: Double) -> Double {
            let tTex = e * aTex / crms
            return tTex * tTex
        }

        /// Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
        /// fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou nil.
        func fitLine(_ good: [Int], _ sumW: [Double], _ colT: [Double], _ colVar: [Double], _ textured: Int, _ colCrms: [Double]) -> LineFit? {
            var fitCols = good
            for _ in 0..<3 {
                var gw = 0.0, gx = 0.0, gt = 0.0, gxx = 0.0, gxt = 0.0
                for col in fitCols {
                    let wc = sumW[col]
                    let tc = colT[col]
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
                    let res = abs(colT[col] - (tc + slope * (Double(col) - center)))
                    if res > worstRes { worstRes = res; worst = col }
                }
                if let wcol = worst, worstRes > e + Double(p) / 4.0, fitCols.count > 2 {
                    fitCols.removeAll { $0 == wcol }
                    continue
                }
                if worstRes <= e + Double(p) / 4.0 && abs(slope) >= sMin && abs(slope) <= sMax {
                    // propagação: t_c = Σ a_c·t_col(c), a_c = w_c/gw − gx·w_c·(gw·dx_c − gx)/(denom·gw)
                    var varT = 0.0
                    var chi2 = 0.0
                    var resSs = 0.0
                    for col in fitCols {
                        let wc = sumW[col]
                        let dxc = Double(col) - center
                        let ac = wc / gw - gx * wc * (gw * dxc - gx) / (denom * gw)
                        varT += ac * ac * colVar[col]
                        let res = colT[col] - (tc + slope * dxc)
                        chi2 += colVar[col] > 0.0 ? res * res / colVar[col] : 0.0
                        resSs += res * res
                    }
                    // resíduos entre colunas maiores do que as variâncias explicam: escala pelo χ² reduzido
                    let dof = fitCols.count - 2
                    if dof >= 1 {
                        let chi2r = chi2 / Double(dof)
                        if chi2r > 1.0 { varT = varT * chi2r }
                    }
                    // com colunas texturizadas os erros são coerentes: incerteza ≥ dispersão residual
                    if textured > 0 {
                        let resMs2 = resSs / Double(fitCols.count)
                        if resMs2 > varT { varT = resMs2 }
                    }
                    // textura do objeto: erro coerente, somado DEPOIS da propagação (não é reduzido pelo ajuste)
                    var crms = 0.0
                    for col in fitCols { crms += colCrms[col] }
                    crms = crms / Double(fitCols.count)
                    varT += texVar(crms)
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
        texturedCols = stats1.textured
        if texturedCols > 0 || texTerm > noiseTerm {
            // os limites foram classificados com o platô como O: com textura (detectada no platô ou na
            // dispersão das colunas) não são confiáveis
            lowerI = nil
            upperI = nil
        }
        if !goodCols.isEmpty {
            var fit = fitLine(goodCols, colSumW, colT, colVar, texturedCols, stats1.crms)
            // ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO, O local ------------------
            for _ in 0..<2 {
                guard let f1 = fit else { break }
                let behind = f1.slope > 0.0 ? -1 : 1     // bordo vindo da esquerda (s > 0): atrás = colunas menores
                var sumW2 = [Double](repeating: 0, count: w)
                var times2 = [[Double]](repeating: [Double](repeating: 0, count: maxPerCol), count: w)
                var s22 = [Double](repeating: 0, count: w)
                var n2 = [Int](repeating: 0, count: w)
                var neigh = [Double](repeating: 0, count: 3)
                for row in 0..<h {
                    let tRow = rowTime(row)
                    for i in 0..<w {
                        let idx = row * w + i
                        if saturated(inp.stripBg[idx]) || saturated(Double(plateauStrip[idx])) { continue }
                        let b = bgLin[idx]
                        let tPred = f1.tc + f1.slope * (Double(i) - center)
                        for k in 0..<nFrames {
                            let strip = frameStrips[k]
                            let tIni = Double(tRow) + frameOffsets[k]
                            let fPred = (tIni + e - tPred) / e
                            if !(fPred > 0.0 && fPred < 1.0) { continue }
                            if saturated(Double(strip[idx])) { continue }
                            // O local: mediana das até 3 colunas logo atrás do bordo, mesma linha e quadro,
                            // previstas E observadas totalmente cobertas; senão o platô.
                            var nNeigh = 0
                            for d in 1...3 {
                                let j = i + behind * d
                                if j < 0 || j >= w { break }
                                let tPredJ = f1.tc + f1.slope * (Double(j) - center)
                                if tPredJ > tIni { continue }
                                if saturated(Double(strip[row * w + j])) || saturated(inp.stripBg[row * w + j]) ||
                                    saturated(Double(plateauStrip[row * w + j])) { continue }
                                let vj = linearize(Double(strip[row * w + j]), gamma: gamma)
                                let bj = bgLin[row * w + j]
                                let cj = plateauLin[row * w + j] - bj
                                if cj == 0.0 { continue }
                                var mj = marginTerm / (cj >= 0.0 ? cj : -cj)
                                if mj < cfg.fractionMarginMin { mj = cfg.fractionMarginMin }
                                if (vj - bj) / cj >= 1.0 - mj { neigh[nNeigh] = vj; nNeigh += 1 }
                            }
                            let o = nNeigh > 0 ? median(neigh, count: nNeigh) : plateauLin[idx]
                            let contrast = o - b
                            let c = contrast >= 0.0 ? contrast : -contrast
                            if c < cfg.minContrast { continue }
                            var m = marginTerm / c
                            if m < cfg.fractionMarginMin { m = cfg.fractionMarginMin }
                            if m > cfg.fractionMarginMax { continue }
                            if !(fPred > m && fPred < 1.0 - m) { continue }
                            let f = (linearize(Double(strip[idx]), gamma: gamma) - b) / contrast
                            let t = tIni + e * (1.0 - f)
                            let wgt = contrast * contrast
                            let st = e * m / kSig
                            sumW2[i] += wgt
                            times2[i][n2[i]] = t
                            s22[i] += st * st
                            n2[i] += 1
                        }
                    }
                }
                let stats2 = columnStats(sumW2, times2, s22, n2)
                let fit2 = stats2.good.isEmpty ? nil : fitLine(stats2.good, sumW2, stats2.t, stats2.variance, stats2.textured, stats2.crms)
                guard let f2 = fit2 else { break }
                fit = f2
                texturedCols = stats2.textured
            }
            if let f = fit, let r = fittedResult(f.tc, f.varT) { return r }
            // uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
            var col = goodCols[0]
            for c2 in goodCols where colSumW[c2] > colSumW[col] { col = c2 }
            let dx0 = Double(col) - center
            let tInt = colT[col]
            if abs(dx0) < 0.5, let r = fittedResult(tInt, colVar[col] + texVar(stats1.crms[col])) { return r }
            // sentido do bordo: no primeiro quadro (c-lag, c, c+lag) em que a cobertura é assimétrica em
            // torno da coluna interior — cobertas atrás, descobertas à frente (só o candidato não basta:
            // com bordo rápido ou período longo a faixa inteira já está coberta nele)
            var leftCov = false
            var rightCov = false
            for k in 0..<nFrames {
                var lSide = false
                var rSide = false
                for c2 in 0..<w {
                    if covCnt[k * w + c2] >= minRows { if c2 < col { lSide = true } else if c2 > col { rSide = true } }
                    if uncCnt[k * w + c2] >= minRows { if c2 > col { lSide = true } else if c2 < col { rSide = true } }
                }
                if lSide != rSide { leftCov = lSide; rightCov = rSide; break }
            }
            var cands: [Double] = []
            if leftCov || !rightCov { cands += [tInt - dx0 * sMin, tInt - dx0 * sMax] }
            if rightCov || !leftCov { cands += [tInt + dx0 * sMin, tInt + dx0 * sMax] }
            // incerteza da coluna: maior entre ±E·m/sqrt(n) e 3σ da variância da coluna
            let mCol = noiseTerm / max(cfg.minContrast, 1.0)
            var colUnc = e * min(mCol, 0.5) / Double(max(1, colN[col])).squareRoot()
            let colUnc3 = 3.0 * (colVar[col] + texVar(stats1.crms[col])).squareRoot()
            if colUnc3 > colUnc { colUnc = colUnc3 }
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

    /// Mediana determinística dos primeiros `count` valores (n par: média dos dois centrais).
    private static func median(_ values: [Double], count: Int) -> Double {
        let v = Array(values[0..<count]).sorted()
        return count % 2 == 1 ? v[count / 2] : (v[count / 2 - 1] + v[count / 2]) / 2.0
    }
}
