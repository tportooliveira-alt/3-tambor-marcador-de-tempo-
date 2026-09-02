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
)

/**
 * Estimador sub-quadro por fração de exposição (porte fiel de Tools/photocell_reference.py).
 *
 * Cada pixel integra a luz durante [t_ini, t_ini + E]; se o bordo (luma O) cobre o pixel (fundo B)
 * em t_x dentro da janela, V = B + (O − B)·f com f = (t_ini + E − t_x)/E ⇒ t_x = t_ini + E·(1 − f).
 * O bordo se move a velocidade constante: t_x(coluna) = t_c + s·dx. Um ajuste linear ponderado
 * sobre as MEDIANAS por coluna dos pixels "interiores" de três quadros (c−lag, c, c+lag) devolve
 * t_c (cruzamento do plano central) e a velocidade, cancelando o viés de direção.
 *
 * Passo 1 seleciona os pixels interiores pelo valor OBSERVADO (m < f < 1−m); como essa seleção é
 * correlacionada com o sinal do ruído perto dos cortes, o passo 2 reseleciona pelo valor PREVISTO
 * pelo ajuste e usa o f observado sem corte (não enviesado). A incerteza (3σ) é propagada do ruído
 * por pixel através do ajuste: pequena (≤ P/8) ⇒ qualidade 2; senão intervalo (qualidade 1).
 * Pixels saturados só dão limites; colunas com poucas linhas não entram; inclinação implausível ou
 * coluna única ⇒ intervalo (qualidade 1) pela faixa de velocidades.
 */
object CrossingEstimator {
    private class ColumnStats(val good: List<Int>, val t: HashMap<Int, Double>, val variance: HashMap<Int, Double>)
    private class LineFit(val tc: Double, val slope: Double, val varT: Double)

