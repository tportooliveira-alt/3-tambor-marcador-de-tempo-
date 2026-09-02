package br.com.tportooliveira.fotocelula.core

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * Resultado do refinamento sub-quadro.
 * quality: 0 = sem refinamento; 1 = só limites/intervalo; 2 = ajuste completo.
 */
data class CrossingEstimate(
    val quality: Int,
    val refinedTsNs: Nanos,
    val uncertaintyNs: Nanos,
    val interiorCount: Int,
    val boundCount: Int,
    val lowerNs: Nanos?,
    val upperNs: Nanos?,
    /** Colunas cuja dispersão de tempos excede o que o ruído explica (textura/inclinação). */
    val texturedColumns: Int = 0,
)

/**
 * Estimador sub-quadro por fração de exposição (porte fiel de Tools/photocell_reference.py).
 *
 * Cada pixel integra a luz durante [t_ini, t_ini + E]; se o bordo (luma O) cobre o pixel (fundo B)
 * em t_x dentro da janela, V = B + (O − B)·f com f = (t_ini + E − t_x)/E ⇒ t_x = t_ini + E·(1 − f).
 * O bordo se move a velocidade constante: t_x(coluna) = t_c + s·dx. Um ajuste linear ponderado
 * sobre as MEDIANAS por coluna dos pixels "interiores" de três quadros (c−lag, c, c+lag; deslocamentos
 * de tempo MEDIDOS pelos timestamps) devolve t_c (cruzamento do plano central) e a velocidade.
 *
 * Passo 1 seleciona os pixels interiores pelo valor OBSERVADO usando o platô (c+2·lag) como O; o
 * passo 2 reseleciona pelo valor PREVISTO pelo ajuste (sem viés de seleção) e usa um O LOCAL: a
 * mediana das 3 colunas logo atrás do bordo, na mesma linha e quadro (textura do objeto). A incerteza
 * (3σ) é propagada do ruído por pixel, usando por coluna o maior entre a variância do modelo e a
 * amostral, mais um termo de textura (variância espacial do platô) e a dispersão residual entre
 * colunas quando há colunas "texturizadas". Incerteza ≤ P/8 ⇒ qualidade 2; senão intervalo (1); sem
 * informação ⇒ tempo do quadro (0).
 */
object CrossingEstimator {
    private class ColumnStats(val good: IntArray, val t: DoubleArray, val variance: DoubleArray, val textured: Int, val crms: DoubleArray)
    private class LineFit(val tc: Double, val slope: Double, val varT: Double)

    /** Desfaz a curva de tom (gamma) para que V seja linear em f; gamma == 1 desliga. */
    fun linearize(v: Double, gamma: Double): Double {
        if (gamma == 1.0) return v
        if (v <= 0.0) return 0.0
        return 255.0 * Math.pow(v / 255.0, gamma)
    }

