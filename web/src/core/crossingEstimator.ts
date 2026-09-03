import type { CrossingInput } from "./frameMeasurement.ts";
import type { Nanos } from "./nanos.ts";
import { framePeriodNs, type PhotocellConfig } from "./photocellConfig.ts";
import type { RoiRect } from "./roiRect.ts";

/**
 * Resultado do refinamento sub-quadro.
 * quality: 0 = sem refinamento; 1 = só limites/intervalo; 2 = ajuste completo.
 */
export interface CrossingEstimate {
  quality: number;
  refinedTsNs: Nanos;
  uncertaintyNs: Nanos;
  interiorCount: number;
  boundCount: number;
  lowerNs: Nanos | null;
  upperNs: Nanos | null;
  /** Colunas cuja dispersão de tempos excede o que o ruído explica (textura/inclinação). */
  texturedColumns: number;
}

/** Desfaz a curva de tom (gamma) para que V seja linear em f; gamma == 1 desliga. */
export function linearize(v: number, gamma: number): number {
  if (gamma === 1.0) return v;
  if (v <= 0.0) return 0.0;
  return 255.0 * Math.pow(v / 255.0, gamma);
}

/** Mediana determinística dos primeiros `count` valores (n par: média dos dois centrais). */
function median(values: Float64Array, count: number): number {
  const v = values.slice(0, count);
  v.sort();
  return count % 2 === 1 ? v[(count - 1) / 2] : (v[count / 2 - 1] + v[count / 2]) / 2.0;
}

interface ColumnStats {
  good: number[];
  t: Float64Array;
  variance: Float64Array;
  textured: number;
  crms: Float64Array;
}

interface LineFit {
  tc: number;
  slope: number;
  varT: number;
}

/**
 * Estimador sub-quadro por fração de exposição (porte fiel de `Tools/photocell_reference.py`, o
 * mesmo dos núcleos Kotlin e Swift).
 *
 * Cada pixel integra a luz durante [t_ini, t_ini + E]; se o bordo (luma O) cobre o pixel (fundo B)
 * em t_x dentro da janela, V = B + (O − B)·f com f = (t_ini + E − t_x)/E ⇒ t_x = t_ini + E·(1 − f).
 * O bordo se move a velocidade constante: t_x(coluna) = t_c + s·dx. Um ajuste linear ponderado sobre
 * as MEDIANAS por coluna dos pixels "interiores" de três quadros (c−lag, c, c+lag; deslocamentos de
 * tempo MEDIDOS) devolve t_c e a velocidade.
 */