    fun estimate(
        cfg: PhotocellConfig, roi: RoiRect, planeHeight: Int, cand: FrameMeasurement,
        nextStrip: IntArray?, plateauStrip: IntArray?, noiseSigmaPx: Double,
    ): CrossingEstimate {
        val p = cfg.framePeriodNs
        // Sem refinamento possível, a melhor estimativa é o meio da janela de exposição da banda.
        val midRowOffset = cfg.skewNs?.let { Math.floorDiv((roi.y0 + roi.height / 2).toLong() * it, planeHeight.toLong()) } ?: 0L
        val none = CrossingEstimate(0, cand.tsNs + midRowOffset + cfg.exposureNs / 2, p / 2, 0, 0, null, null)
        val n = cand.stripCur.size
        if (n == 0 || plateauStrip == null || plateauStrip.size != n || cand.stripPrev.size != n || cand.stripBg.size != n) return none
        val h = roi.height
        val w = roi.width
        if (w * h != n) return none
        val e = cfg.exposureNs.toDouble()
        val lag = cand.lag
        val kSig = cfg.fractionMarginSigmas
        val noiseTerm = kSig * sqrt(2.0) * noiseSigmaPx
        val center = (w - 1) / 2.0
        val frames = ArrayList<Pair<IntArray, Double>>()
        frames.add(cand.stripPrev to -(lag * p).toDouble())
        frames.add(cand.stripCur to 0.0)
        if (nextStrip != null && nextStrip.size == n) frames.add(nextStrip to (lag * p).toDouble())
        val sMin = 1e9 / cfg.speedPxPerSMax
        val sMax = 1e9 / cfg.speedPxPerSMin
        val minRows = maxOf(1, cfg.minInteriorRowsPerColumn, Math.ceil(cfg.minInteriorRowsFraction * h).toInt())
        val uncFloor = maxOf(1L, cfg.exposureNs / 50)
        val uncQ2Max = p / 8                      // acima disso o ajuste vira intervalo (qualidade 1)
        val skew = cfg.skewNs
        fun rowTime(row: Int): Long =
            if (skew != null) cand.tsNs + Math.floorDiv((roi.y0 + row).toLong() * skew, planeHeight.toLong()) else cand.tsNs

        var interior = 0
        var bounds = 0
        var lower: Double? = null
        var upper: Double? = null
        val coveredColsCand = HashSet<Int>()

        // ---- passo 1: seleção pelo valor observado + limites --------------------------------
        val colSumW = HashMap<Int, Double>()
        val colTimes = HashMap<Int, ArrayList<Double>>()   // t_x por coluna (mediana resiste a pixels espúrios)
        val colS2 = HashMap<Int, Double>()                 // soma das variâncias de t por pixel
        val colN = HashMap<Int, Int>()
        for (row in 0 until h) {
            val tRow = rowTime(row)
            for (i in 0 until w) {
                val idx = row * w + i
                val b = cand.stripBg[idx]
                val o = plateauStrip[idx].toDouble()
                val contrast = o - b
                val c = if (contrast >= 0.0) contrast else -contrast
                if (c < cfg.minContrast) continue
                val dx = i - center
                // Limites só da coluna central (dx = 0): em outra coluna o limite valeria para t_x(dx),
                // não para t_c. Com largura par (dx = ±0,5) aplica-se uma folga de |dx|·s_max.
                val isCenterCol = abs(dx) <= 0.5
                val centerSlack = abs(dx) * sMax
                var m = noiseTerm / c
                if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin
                if (m >= 0.5) continue
                val usableInterior = m <= cfg.fractionMarginMax
                val lo = m
                val hi = 1.0 - m
                // Limites: f_obs >= 1-m com ruído até m implica f >= 1-2m, logo t_x <= t_ini + 2mE
                // (e simetricamente t_x >= t_ini + E(1-2m) para f_obs <= m).
                val upOff = e * 2.0 * m
                val loOff = e * (1.0 - 2.0 * m)
                val wgt = contrast * contrast
                val st = e * m / kSig                  // σ de t deste pixel (E·√2·σ_px/C)
                for (k in frames.indices) {
                    val strip = frames[k].first
                    val f = (strip[idx].toDouble() - b) / contrast
                    val tIni = tRow.toDouble() + frames[k].second
                    if (f > lo && f < hi) {
                        if (usableInterior) {
                            val t = tIni + e * (1.0 - f)
                            colSumW[i] = (colSumW[i] ?: 0.0) + wgt
                            colTimes.getOrPut(i) { ArrayList() }.add(t)
                            colS2[i] = (colS2[i] ?: 0.0) + st * st
                            colN[i] = (colN[i] ?: 0) + 1
                            interior += 1
                        }
                    } else if (f >= hi) {
                        if (k == 1) coveredColsCand.add(i)
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
        val lowerI: Long? = lower?.let { floor(it + 0.5).toLong() }
        val upperI: Long? = upper?.let { floor(it + 0.5).toLong() }

        fun intervalResult(loNs: Long?, hiNs: Long?, quality: Int): CrossingEstimate? {
            if (loNs == null || hiNs == null) return null
            val a = if (loNs <= hiNs) loNs else hiNs
            val bb = if (loNs <= hiNs) hiNs else loNs
            if (Math.floorDiv(bb - a, 2L) > p / 2) return null
            val mid = Math.floorDiv(a + bb, 2L)
            return CrossingEstimate(quality, mid, Math.floorDiv(bb - a, 2L), interior, bounds, a, bb)
        }

        /** Qualidade 2 se a incerteza (3σ) propagada do ajuste é pequena; senão intervalo. */
        fun fittedResult(tEst: Double, varT: Double): CrossingEstimate? {
            var unc = floor(3.0 * sqrt(varT) + 0.5).toLong()
            if (unc < uncFloor) unc = uncFloor
            val refined = floor(tEst + 0.5).toLong()
            if (unc <= uncQ2Max) return CrossingEstimate(2, refined, unc, interior, bounds, lowerI, upperI)
            val a0 = refined - unc
            val b0 = refined + unc
            var a = a0
            var bb = b0
            if (lowerI != null && lowerI > a) a = lowerI
            if (upperI != null && upperI < bb) bb = upperI
            if (a > bb) { a = a0; bb = b0 }
            return intervalResult(a, bb, 1)
        }

        /** Colunas confiáveis (≥ minRows pixels), mediana e variância da mediana por coluna. */
        fun columnStats(sumW: HashMap<Int, Double>, times: HashMap<Int, ArrayList<Double>>, s2: HashMap<Int, Double>, cnt: HashMap<Int, Int>): ColumnStats {
            val good = sumW.keys.filter { (cnt[it] ?: 0) >= minRows }.sorted()
            // Tempo por coluna = MEDIANA dos t_x dos pixels interiores: um único pixel saturado que o ruído
            // classificou como interior (erro ~P) não desloca a coluna, ao contrário da média ponderada.
            val t = HashMap<Int, Double>()
            for ((c, list) in times) t[c] = median(list)
            // variância da mediana da coluna ~ (π/2) · variância da média
            val variance = HashMap<Int, Double>()
            for ((c, v) in s2) variance[c] = (PI / 2.0) * v / (cnt[c]!!.toDouble() * cnt[c]!!.toDouble())
            return ColumnStats(good, t, variance)
        }

        /**
         * Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
         * fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou null.
         */
        fun fitLine(good: List<Int>, sumW: HashMap<Int, Double>, colT: HashMap<Int, Double>, colVar: HashMap<Int, Double>): LineFit? {
            val fitCols = ArrayList(good)
            for (iter in 0 until 3) {
                var gw = 0.0; var gx = 0.0; var gt = 0.0; var gxx = 0.0; var gxt = 0.0
                for (col in fitCols) {
                    val wc = sumW[col]!!
                    val tc = colT[col]!!
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
                    val res = abs(colT[col]!! - (tc + slope * (col - center)))
                    if (res > worstRes) { worstRes = res; worst = col }
                }
                if (worst != null && worstRes > e + p / 4.0 && fitCols.size > 2) { fitCols.remove(worst); continue }
                if (worstRes <= e + p / 4.0 && abs(slope) in sMin..sMax) {
                    // propagação: t_c = Σ a_c·t_col(c), a_c = w_c/gw − gx·w_c·(gw·dx_c − gx)/(denom·gw)
                    var varT = 0.0
                    for (col in fitCols) {
                        val wc = sumW[col]!!
                        val dxc = col - center
                        val ac = wc / gw - gx * wc * (gw * dxc - gx) / (denom * gw)
                        varT += ac * ac * colVar[col]!!
                    }
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
        if (goodCols.isNotEmpty()) {
            var fit = fitLine(goodCols, colSumW, colT, colVar)
            // ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO ----------------------
            for (iter in 0 until 2) {
                val f1 = fit ?: break
                val sumW2 = HashMap<Int, Double>()
                val times2 = HashMap<Int, ArrayList<Double>>()
                val s22 = HashMap<Int, Double>()
                val n2 = HashMap<Int, Int>()
                for (row in 0 until h) {
                    val tRow = rowTime(row)
                    for (i in 0 until w) {
                        val idx = row * w + i
                        val b = cand.stripBg[idx]
                        val o = plateauStrip[idx].toDouble()
                        val contrast = o - b
                        val c = if (contrast >= 0.0) contrast else -contrast
                        if (c < cfg.minContrast) continue
                        var m = noiseTerm / c
                        if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin
                        if (m > cfg.fractionMarginMax) continue
                        val tPred = f1.tc + f1.slope * (i - center)
                        val wgt = contrast * contrast
                        val st = e * m / kSig
                        for (k in frames.indices) {
                            val tIni = tRow.toDouble() + frames[k].second
                            val fPred = (tIni + e - tPred) / e
                            if (fPred > m && fPred < 1.0 - m) {
                                val f = (frames[k].first[idx].toDouble() - b) / contrast
                                val t = tIni + e * (1.0 - f)
                                sumW2[i] = (sumW2[i] ?: 0.0) + wgt
                                times2.getOrPut(i) { ArrayList() }.add(t)
                                s22[i] = (s22[i] ?: 0.0) + st * st
                                n2[i] = (n2[i] ?: 0) + 1
                            }
                        }
                    }
                }
                val stats2 = columnStats(sumW2, times2, s22, n2)
                val fit2 = if (stats2.good.isNotEmpty()) fitLine(stats2.good, sumW2, stats2.t, stats2.variance) else null
                if (fit2 == null) break
                fit = fit2
            }
            if (fit != null) fittedResult(fit.tc, fit.varT)?.let { return it }
            // uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
            var col = goodCols[0]
            for (c2 in goodCols) if (colSumW[c2]!! > colSumW[col]!!) col = c2
            val dx0 = col - center
            val tInt = colT[col]!!
            if (abs(dx0) < 0.5) fittedResult(tInt, colVar[col]!!)?.let { return it }
            // sentido: colunas já cobertas no candidato ficam do lado de onde o bordo veio
            val leftCov = coveredColsCand.any { it < col }
            val rightCov = coveredColsCand.any { it > col }
            val cands = ArrayList<Double>()
            if (leftCov || !rightCov) { cands.add(tInt - dx0 * sMin); cands.add(tInt - dx0 * sMax) }
            if (rightCov || !leftCov) { cands.add(tInt + dx0 * sMin); cands.add(tInt + dx0 * sMax) }
            // incerteza da média da coluna: ±E·m/sqrt(n)
            val mCol = noiseTerm / maxOf(cfg.minContrast, 1.0)
            val colUnc = e * minOf(mCol, 0.5) / sqrt(maxOf(1, colN[col] ?: 1).toDouble())
            val a0 = floor(cands.min() - colUnc + 0.5).toLong()
            val b0 = floor(cands.max() + colUnc + 0.5).toLong()
            var a = a0
            var bb = b0
            if (lowerI != null && lowerI > a) a = lowerI
            if (upperI != null && upperI < bb) bb = upperI
            if (a > bb) { a = a0; bb = b0 }   // limites inconsistentes (ruído): só a faixa de velocidades
            intervalResult(a, bb, 1)?.let { return it }
        }
        return intervalResult(lowerI, upperI, 1) ?: none
    }

    /** Mediana determinística (n par: média dos dois centrais) — mesma definição em Python/Swift. */
    private fun median(values: List<Double>): Double {
        val v = values.sorted()
        val n = v.size
        return if (n % 2 == 1) v[n / 2] else (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}