    fun estimate(cfg: PhotocellConfig, roi: RoiRect, planeHeight: Int, inp: CrossingInput, noiseSigmaPx: Double): CrossingEstimate {
        val p = cfg.framePeriodNs
        // Sem refinamento possível, a melhor estimativa é o meio da janela de exposição da banda.
        val midRowOffset = cfg.skewNs?.let { Math.floorDiv((roi.y0 + roi.height / 2).toLong() * it, planeHeight.toLong()) } ?: 0L
        val none = CrossingEstimate(0, inp.tsNs + midRowOffset + cfg.exposureNs / 2, p / 2, 0, 0, null, null, 0)
        val n = inp.stripCur.size
        val plateauStrip = inp.plateauStrip
        if (n == 0 || plateauStrip == null || plateauStrip.size != n || inp.stripPrev.size != n || inp.stripBg.size != n) return none
        val h = roi.height
        val w = roi.width
        if (w * h != n) return none
        val e = cfg.exposureNs.toDouble()
        val gamma = cfg.gamma
        val kSig = cfg.fractionMarginSigmas
        val noiseTerm = kSig * sqrt(2.0) * noiseSigmaPx
        val center = (w - 1) / 2.0
        val frameStrips = ArrayList<IntArray>()
        val frameOffsets = ArrayList<Double>()
        frameStrips.add(inp.stripPrev); frameOffsets.add((inp.prevTsNs - inp.tsNs).toDouble())
        frameStrips.add(inp.stripCur); frameOffsets.add(0.0)
        val nextStrip = inp.nextStrip
        val nextTs = inp.nextTsNs
        if (nextStrip != null && nextStrip.size == n && nextTs != null) {
            frameStrips.add(nextStrip); frameOffsets.add((nextTs - inp.tsNs).toDouble())
        }
        val nFrames = frameStrips.size
        val sMin = 1e9 / cfg.speedPxPerSMax
        val sMax = 1e9 / cfg.speedPxPerSMin
        val minRows = maxOf(1, cfg.minInteriorRowsPerColumn, Math.ceil(cfg.minInteriorRowsFraction * h).toInt())
        val uncFloor = maxOf(1L, cfg.exposureNs / 50)
        val uncQ2Max = p / 8                      // acima disso o ajuste vira intervalo (qualidade 1)
        val skew = cfg.skewNs
        fun rowTime(row: Int): Long =
            if (skew != null) inp.tsNs + Math.floorDiv((roi.y0 + row).toLong() * skew, planeHeight.toLong()) else inp.tsNs

        // fundo e platô linearizados uma vez
        val bgLin = DoubleArray(n) { linearize(inp.stripBg[it], gamma) }
        val plateauLin = DoubleArray(n) { linearize(plateauStrip[it].toDouble(), gamma) }
        // Textura do objeto: variância espacial do platô ao longo das colunas (mediana das linhas), além
        // do ruído. Entra como variância adicional COERENTE por coluna (não cai com sqrt(n)).
        val rowVars = DoubleArray(h)
        for (row in 0 until h) {
            val o = row * w
            var meanP = 0.0
            for (i in 0 until w) meanP += plateauLin[o + i]
            meanP = meanP / w.toDouble()
            var ssP = 0.0
            for (i in 0 until w) {
                val d = plateauLin[o + i] - meanP
                ssP += d * d
            }
            rowVars[row] = ssP / w.toDouble()
        }
        val texVarPx = median(rowVars, h) - noiseSigmaPx * noiseSigmaPx
        val aTex = if (texVarPx > 0.0) sqrt(texVarPx) else 0.0
        // A textura também limita a classificação coberto/interior: margem = maior entre ruído e ~1,5·aTex
        val texTerm = 1.5 * aTex
        val marginTerm = if (noiseTerm >= texTerm) noiseTerm else texTerm

        var interior = 0
        var bounds = 0
        var lower: Double? = null
        var upper: Double? = null
        val coveredColsCand = BooleanArray(w)
        val maxPerCol = h * nFrames

        // ---- passo 1: seleção pelo valor observado + limites --------------------------------
        val colSumW = DoubleArray(w)
        val colTimes = Array(w) { DoubleArray(maxPerCol) }
        val colS2 = DoubleArray(w)
        val colN = IntArray(w)
        for (row in 0 until h) {
            val tRow = rowTime(row)
            for (i in 0 until w) {
                val idx = row * w + i
                val b = bgLin[idx]
                val o = plateauLin[idx]
                val contrast = o - b
                val c = if (contrast >= 0.0) contrast else -contrast
                if (c < cfg.minContrast) continue
                val dx = i - center
                val isCenterCol = abs(dx) <= 0.5
                val centerSlack = abs(dx) * sMax
                var m = marginTerm / c
                if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin
                if (m >= 0.5) continue
                val usableInterior = m <= cfg.fractionMarginMax
                val lo = m
                val hi = 1.0 - m
                val upOff = e * 2.0 * m
                val loOff = e * (1.0 - 2.0 * m)
                val wgt = contrast * contrast
                val st = e * m / kSig
                for (k in 0 until nFrames) {
                    val f = (linearize(frameStrips[k][idx].toDouble(), gamma) - b) / contrast
                    val tIni = tRow.toDouble() + frameOffsets[k]
                    if (f > lo && f < hi) {
                        if (usableInterior) {
                            val t = tIni + e * (1.0 - f)
                            colSumW[i] += wgt
                            colTimes[i][colN[i]] = t
                            colS2[i] += st * st
                            colN[i] += 1
                            interior += 1
                        }
                    } else if (f >= hi) {
                        if (k == 1) coveredColsCand[i] = true
                        if (isCenterCol) {
                            bounds += 1
                            val u = tIni + upOff + centerSlack
                            if (upper == null || u < upper!!) upper = u
                        }
                    } else if (f <= lo) {
                        if (isCenterCol) {
                            bounds += 1
                            val lw = tIni + loOff - centerSlack
                            if (lower == null || lw > lower!!) lower = lw
                        }
                    }
                }
            }
        }
        var lowerI: Long? = lower?.let { floor(it + 0.5).toLong() }
        var upperI: Long? = upper?.let { floor(it + 0.5).toLong() }
        var texturedCols = 0

        fun intervalResult(loNs: Long?, hiNs: Long?, quality: Int): CrossingEstimate? {
            if (loNs == null || hiNs == null) return null
            // limites contraditórios (classificação corrompida, p.ex. textura): sem informação honesta
            if (loNs > hiNs) return null
            val a = loNs
            val bb = hiNs
            if (Math.floorDiv(bb - a, 2L) > p / 2) return null
            val mid = Math.floorDiv(a + bb, 2L)
            return CrossingEstimate(quality, mid, Math.floorDiv(bb - a, 2L), interior, bounds, a, bb, texturedCols)
        }

        /** Qualidade 2 se a incerteza (3σ) propagada do ajuste é pequena; senão intervalo. */
        fun fittedResult(tEst: Double, varT: Double): CrossingEstimate? {
            var unc = floor(3.0 * sqrt(varT) + 0.5).toLong()
            if (unc < uncFloor) unc = uncFloor
            val refined = floor(tEst + 0.5).toLong()
            if (unc <= uncQ2Max) return CrossingEstimate(2, refined, unc, interior, bounds, lowerI, upperI, texturedCols)
            val a0 = refined - unc
            val b0 = refined + unc
            var a = a0
            var bb = b0
            val li = lowerI
            val ui = upperI
            if (li != null && li > a) a = li
            if (ui != null && ui < bb) bb = ui
            if (a > bb) { a = a0; bb = b0 }
            return intervalResult(a, bb, 1)
        }

        /** Colunas confiáveis, mediana, variância da mediana por coluna e número de colunas texturizadas. */
        fun columnStats(sumW: DoubleArray, times: Array<DoubleArray>, s2: DoubleArray, cnt: IntArray): ColumnStats {
            val goodList = ArrayList<Int>()
            for (c in 0 until w) if (cnt[c] > 0 && cnt[c] >= minRows) goodList.add(c)
            val t = DoubleArray(w)
            val variance = DoubleArray(w)
            val crms = DoubleArray(w)
            var textured = 0
            for (c in 0 until w) {
                val nc = cnt[c]
                if (nc == 0) continue
                val fn = nc.toDouble()
                t[c] = median(times[c], nc)
                // variância da mediana da coluna ~ (π/2) · variância da média (modelo de ruído)
                val varModel = (PI / 2.0) * s2[c] / (fn * fn)
                // variância amostral dos tempos da coluna (dois passos, ordem de inserção)
                var mean = 0.0
                for (k in 0 until nc) mean += times[c][k]
                mean = mean / fn
                var ss = 0.0
                for (k in 0 until nc) {
                    val d = times[c][k] - mean
                    ss += d * d
                }
                val varS = if (nc >= 2) ss / (fn - 1.0) else 0.0
                val varEmp = (PI / 2.0) * varS / fn
                variance[c] = if (varModel >= varEmp) varModel else varEmp
                // contraste RMS da coluna (sumW = soma de contrast²), para o termo coerente de textura
                crms[c] = sqrt(sumW[c] / fn)
                if (nc >= minRows) {
                    val sigmaModelPx = sqrt(s2[c] / fn)
                    if (sqrt(varS) > 3.0 * sigmaModelPx + e / 10.0) textured += 1
                }
            }
            return ColumnStats(goodList.toIntArray(), t, variance, textured, crms)
        }

        /** Variância COERENTE (não cai com o número de pixels/colunas) de t causada pela textura do objeto. */
        fun texVar(crms: Double): Double {
            val tTex = e * aTex / crms
            return tTex * tTex
        }

        /**
         * Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
         * fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou null.
         */
        fun fitLine(good: IntArray, sumW: DoubleArray, colT: DoubleArray, colVar: DoubleArray, textured: Int, colCrms: DoubleArray): LineFit? {
            val fitCols = ArrayList<Int>()
            for (c in good) fitCols.add(c)
            for (iter in 0 until 3) {
                var gw = 0.0; var gx = 0.0; var gt = 0.0; var gxx = 0.0; var gxt = 0.0
                for (col in fitCols) {
                    val wc = sumW[col]
                    val tc = colT[col]
                    val dxc = col - center
                    gw += wc; gx += wc * dxc; gt += wc * tc; gxx += wc * dxc * dxc; gxt += wc * dxc * tc
                }
                val spread = fitCols.last() - fitCols.first()
                val denom = gw * gxx - gx * gx
                if (!(spread >= 1 && denom > 1e-9 * gw * gxx && denom > 0.0)) return null
                val slope = (gw * gxt - gx * gt) / denom
                val tc = (gt - slope * gx) / gw
                var worst: Int? = null
                var worstRes = 0.0
                for (col in fitCols) {
                    val res = abs(colT[col] - (tc + slope * (col - center)))
                    if (res > worstRes) { worstRes = res; worst = col }
                }
                if (worst != null && worstRes > e + p / 4.0 && fitCols.size > 2) { fitCols.remove(worst); continue }
                if (worstRes <= e + p / 4.0 && abs(slope) in sMin..sMax) {
                    // propagação: t_c = Σ a_c·t_col(c), a_c = w_c/gw − gx·w_c·(gw·dx_c − gx)/(denom·gw)
                    var varT = 0.0
                    var chi2 = 0.0
                    var resSs = 0.0
                    for (col in fitCols) {
                        val wc = sumW[col]
                        val dxc = col - center
                        val ac = wc / gw - gx * wc * (gw * dxc - gx) / (denom * gw)
                        varT += ac * ac * colVar[col]
                        val res = colT[col] - (tc + slope * dxc)
                        chi2 += if (colVar[col] > 0.0) res * res / colVar[col] else 0.0
                        resSs += res * res
                    }
                    // resíduos entre colunas maiores do que as variâncias explicam: escala pelo χ² reduzido
                    val dof = fitCols.size - 2
                    if (dof >= 1) {
                        val chi2r = chi2 / dof.toDouble()
                        if (chi2r > 1.0) varT = varT * chi2r
                    }
                    // com colunas texturizadas os erros são coerentes: incerteza ≥ dispersão residual
                    if (textured > 0) {
                        val resMs2 = resSs / fitCols.size.toDouble()
                        if (resMs2 > varT) varT = resMs2
                    }
                    // textura do objeto: erro coerente, somado DEPOIS da propagação (não é reduzido pelo ajuste)
                    var crms = 0.0
                    for (col in fitCols) crms += colCrms[col]
                    crms = crms / fitCols.size.toDouble()
                    varT += texVar(crms)
                    return LineFit(tc, slope, varT)
                }
                return null
            }
            return null
        }

        val stats1 = columnStats(colSumW, colTimes, colS2, colN)
        val goodCols = stats1.good
        val colT = stats1.t
        val colVar = stats1.variance
        texturedCols = stats1.textured
        if (texturedCols > 0 || texTerm > noiseTerm) {
            // os limites foram classificados com o platô como O: com textura (detectada no platô ou na
            // dispersão das colunas) não são confiáveis
            lowerI = null
            upperI = null
        }
        if (goodCols.isNotEmpty()) {
            var fit = fitLine(goodCols, colSumW, colT, colVar, texturedCols, stats1.crms)
            // ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO, O local ------------------
            for (iter in 0 until 2) {
                val f1 = fit ?: break
                val behind = if (f1.slope > 0.0) -1 else 1     // bordo vindo da esquerda (s > 0): atrás = colunas menores
                val sumW2 = DoubleArray(w)
                val times2 = Array(w) { DoubleArray(maxPerCol) }
                val s22 = DoubleArray(w)
                val n2 = IntArray(w)
                val neigh = DoubleArray(3)
                for (row in 0 until h) {
                    val tRow = rowTime(row)
                    for (i in 0 until w) {
                        val idx = row * w + i
                        val b = bgLin[idx]
                        val tPred = f1.tc + f1.slope * (i - center)
                        for (k in 0 until nFrames) {
                            val strip = frameStrips[k]
                            val tIni = tRow.toDouble() + frameOffsets[k]
                            val fPred = (tIni + e - tPred) / e
                            if (!(fPred > 0.0 && fPred < 1.0)) continue
                            // O local: mediana das até 3 colunas logo atrás do bordo, mesma linha e quadro,
                            // previstas E observadas totalmente cobertas; senão o platô.
                            var nNeigh = 0
                            for (d in 1..3) {
                                val j = i + behind * d
                                if (j < 0 || j >= w) break
                                val tPredJ = f1.tc + f1.slope * (j - center)
                                if (tPredJ > tIni) continue
                                val vj = linearize(strip[row * w + j].toDouble(), gamma)
                                val bj = bgLin[row * w + j]
                                val cj = plateauLin[row * w + j] - bj
                                if (cj == 0.0) continue
                                var mj = marginTerm / (if (cj >= 0.0) cj else -cj)
                                if (mj < cfg.fractionMarginMin) mj = cfg.fractionMarginMin
                                if ((vj - bj) / cj >= 1.0 - mj) { neigh[nNeigh] = vj; nNeigh += 1 }
                            }
                            val o = if (nNeigh > 0) median(neigh, nNeigh) else plateauLin[idx]
                            val contrast = o - b
                            val c = if (contrast >= 0.0) contrast else -contrast
                            if (c < cfg.minContrast) continue
                            var m = marginTerm / c
                            if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin
                            if (m > cfg.fractionMarginMax) continue
                            if (!(fPred > m && fPred < 1.0 - m)) continue
                            val f = (linearize(strip[idx].toDouble(), gamma) - b) / contrast
                            val t = tIni + e * (1.0 - f)
                            val wgt = contrast * contrast
                            val st = e * m / kSig
                            sumW2[i] += wgt
                            times2[i][n2[i]] = t
                            s22[i] += st * st
                            n2[i] += 1
                        }
                    }
                }
                val stats2 = columnStats(sumW2, times2, s22, n2)
                val fit2 = if (stats2.good.isNotEmpty()) fitLine(stats2.good, sumW2, stats2.t, stats2.variance, stats2.textured, stats2.crms) else null
                if (fit2 == null) break
                fit = fit2
                texturedCols = stats2.textured
            }
            if (fit != null) fittedResult(fit.tc, fit.varT)?.let { return it }
            // uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
            var col = goodCols[0]
            for (c2 in goodCols) if (colSumW[c2] > colSumW[col]) col = c2
            val dx0 = col - center
            val tInt = colT[col]
            if (abs(dx0) < 0.5) fittedResult(tInt, colVar[col] + texVar(stats1.crms[col]))?.let { return it }
            // sentido: colunas já cobertas no candidato ficam do lado de onde o bordo veio
            var leftCov = false
            var rightCov = false
            for (c2 in 0 until w) if (coveredColsCand[c2]) { if (c2 < col) leftCov = true; if (c2 > col) rightCov = true }
            val cands = ArrayList<Double>()
            if (leftCov || !rightCov) { cands.add(tInt - dx0 * sMin); cands.add(tInt - dx0 * sMax) }
            if (rightCov || !leftCov) { cands.add(tInt + dx0 * sMin); cands.add(tInt + dx0 * sMax) }
            // incerteza da coluna: maior entre ±E·m/sqrt(n) e 3σ da variância da coluna
            val mCol = noiseTerm / maxOf(cfg.minContrast, 1.0)
            var colUnc = e * minOf(mCol, 0.5) / sqrt(maxOf(1, colN[col]).toDouble())
            val colUnc3 = 3.0 * sqrt(colVar[col] + texVar(stats1.crms[col]))
            if (colUnc3 > colUnc) colUnc = colUnc3
            val a0 = floor(cands.min() - colUnc + 0.5).toLong()
            val b0 = floor(cands.max() + colUnc + 0.5).toLong()
            var a = a0
            var bb = b0
            val li = lowerI
            val ui = upperI
            if (li != null && li > a) a = li
            if (ui != null && ui < bb) bb = ui
            if (a > bb) { a = a0; bb = b0 }   // limites inconsistentes (ruído): só a faixa de velocidades
            intervalResult(a, bb, 1)?.let { return it }
        }
        return intervalResult(lowerI, upperI, 1) ?: none
    }

    /** Mediana determinística dos primeiros [count] valores (n par: média dos dois centrais). */
    private fun median(values: DoubleArray, count: Int): Double {
        val v = values.copyOf(count)
        v.sort()
        return if (count % 2 == 1) v[count / 2] else (v[count / 2 - 1] + v[count / 2]) / 2.0
    }
}