export function estimateCrossing(
  cfg: PhotocellConfig,
  roi: RoiRect,
  planeHeight: number,
  inp: CrossingInput,
  noiseSigmaPx: number,
): CrossingEstimate {
  const p = framePeriodNs(cfg);
  // Intervalo físico do gatilho, sem hipóteses sobre contraste: do início da exposição do último
  // quadro VISTO (primeira linha da banda) ao fim da exposição do candidato (última linha), mais o
  // atraso até o centro ((core−1)/2 px à velocidade mínima plausível).
  const skewForRows = cfg.skewNs;
  const rowOffset = (row: number): number =>
    skewForRows !== null ? Math.floor(((roi.y0 + row) * skewForRows) / planeHeight) : 0;
  const coreHalfPx = (cfg.coreWidth - 1) / 2.0 + cfg.q0TiltAllowancePxPerRow * (roi.height / 2.0);
  const coreLagNs = Math.floor((coreHalfPx * 1e9) / cfg.speedPxPerSMin + 0.5);
  const lastSeenQ0 = inp.lastSeenTsNs;
  const lastSeen = lastSeenQ0 !== null && lastSeenQ0 < inp.tsNs ? lastSeenQ0 : inp.tsNs - p;
  const noneLo = lastSeen + rowOffset(0);
  const noneHi = inp.tsNs + rowOffset(roi.height - 1) + cfg.exposureNs + coreLagNs;
  const none: CrossingEstimate = {
    quality: 0,
    refinedTsNs: Math.floor((noneLo + noneHi) / 2),
    uncertaintyNs: Math.floor((noneHi - noneLo) / 2),
    interiorCount: 0,
    boundCount: 0,
    lowerNs: null,
    upperNs: null,
    texturedColumns: 0,
  };
  const n = inp.stripCur.length;
  const plateauStrip = inp.plateauStrip;
  if (
    n === 0 ||
    plateauStrip === null ||
    plateauStrip.length !== n ||
    inp.stripPrev.length !== n ||
    inp.stripBg.length !== n
  ) {
    return none;
  }
  const h = roi.height;
  const w = roi.width;
  if (w * h !== n) return none;
  const e = cfg.exposureNs;
  const gamma = cfg.gamma;
  const kSig = cfg.fractionMarginSigmas;
  // O ruído foi medido em níveis CODIFICADOS (ΔY cru), mas o contraste C vem depois da
  // linearização: converte-se sigma pela derivada da curva no nível do fundo (gamma 1 = igual).
  const linearScale = (vRaw: number): number =>
    gamma === 1.0 || vRaw <= 0.0 ? 1.0 : gamma * Math.pow(vRaw / 255.0, gamma - 1.0);

  const noiseTerm = kSig * Math.SQRT2 * noiseSigmaPx;
  const center = (w - 1) / 2.0;
  const frameStrips: Int32Array[] = [];
  const frameOffsets: number[] = [];
  frameStrips.push(inp.stripPrev);
  frameOffsets.push(inp.prevTsNs - inp.tsNs);
  frameStrips.push(inp.stripCur);
  frameOffsets.push(0.0);
  const nextStrip = inp.nextStrip;
  const nextTs = inp.nextTsNs;
  if (nextStrip !== null && nextStrip.length === n && nextTs !== null) {
    frameStrips.push(nextStrip);
    frameOffsets.push(nextTs - inp.tsNs);
  }
  const nFrames = frameStrips.length;
  const sMin = 1e9 / cfg.speedPxPerSMax;
  const sMax = 1e9 / cfg.speedPxPerSMin;
  const minRows = Math.max(1, cfg.minInteriorRowsPerColumn, Math.ceil(cfg.minInteriorRowsFraction * h));
  const uncFloor = Math.max(1, Math.floor(cfg.exposureNs / 50), cfg.systematicUncNs);
  const satLo = cfg.saturationLow;
  const satHi = cfg.saturationHigh;
  const saturated = (raw: number): boolean => raw <= satLo || raw >= satHi;
  const uncQ2Max = Math.floor(p / 8); // acima disso o ajuste vira intervalo (qualidade 1)
  const skew = cfg.skewNs;
  const rowTime = (row: number): number =>
    skew !== null ? inp.tsNs + Math.floor(((roi.y0 + row) * skew) / planeHeight) : inp.tsNs;

  // fundo e platô linearizados uma vez
  const bgLin = new Float64Array(n);
  const plateauLin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bgLin[i] = linearize(inp.stripBg[i], gamma);
    plateauLin[i] = linearize(plateauStrip[i], gamma);
  }
  // Textura do objeto: variância espacial do platô ao longo das colunas (mediana das linhas), além
  // do ruído. Entra como variância adicional COERENTE por coluna (não cai com sqrt(n)).
  const rowVars = new Float64Array(h);
  for (let row = 0; row < h; row++) {
    const o = row * w;
    let meanP = 0.0;
    for (let i = 0; i < w; i++) meanP += plateauLin[o + i];
    meanP = meanP / w;
    let ssP = 0.0;
    for (let i = 0; i < w; i++) {
      const d = plateauLin[o + i] - meanP;
      ssP += d * d;
    }
    rowVars[row] = ssP / w;
  }
  const texVarPx = median(rowVars, h) - noiseSigmaPx * noiseSigmaPx;
  const aTex = texVarPx > 0.0 ? Math.sqrt(texVarPx) : 0.0;
  // A textura também limita a classificação coberto/interior: margem = maior entre ruído e ~1,5·aTex
  const texTerm = 1.5 * aTex;
  const marginTerm = noiseTerm >= texTerm ? noiseTerm : texTerm;

  // Erro de MODELO: se a resposta do pixel não é linear em f (curva de tom desconhecida, desfoque),
  // o resíduo t_obs − t_previsto depende sistematicamente de f. A média ponderada do resíduo em três
  // faixas de f mede isso; o que excede o ruído entra na incerteza.
  let modelErr = 0.0;
  let interior = 0;
  let bounds = 0;
  let lower: number | null = null;
  let upper: number | null = null;
  // colunas cobertas / descobertas por quadro (contagem de linhas): sentido do bordo no fallback
  const covCnt = new Int32Array(nFrames * w);
  const uncCnt = new Int32Array(nFrames * w);
  const maxPerCol = h * nFrames;

  // ---- passo 1: seleção pelo valor observado + limites --------------------------------
  const colSumW = new Float64Array(w);
  const colTimes: Float64Array[] = [];
  for (let i = 0; i < w; i++) colTimes.push(new Float64Array(maxPerCol));
  const devs = new Float64Array(maxPerCol); // desvios |t − mediana| para a MAD (reutilizado)
  const colS2 = new Float64Array(w);
  const colN = new Int32Array(w);
  for (let row = 0; row < h; row++) {
    const tRow = rowTime(row);
    for (let i = 0; i < w; i++) {
      const idx = row * w + i;
      // fundo ou platô saturados: o modelo linear não vale neste pixel
      if (saturated(inp.stripBg[idx]) || saturated(plateauStrip[idx])) continue;
      const b = bgLin[idx];
      const o = plateauLin[idx];
      const contrast = o - b;
      const c = contrast >= 0.0 ? contrast : -contrast;
      if (c < cfg.minContrast) continue;
      const dx = i - center;
      const isCenterCol = Math.abs(dx) <= 0.5;
      const centerSlack = Math.abs(dx) * sMax;
      let m = (marginTerm * linearScale(inp.stripBg[idx])) / c;
      if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin;
      if (m >= 0.5) continue;
      const usableInterior = m <= cfg.fractionMarginMax;
      const lo = m;
      const hi = 1.0 - m;
      const upOff = e * 2.0 * m;
      const loOff = e * (1.0 - 2.0 * m);
      const wgt = contrast * contrast;
      const st = (e * m) / kSig;
      for (let k = 0; k < nFrames; k++) {
        const raw = frameStrips[k][idx];
        if (saturated(raw)) continue;
        const f = (linearize(raw, gamma) - b) / contrast;
        const tIni = tRow + frameOffsets[k];
        if (f > lo && f < hi) {
          if (usableInterior) {
            const t = tIni + e * (1.0 - f);
            colSumW[i] += wgt;
            colTimes[i][colN[i]] = t;
            colS2[i] += st * st;
            colN[i] += 1;
            interior += 1;
          }
        } else if (f >= hi) {
          covCnt[k * w + i] += 1;
          if (isCenterCol) {
            bounds += 1;
            const u = tIni + upOff + centerSlack;
            if (upper === null || u < upper) upper = u;
          }
        } else if (f <= lo) {
          uncCnt[k * w + i] += 1;
          if (isCenterCol) {
            bounds += 1;
            const lw = tIni + loOff - centerSlack;
            if (lower === null || lw > lower) lower = lw;
          }
        }
      }
    }
  }
  let lowerI: number | null = lower !== null ? Math.floor(lower + 0.5) : null;
  let upperI: number | null = upper !== null ? Math.floor(upper + 0.5) : null;
  let texturedCols = 0;

  const intervalResult = (loNs: number | null, hiNs: number | null, quality: number): CrossingEstimate | null => {
    if (loNs === null || hiNs === null) return null;
    // limites contraditórios (classificação corrompida, p.ex. textura): sem informação honesta
    if (loNs > hiNs) return null;
    if (Math.floor((hiNs - loNs) / 2) > Math.floor(p / 2)) return null;
    return {
      quality,
      refinedTsNs: Math.floor((loNs + hiNs) / 2),
      uncertaintyNs: Math.floor((hiNs - loNs) / 2),
      interiorCount: interior,
      boundCount: bounds,
      lowerNs: loNs,
      upperNs: hiNs,
      texturedColumns: texturedCols,
    };
  };

  /** Qualidade 2 se a incerteza (3σ) propagada do ajuste é pequena; senão intervalo. */
  const fittedResult = (tEst: number, varT: number): CrossingEstimate | null => {
    let unc = Math.floor(3.0 * Math.sqrt(varT) + modelErr + 0.5);
    if (unc < uncFloor) unc = uncFloor;
    const refined = Math.floor(tEst + 0.5);
    if (unc <= uncQ2Max) {
      return {
        quality: 2,
        refinedTsNs: refined,
        uncertaintyNs: unc,
        interiorCount: interior,
        boundCount: bounds,
        lowerNs: lowerI,
        upperNs: upperI,
        texturedColumns: texturedCols,
      };
    }
    const a0 = refined - unc;
    const b0 = refined + unc;
    let a = a0;
    let bb = b0;
    if (lowerI !== null && lowerI > a) a = lowerI;
    if (upperI !== null && upperI < bb) bb = upperI;
    if (a > bb) {
      a = a0;
      bb = b0;
    }
    return intervalResult(a, bb, 1);
  };

  /** Colunas confiáveis, mediana, variância da mediana por coluna e número de colunas texturizadas. */
  const columnStats = (
    sumW: Float64Array,
    times: Float64Array[],
    s2: Float64Array,
    cnt: Int32Array,
  ): ColumnStats => {
    const good: number[] = [];
    for (let c = 0; c < w; c++) if (cnt[c] > 0 && cnt[c] >= minRows) good.push(c);
    const t = new Float64Array(w);
    const variance = new Float64Array(w);
    const crms = new Float64Array(w);
    let textured = 0;
    for (let c = 0; c < w; c++) {
      const nc = cnt[c];
      if (nc === 0) continue;
      const fn = nc;
      t[c] = median(times[c], nc);
      // variância da mediana da coluna ~ (π/2) · variância da média (modelo de ruído)
      const varModel = ((Math.PI / 2.0) * s2[c]) / (fn * fn);
      // dispersão amostral ROBUSTA: (1,4826·MAD)² — pixels espúrios isolados não marcam a coluna
      // como texturizada nem inflam a incerteza; textura de verdade é coerente e aparece na MAD
      const medC = t[c];
      for (let k = 0; k < nc; k++) devs[k] = Math.abs(times[c][k] - medC);
      const mad = nc >= 2 ? median(devs, nc) : 0.0;
      const sigR = 1.4826 * mad;
      const varS = sigR * sigR;
      const varEmp = ((Math.PI / 2.0) * varS) / fn;
      variance[c] = varModel >= varEmp ? varModel : varEmp;
      // contraste RMS da coluna (sumW = soma de contrast²), para o termo coerente de textura
      crms[c] = Math.sqrt(sumW[c] / fn);
      if (nc >= minRows) {
        const sigmaModelPx = Math.sqrt(s2[c] / fn);
        if (Math.sqrt(varS) > 3.0 * sigmaModelPx + e / 10.0) textured += 1;
      }
    }
    return { good, t, variance, textured, crms };
  };

  /** Variância COERENTE (não cai com o número de pixels/colunas) de t causada pela textura. */
  const texVar = (crms: number): number => {
    const tTex = (e * aTex) / crms;
    return tTex * tTex;
  };

  /**
   * Ajuste linear ponderado sobre as medianas por coluna, com rejeição de colunas cujo resíduo é
   * fisicamente impossível (> E + P/4). Devolve (t_c, inclinação, variância de t_c) ou null.
   */
  const fitLine = (
    good: number[],
    sumW: Float64Array,
    colT: Float64Array,
    colVar: Float64Array,
    textured: number,
    colCrms: Float64Array,
  ): LineFit | null => {
    // Com 2 colunas o ajuste tem ZERO graus de liberdade: a reta passa exatamente pelos dois pontos,
    // o chi2 não denuncia nada e um viés de coluna vira erro de inclinação que a extrapolação até o
    // centro amplifica (medido: 0,85 ms declarando ±0,10 ms).
    if (good.length < 3) return null;
    const fitCols = good.slice();
    for (let iter = 0; iter < 3; iter++) {
      let gw = 0.0;
      let gx = 0.0;
      let gt = 0.0;
      let gxx = 0.0;
      let gxt = 0.0;
      for (const col of fitCols) {
        const wc = sumW[col];
        const tc = colT[col];
        const dxc = col - center;
        gw += wc;
        gx += wc * dxc;
        gt += wc * tc;
        gxx += wc * dxc * dxc;
        gxt += wc * dxc * tc;
      }
      const spread = fitCols[fitCols.length - 1] - fitCols[0];
      const denom = gw * gxx - gx * gx;
      if (!(spread >= 1 && denom > 1e-9 * gw * gxx && denom > 0.0)) return null;
      const slope = (gw * gxt - gx * gt) / denom;
      const tc = (gt - slope * gx) / gw;
      let worst: number | null = null;
      let worstRes = 0.0;
      for (const col of fitCols) {
        const res = Math.abs(colT[col] - (tc + slope * (col - center)));
        if (res > worstRes) {
          worstRes = res;
          worst = col;
        }
      }
      if (worst !== null && worstRes > e + p / 4.0 && fitCols.length > 2) {
        fitCols.splice(fitCols.indexOf(worst), 1);
        continue;
      }
      if (worstRes <= e + p / 4.0 && Math.abs(slope) >= sMin && Math.abs(slope) <= sMax) {
        // propagação: t_c = Σ a_c·t_col(c), a_c = w_c/gw − gx·w_c·(gw·dx_c − gx)/(denom·gw)
        let varT = 0.0;
        let chi2 = 0.0;
        let resSs = 0.0;
        for (const col of fitCols) {
          const wc = sumW[col];
          const dxc = col - center;
          const ac = wc / gw - (gx * wc * (gw * dxc - gx)) / (denom * gw);
          varT += ac * ac * colVar[col];
          const res = colT[col] - (tc + slope * dxc);
          chi2 += colVar[col] > 0.0 ? (res * res) / colVar[col] : 0.0;
          resSs += res * res;
        }
        // resíduos entre colunas maiores do que as variâncias explicam: escala pelo χ² reduzido
        const dof = fitCols.length - 2;
        if (dof >= 1) {
          const chi2r = chi2 / dof;
          if (chi2r > 1.0) varT = varT * chi2r;
        }
        // com colunas texturizadas os erros são coerentes: incerteza ≥ dispersão residual
        if (textured > 0) {
          const resMs2 = resSs / fitCols.length;
          if (resMs2 > varT) varT = resMs2;
        }
        // textura do objeto: erro coerente, somado DEPOIS da propagação
        let crms = 0.0;
        for (const col of fitCols) crms += colCrms[col];
        crms = crms / fitCols.length;
        varT += texVar(crms);
        return { tc, slope, varT };
      }
      return null;
    }
    return null;
  };

  const stats1 = columnStats(colSumW, colTimes, colS2, colN);
  const goodCols = stats1.good;
  const colT = stats1.t;
  const colVar = stats1.variance;
  texturedCols = stats1.textured;
  // Com textura os limites vêm de pixels cujo contraste ela AUMENTOU (os únicos com margem < 0,5),
  // e o O deles não representa o objeto: a comparação não pode ser no fio da navalha.
  if (texturedCols > 0 || texTerm > 0.5 * noiseTerm) {
    lowerI = null;
    upperI = null;
  }
  if (goodCols.length > 0) {
    let fit = fitLine(goodCols, colSumW, colT, colVar, texturedCols, stats1.crms);
    // ---- passo 2 (duas iterações): reseleção pelo valor PREVISTO, O local ------------------
    for (let iter = 0; iter < 2; iter++) {
      const f1 = fit;
      if (f1 === null) break;
      const behind = f1.slope > 0.0 ? -1 : 1; // bordo vindo da esquerda (s > 0): atrás = colunas menores
      const sumW2 = new Float64Array(w);
      const times2: Float64Array[] = [];
      for (let i = 0; i < w; i++) times2.push(new Float64Array(maxPerCol));
      const s22 = new Float64Array(w);
      const n2 = new Int32Array(w);
      const neigh = new Float64Array(3);
      const binW = new Float64Array(3);
      const binWr = new Float64Array(3);
      const binWv = new Float64Array(3);
      let sumWf = 0.0; // Σ w·f: a assimetria das amostras na rampa mede o viés não observável
      for (let row = 0; row < h; row++) {
        const tRow = rowTime(row);
        for (let i = 0; i < w; i++) {
          const idx = row * w + i;
          if (saturated(inp.stripBg[idx]) || saturated(plateauStrip[idx])) continue;
          const b = bgLin[idx];
          const tPred = f1.tc + f1.slope * (i - center);
          for (let k = 0; k < nFrames; k++) {
            const strip = frameStrips[k];
            const tIni = tRow + frameOffsets[k];
            const fPred = (tIni + e - tPred) / e;
            if (!(fPred > 0.0 && fPred < 1.0)) continue;
            if (saturated(strip[idx])) continue;
            // O local: mediana das até 3 colunas logo atrás do bordo, mesma linha e quadro,
            // previstas E observadas totalmente cobertas; senão o platô.
            let nNeigh = 0;
            for (let d = 1; d <= 3; d++) {
              const j = i + behind * d;
              if (j < 0 || j >= w) break;
              const tPredJ = f1.tc + f1.slope * (j - center);
              if (tPredJ > tIni) continue;
              if (
                saturated(strip[row * w + j]) ||
                saturated(inp.stripBg[row * w + j]) ||
                saturated(plateauStrip[row * w + j])
              ) {
                continue;
              }
              const vj = linearize(strip[row * w + j], gamma);
              const bj = bgLin[row * w + j];
              const cj = plateauLin[row * w + j] - bj;
              if (cj === 0.0) continue;
              let mj = (marginTerm * linearScale(inp.stripBg[row * w + j])) / (cj >= 0.0 ? cj : -cj);
              if (mj < cfg.fractionMarginMin) mj = cfg.fractionMarginMin;
              if ((vj - bj) / cj >= 1.0 - mj) {
                neigh[nNeigh] = vj;
                nNeigh += 1;
              }
            }
            const o = nNeigh > 0 ? median(neigh, nNeigh) : plateauLin[idx];
            const contrast = o - b;
            const c = contrast >= 0.0 ? contrast : -contrast;
            if (c < cfg.minContrast) continue;
            let m = (marginTerm * linearScale(inp.stripBg[idx])) / c;
            if (m < cfg.fractionMarginMin) m = cfg.fractionMarginMin;
            if (m > cfg.fractionMarginMax) continue;
            if (!(fPred > m && fPred < 1.0 - m)) continue;
            const f = (linearize(strip[idx], gamma) - b) / contrast;
            const t = tIni + e * (1.0 - f);
            const wgt = contrast * contrast;
            const st = (e * m) / kSig;
            sumW2[i] += wgt;
            times2[i][n2[i]] = t;
            s22[i] += st * st;
            n2[i] += 1;
            const bIdx = fPred < 1.0 / 3.0 ? 0 : fPred < 2.0 / 3.0 ? 1 : 2;
            binW[bIdx] += wgt;
            binWr[bIdx] += wgt * (t - tPred);
            binWv[bIdx] += wgt * wgt * st * st;
            sumWf += wgt * fPred;
          }
        }
      }
      const stats2 = columnStats(sumW2, times2, s22, n2);
      const fit2 =
        stats2.good.length > 0 ? fitLine(stats2.good, sumW2, stats2.t, stats2.variance, stats2.textured, stats2.crms) : null;
      if (fit2 === null) break;
      fit = fit2;
      texturedCols = stats2.textured;
      let excess = 0.0;
      const totW = binW[0] + binW[1] + binW[2];
      for (let bIdx = 0; bIdx < 3; bIdx++) {
        if (binW[bIdx] <= 0.0) continue;
        const meanR = binWr[bIdx] / binW[bIdx];
        const sdR = Math.sqrt(binWv[bIdx]) / binW[bIdx];
        const ex = Math.abs(meanR) - sdR;
        if (ex > excess) excess = ex;
      }
      // A abertura do pixel suaviza a rampa de forma SIMÉTRICA: com amostras equilibradas em torno
      // de f = 0,5 o efeito se cancela; concentradas num extremo, sobra um viés comum.
      const asym = totW > 0.0 ? Math.abs(sumWf / totW - 0.5) / 0.5 : 0.0;
      const prior = Math.abs(f1.slope) * cfg.aperturePx * asym;
      modelErr = excess > prior ? excess : prior;
    }
    if (fit !== null) {
      const r = fittedResult(fit.tc, fit.varT);
      if (r !== null) return r;
    }
    // uma coluna dominante (ou inclinação implausível): usa a coluna com mais peso
    let col = goodCols[0];
    for (const c2 of goodCols) if (colSumW[c2] > colSumW[col]) col = c2;
    const dx0 = col - center;
    const tInt = colT[col];
    if (Math.abs(dx0) < 0.5) {
      const r = fittedResult(tInt, colVar[col] + texVar(stats1.crms[col]));
      if (r !== null) return r;
    }
    // sentido do bordo: no primeiro quadro em que a cobertura é assimétrica em torno da coluna
    let leftCov = false;
    let rightCov = false;
    for (let k = 0; k < nFrames; k++) {
      let lSide = false;
      let rSide = false;
      for (let c2 = 0; c2 < w; c2++) {
        if (covCnt[k * w + c2] >= minRows) {
          if (c2 < col) lSide = true;
          else if (c2 > col) rSide = true;
        }
        if (uncCnt[k * w + c2] >= minRows) {
          if (c2 > col) lSide = true;
          else if (c2 < col) rSide = true;
        }
      }
      if (lSide !== rSide) {
        leftCov = lSide;
        rightCov = rSide;
        break;
      }
    }
    const cands: number[] = [];
    if (leftCov || !rightCov) {
      cands.push(tInt - dx0 * sMin);
      cands.push(tInt - dx0 * sMax);
    }
    if (rightCov || !leftCov) {
      cands.push(tInt + dx0 * sMin);
      cands.push(tInt + dx0 * sMax);
    }
    // incerteza da coluna: maior entre ±E·m/sqrt(n) e 3σ da variância da coluna
    const mCol = noiseTerm / Math.max(cfg.minContrast, 1.0);
    let colUnc = (e * Math.min(mCol, 0.5)) / Math.sqrt(Math.max(1, colN[col]));
    const colUnc3 = 3.0 * Math.sqrt(colVar[col] + texVar(stats1.crms[col]));
    if (colUnc3 > colUnc) colUnc = colUnc3;
    const a0 = Math.floor(Math.min(...cands) - colUnc + 0.5);
    const b0 = Math.floor(Math.max(...cands) + colUnc + 0.5);
    let a = a0;
    let bb = b0;
    if (lowerI !== null && lowerI > a) a = lowerI;
    if (upperI !== null && upperI < bb) bb = upperI;
    if (a > bb) {
      a = a0;
      bb = b0;
    } // limites inconsistentes (ruído): só a faixa de velocidades
    const r = intervalResult(a, bb, 1);
    if (r !== null) return r;
  }
  return intervalResult(lowerI, upperI, 1) ?? none;
}
