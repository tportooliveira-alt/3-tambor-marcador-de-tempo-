/**
 * Executa os vetores compartilhados (shared/test-vectors/*.json, gerados pela referência Python) no
 * núcleo TypeScript — o mesmo que SharedVectorTest.kt faz no Kotlin e SharedVectorTests.swift no
 * Swift. Roda com `node --test web/test/`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { estimateCrossing } from "../src/core/crossingEstimator.ts";
import { PENALTY_PER_BARREL_NS, rankByCategory, type ScoringRun } from "../src/core/eventScoring.ts";
import { CrossingInput, type FrameMeasurement } from "../src/core/frameMeasurement.ts";
import { NoiseCalibrator } from "../src/core/noiseCalibrator.ts";
import { defaultConfig, type PhotocellConfig } from "../src/core/photocellConfig.ts";
import { effectWire, PhotocellEngine, type Effect, type TriggerInfo } from "../src/core/photocellEngine.ts";
import { RoiRect } from "../src/core/roiRect.ts";
import { StripDifferencer } from "../src/core/stripDifferencer.ts";
import { formatElapsed } from "../src/core/timeFormatter.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectorsDir = process.env.PHOTOCELL_VECTORS ?? path.resolve(here, "../../shared/test-vectors");

const load = (name: string): any => JSON.parse(readFileSync(path.join(vectorsDir, name), "utf8"));

function config(j: any): PhotocellConfig {
  const c = defaultConfig();
  c.frameRateHz = j.frame_rate_hz;
  c.startLockoutNs = j.start_lockout_ns;
  c.frameResumeNs = j.frame_resume_ns;
  c.finishArmNs = j.finish_arm_ns;
  c.finishLockoutNs = j.finish_lockout_ns;
  c.calibrationSamples = j.calibration_samples;
  c.calibrationMinSamplesForOutlier = j.calibration_min_samples_for_outlier;
  c.calibrationOutlierSigma = j.calibration_outlier_sigma;
  c.calibrationMaxRetries = j.calibration_max_retries;
  c.thresholdFloor = j.threshold_floor;
  c.thresholdSigmaK = j.threshold_sigma_k;
  c.thresholdMeanMultiplier = j.threshold_mean_multiplier;
  c.confirmWindow = j.confirm_window;
  c.confirmRequired = j.confirm_required;
  c.backgroundThresholdMultiplier = j.background_threshold_multiplier;
  c.backgroundEmaAlpha = j.background_ema_alpha;
  c.dropGapFactor = j.drop_gap_factor;
  c.degradedDropWindowNs = j.degraded_drop_window_ns;
  c.coreWidth = j.core_width;
  c.exposureNs = j.exposure_ns;
  c.minContrast = j.min_contrast;
  c.fractionMarginMin = j.fraction_margin_min;
  c.fractionMarginSigmas = j.fraction_margin_sigmas;
  c.fractionMarginMax = j.fraction_margin_max;
  c.speedPxPerSMin = j.speed_px_per_s_min;
  c.speedPxPerSMax = j.speed_px_per_s_max;
  c.minInteriorRowsPerColumn = j.min_interior_rows_per_column;
  c.minInteriorRowsFraction = j.min_interior_rows_fraction;
  c.skewNs = j.skew_ns ?? null;
  c.readoutTopToBottom = j.readout_top_to_bottom;
  c.flickerRatio = j.flicker_ratio;
  c.flickerAuto = j.flicker_auto;
  c.gamma = j.gamma;
  c.systematicUncNs = j.systematic_unc_ns;
  c.saturationLow = j.saturation_low;
  c.saturationHigh = j.saturation_high;
  c.q0TiltAllowancePxPerRow = j.q0_tilt_allowance_px_per_row;
  return c;
}

const roiOf = (j: any) => new RoiRect(j.x, j.width, j.y0, j.y1);

function assertClose(expected: number, actual: number, what: string): void {
  const tol = 1e-9 * Math.max(1.0, Math.abs(expected));
  assert.ok(Math.abs(expected - actual) <= tol, `${what}: esperado ${expected}, obtido ${actual}`);
}

function assertTrigger(exp: any, act: TriggerInfo | null, what: string): void {
  if (exp === undefined || exp === null) {
    assert.equal(act, null, what);
    return;
  }
  assert.ok(act !== null, what);
  assert.equal(act!.rawTsNs, exp.rawTs, `${what}.rawTs`);
  assert.ok(Math.abs(exp.refinedTs - act!.refinedTsNs) <= 1, `${what}.refinedTs: ${exp.refinedTs} vs ${act!.refinedTsNs}`);
  assert.equal(act!.quality, exp.quality, `${what}.quality`);
  assert.ok(Math.abs(exp.uncertaintyNs - act!.uncertaintyNs) <= 1, `${what}.uncertainty`);
  assert.equal(act!.interiorCount, exp.interiorCount, `${what}.interiorCount`);
  assert.equal(act!.degraded, exp.degraded, `${what}.degraded`);
  assert.equal(act!.texturedColumns, exp.texturedColumns ?? 0, `${what}.texturedColumns`);
}

type EffectLog = [string, string[]][];

function assertEffects(expected: any[], actual: EffectLog): void {
  assert.equal(actual.length, expected.length, "número de blocos de efeitos");
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i][0], expected[i].at, `efeitos[${i}].at`);
    assert.deepEqual(actual[i][1], expected[i].effects, `efeitos[${i}] em ${expected[i].at}`);
  }
}

class EffectApplier {
  log: EffectLog = [];
  private diff: StripDifferencer | null;
  private cfg: PhotocellConfig;

  constructor(diff: StripDifferencer | null, cfg: PhotocellConfig) {
    this.diff = diff;
    this.cfg = cfg;
  }

  apply(eng: PhotocellEngine, tag: string): void {
    for (const e of eng.effects as Effect[]) {
      if (e.kind === "resetDifferencer") this.diff?.reset();
      else if (e.kind === "updateBackground") this.diff?.updateBackground(this.cfg.backgroundEmaAlpha);
      else if (e.kind === "setReferenceLag") this.diff?.setLag(e.lag);
    }
    if (eng.effects.length > 0) this.log.push([tag, eng.effects.map(effectWire)]);
    eng.effects.length = 0;
  }
}

function userEvent(eng: PhotocellEngine, name: string): void {
  if (name === "user_arm") eng.userArm();
  else if (name === "user_calibrate") eng.userCalibrate();
  else if (name === "user_reset") eng.userReset();
  else if (name === "capture_interrupted") eng.captureInterrupted();
  else throw new Error(`evento desconhecido ${name}`);
}

// ------------------------------------------------------------------ strip
function runStrip(v: any): void {
  const cfg = config(v.config);
  const roi = roiOf(v.roi);
  const { planeWidth, planeHeight, stride, sentinel } = v;
  const diff = new StripDifferencer(roi, planeWidth, planeHeight, cfg.coreWidth);
  const eng = new PhotocellEngine(cfg, roi, planeHeight);
  const applier = new EffectApplier(diff, cfg);
  const plane = new Uint8Array(stride * planeHeight).fill(sentinel);
  const exp = v.expected;
  for (let i = 0; i < v.frames.length; i++) {
    const key = String(i);
    if (Object.prototype.hasOwnProperty.call(v.userEvents, key)) {
      userEvent(eng, v.userEvents[key]);
      applier.apply(eng, `before:${i}`);
    }
    const band = Buffer.from(v.frames[i], "base64");
    plane.set(band, roi.y0 * stride);
    const ts = v.timestamps[i];
    const m = diff.process(plane, stride, ts);
    const em = exp.measurements[i];
    if (m === null) {
      assert.ok(em === null || em === undefined, `quadro ${i} deveria ter medição`);
      eng.frame(null, ts);
    } else {
      assert.equal(m.tsNs, em.ts, `ts do quadro ${i}`);
      assertClose(em.full, m.deltaFull, `deltaFull quadro ${i}`);
      assertClose(em.core, m.deltaCore, `deltaCore quadro ${i}`);
      assertClose(em.bg, m.deltaBackground, `deltaBackground quadro ${i}`);
      eng.frame(m);
    }
    applier.apply(eng, `frame:${i}`);
  }
  assert.deepEqual(eng.transitions, exp.transitions, "transições");
  assertEffects(exp.effects, applier.log);
  assert.equal(eng.state, exp.finalState, "estado final");
  assertClose(exp.threshold, eng.threshold!, "limiar");
  assert.equal(eng.lag, exp.lag, "lag");
  assertTrigger(exp.start, eng.start, "start");
  assert.equal(eng.drops, exp.drops, "drops");
}

// ------------------------------------------------------------------ calibração
function runCalibration(v: any): void {
  const cfg = config(v.config);
  const cal = new NoiseCalibrator(cfg);
  const exp = v.expected;
  for (let i = 0; i < v.samples.length; i++) {
    const r = cal.addSample(v.samples[i]);
    assert.equal(r.toLowerCase(), exp.results[i], `resultado da amostra ${i}`);
  }
  if (exp.threshold === null) assert.equal(cal.threshold, null);
  else assertClose(exp.threshold, cal.threshold!, "limiar");
  assert.equal(cal.retries, exp.retries, "retries");
  assert.equal(cal.failed, exp.failed, "failed");
  assertClose(exp.mean, cal.stats.mean, "média");
  assertClose(exp.sigma, cal.stats.sigma, "sigma");
  assert.equal(cal.stats.count, exp.count, "count");
}

// ------------------------------------------------------------------ FSM
function runFsm(v: any): void {
  const cfg = config(v.config);
  const roi = roiOf(v.roi);
  const eng = new PhotocellEngine(cfg, roi, v.planeHeight);
  const applier = new EffectApplier(null, cfg);
  let idx = 0;
  for (const st of v.steps) {
    if (st.type === "frames") {
      const prev = Int32Array.from(st.stripPrev ?? []);
      const cur = Int32Array.from(st.stripCur ?? []);
      const bg = Float64Array.from(st.stripBg ?? []);
      for (let k = 0; k < st.count; k++) {
        const ts = st.ts0 + k * st.period;
        const m: FrameMeasurement = {
          tsNs: ts,
          prevTsNs: ts - st.period,
          deltaFull: st.full,
          deltaCore: st.core,
          deltaBackground: st.bg,
          stripPrev: prev.slice(),
          stripCur: cur.slice(),
          stripBg: bg.slice(),
          deltaFullLag2: null,
          lag: 1,
        };
        eng.frame(m);
        applier.apply(eng, `frame:${idx}`);
        idx += 1;
      }
    } else if (st.type === "seed") {
      eng.frame(null, st.ts);
      applier.apply(eng, `seed:${idx}`);
      idx += 1;
    } else if (st.type === "wakeup") {
      eng.wakeup(st.ts);
      applier.apply(eng, `wakeup:${st.ts}`);
    } else if (st.type === "user") {
      userEvent(eng, st.event);
      applier.apply(eng, `user:${st.event}:${idx}`);
    } else {
      throw new Error("passo desconhecido");
    }
  }
  const exp = v.expected;
  assert.deepEqual(eng.transitions, exp.transitions, "transições");
  assertEffects(exp.effects, applier.log);
  assert.equal(eng.state, exp.finalState, "estado final");
  if (exp.errorReason === null) assert.equal(eng.errorReason, null);
  else assert.equal(eng.errorReason, exp.errorReason);
  if (exp.threshold === null) assert.equal(eng.threshold, null);
  else assertClose(exp.threshold, eng.threshold!, "limiar");
  assertTrigger(exp.start, eng.start, "start");
  assertTrigger(exp.finish, eng.finish, "finish");
  assert.equal(eng.drops, exp.drops, "drops");
  const er = exp.result;
  const r = eng.result;
  if (er === null || er === undefined) {
    assert.equal(r, null, "result");
    return;
  }
  assert.ok(r !== null, "result");
  assert.equal(r!.elapsedRawNs, er.elapsedRawNs, "elapsedRaw");
  assert.ok(Math.abs(er.elapsedRefinedNs - r!.elapsedRefinedNs) <= 2, "elapsedRefined");
  assert.equal(r!.drops, er.drops);
  assert.equal(r!.degraded, er.degraded);
  assertClose(er.thresholdStart, r!.thresholdStart, "thresholdStart");
  assertClose(er.thresholdFinish, r!.thresholdFinish, "thresholdFinish");
  assert.equal(formatElapsed(r!.elapsedRawNs), er.elapsedText, "elapsedText");
}

// ------------------------------------------------------------------ formatação e classificação
function runFormat(v: any): void {
  for (const c of v.cases) assert.equal(formatElapsed(c.ns), c.text, `ns=${c.ns}`);
}

function runRanking(v: any): void {
  assert.equal(PENALTY_PER_BARREL_NS, v.penaltyPerBarrelNs, "penalidade por tambor");
  const runs: ScoringRun[] = v.runs.map((r: any) => ({
    entryOrder: r.entryOrder,
    elapsedRefinedNs: r.elapsedRefinedNs,
    elapsedRawNs: r.elapsedRawNs,
    barrelsKnocked: r.barrelsKnocked,
    noTime: r.noTime,
    category: r.category,
  }));
  const got = rankByCategory(runs);
  assert.equal(got.length, v.expected.length, "quantidade de colocações");
  for (let i = 0; i < v.expected.length; i++) {
    const e = v.expected[i];
    assert.equal(got[i].entryOrder, e.entryOrder, `ordem de largada na posição ${i}`);
    assert.equal(got[i].place, e.place, `colocação de #${got[i].entryOrder}`);
    assert.equal(got[i].finalNs, e.finalNs, `tempo final de #${got[i].entryOrder}`);
    assert.equal(got[i].penaltyNs, e.penaltyNs, `penalidade de #${got[i].entryOrder}`);
  }
}

const index = load("index.json");
for (const entry of index.vectors) {
  test(entry.name, () => {
    const v = load(entry.file);
    switch (v.kind) {
      case "strip":
        runStrip(v);
        break;
      case "calibration":
        runCalibration(v);
        break;
      case "fsm":
        runFsm(v);
        break;
      case "format":
        runFormat(v);
        break;
      case "ranking":
        runRanking(v);
        break;
      default:
        throw new Error(`tipo desconhecido ${v.kind}`);
    }
  });
}
