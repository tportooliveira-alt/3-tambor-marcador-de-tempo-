package br.com.tportooliveira.fotocelula.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.nio.ByteBuffer
import java.util.Base64
import kotlin.math.abs

/**
 * Executa os vetores compartilhados (arquivos JSON em shared/test-vectors) gerados pela referência Python.
 * O núcleo Kotlin precisa reproduzir exatamente as mesmas medições, transições, efeitos e tempos.
 */
class SharedVectorTest {

    private val vectorsDir: File by lazy {
        val prop = System.getProperty("photocell.vectors")
        val candidates = listOfNotNull(prop?.let { File(it) },
            File("../../shared/test-vectors"), File("../shared/test-vectors"), File("shared/test-vectors"))
        candidates.firstOrNull { File(it, "index.json").exists() }
            ?: error("shared/test-vectors não encontrado (propriedade photocell.vectors)")
    }

    @TestFactory
    fun vectors(): List<DynamicTest> {
        val index = JSONObject(File(vectorsDir, "index.json").readText())
        val list = index.getJSONArray("vectors")
        return (0 until list.length()).map { i ->
            val entry = list.getJSONObject(i)
            val file = File(vectorsDir, entry.getString("file"))
            DynamicTest.dynamicTest(entry.getString("name")) {
                val v = JSONObject(file.readText())
                when (v.getString("kind")) {
                    "strip" -> runStrip(v)
                    "calibration" -> runCalibration(v)
                    "fsm" -> runFsm(v)
                    "format" -> runFormat(v)
                    else -> error("tipo desconhecido")
                }
            }
        }
    }

    // ------------------------------------------------------------------ utilitários
    private fun config(j: JSONObject): PhotocellConfig = PhotocellConfig(
        frameRateHz = j.getInt("frame_rate_hz"),
        startLockoutNs = j.getLong("start_lockout_ns"),
        frameResumeNs = j.getLong("frame_resume_ns"),
        finishArmNs = j.getLong("finish_arm_ns"),
        finishLockoutNs = j.getLong("finish_lockout_ns"),
        calibrationSamples = j.getInt("calibration_samples"),
        calibrationMinSamplesForOutlier = j.getInt("calibration_min_samples_for_outlier"),
        calibrationOutlierSigma = j.getDouble("calibration_outlier_sigma"),
        calibrationMaxRetries = j.getInt("calibration_max_retries"),
        thresholdFloor = j.getDouble("threshold_floor"),
        thresholdSigmaK = j.getDouble("threshold_sigma_k"),
        thresholdMeanMultiplier = j.getDouble("threshold_mean_multiplier"),
        confirmWindow = j.getInt("confirm_window"),
        confirmRequired = j.getInt("confirm_required"),
        backgroundThresholdMultiplier = j.getDouble("background_threshold_multiplier"),
        backgroundEmaAlpha = j.getDouble("background_ema_alpha"),
        dropGapFactor = j.getDouble("drop_gap_factor"),
        degradedDropWindowNs = j.getLong("degraded_drop_window_ns"),
        coreWidth = j.getInt("core_width"),
        exposureNs = j.getLong("exposure_ns"),
        minContrast = j.getDouble("min_contrast"),
        fractionMarginMin = j.getDouble("fraction_margin_min"),
        fractionMarginSigmas = j.getDouble("fraction_margin_sigmas"),
        fractionMarginMax = j.getDouble("fraction_margin_max"),
        speedPxPerSMin = j.getDouble("speed_px_per_s_min"),
        speedPxPerSMax = j.getDouble("speed_px_per_s_max"),
        minInteriorRowsPerColumn = j.getInt("min_interior_rows_per_column"),
        minInteriorRowsFraction = j.getDouble("min_interior_rows_fraction"),
        skewNs = if (j.isNull("skew_ns")) null else j.getLong("skew_ns"),
        readoutTopToBottom = j.getBoolean("readout_top_to_bottom"),
        flickerRatio = j.getDouble("flicker_ratio"),
        flickerAuto = j.getBoolean("flicker_auto"),
    )

    private fun roi(j: JSONObject) = RoiRect(j.getInt("x"), j.getInt("width"), j.getInt("y0"), j.getInt("y1"))

    private fun assertClose(expected: Double, actual: Double, what: String) {
        val tol = 1e-9 * maxOf(1.0, abs(expected))
        assertTrue(abs(expected - actual) <= tol, "$what: esperado $expected, obtido $actual")
    }

    private fun assertTrigger(exp: JSONObject?, act: TriggerInfo?, what: String) {
        if (exp == null) { assertNull(act, what); return }
        assertNotNull(act, what)
        assertEquals(exp.getLong("rawTs"), act!!.rawTsNs, "$what.rawTs")
        assertTrue(abs(exp.getLong("refinedTs") - act.refinedTsNs) <= 1, "$what.refinedTs: ${exp.getLong("refinedTs")} vs ${act.refinedTsNs}")
        assertEquals(exp.getInt("quality"), act.quality, "$what.quality")
        assertTrue(abs(exp.getLong("uncertaintyNs") - act.uncertaintyNs) <= 1, "$what.uncertainty")
        assertEquals(exp.getInt("interiorCount"), act.interiorCount, "$what.interiorCount")
        assertEquals(exp.getBoolean("degraded"), act.degraded, "$what.degraded")
    }

    private fun assertEffects(expected: JSONArray, actual: List<Pair<String, List<String>>>) {
        assertEquals(expected.length(), actual.size, "número de blocos de efeitos")
        for (i in 0 until expected.length()) {
            val e = expected.getJSONObject(i)
            assertEquals(e.getString("at"), actual[i].first, "efeitos[$i].at")
            val arr = e.getJSONArray("effects")
            val list = (0 until arr.length()).map { arr.getString(it) }
            assertEquals(list, actual[i].second, "efeitos[$i] em ${e.getString("at")}")
        }
    }

    private fun assertTransitions(expected: JSONArray, actual: List<PhotocellState>) {
        assertEquals((0 until expected.length()).map { expected.getString(it) }, actual.map { it.wire }, "transições")
    }

    private class EffectApplier(val diff: StripDifferencer?, val cfg: PhotocellConfig) {
        val log = ArrayList<Pair<String, List<String>>>()
        fun apply(eng: PhotocellEngine, tag: String) {
            for (e in eng.effects) {
                when (e) {
                    Effect.ResetDifferencer -> diff?.reset()
                    Effect.UpdateBackground -> diff?.updateBackground(cfg.backgroundEmaAlpha)
                    is Effect.SetReferenceLag -> diff?.setLag(e.lag)
                    else -> Unit
                }
            }
            if (eng.effects.isNotEmpty()) log.add(tag to eng.effects.map { it.wire() })
            eng.effects.clear()
        }
    }

    private fun userEvent(eng: PhotocellEngine, name: String) = when (name) {
        "user_arm" -> eng.userArm()
        "user_calibrate" -> eng.userCalibrate()
        "user_reset" -> eng.userReset()
        "capture_interrupted" -> eng.captureInterrupted()
        else -> error("evento desconhecido $name")
    }

    // ------------------------------------------------------------------ strip
    private fun runStrip(v: JSONObject) {
        val cfg = config(v.getJSONObject("config"))
        val roi = roi(v.getJSONObject("roi"))
        val planeWidth = v.getInt("planeWidth")
        val planeHeight = v.getInt("planeHeight")
        val stride = v.getInt("stride")
        val sentinel = v.getInt("sentinel").toByte()
        val timestamps = v.getJSONArray("timestamps")
        val frames = v.getJSONArray("frames")
        val userEvents = v.getJSONObject("userEvents")
        val diff = StripDifferencer(roi, planeWidth, planeHeight, cfg.coreWidth)
        val eng = PhotocellEngine(cfg, roi, planeHeight)
        val applier = EffectApplier(diff, cfg)
        val plane = ByteArray(stride * planeHeight) { sentinel }
        val exp = v.getJSONObject("expected")
        val expMeas = exp.getJSONArray("measurements")
        for (i in 0 until frames.length()) {
            val key = i.toString()
            if (userEvents.has(key)) {
                userEvent(eng, userEvents.getString(key))
                applier.apply(eng, "before:$i")
            }
            val band = Base64.getDecoder().decode(frames.getString(i))
            System.arraycopy(band, 0, plane, roi.y0 * stride, band.size)
            val ts = timestamps.getLong(i)
            val m = diff.process(ByteBuffer.wrap(plane), stride, ts)
            val em = expMeas.opt(i)
            if (m == null) {
                assertTrue(em == null || em == JSONObject.NULL, "quadro $i deveria ter medição")
                eng.frame(null, ts)
            } else {
                val e = em as JSONObject
                assertEquals(e.getLong("ts"), m.tsNs, "ts do quadro $i")
                assertClose(e.getDouble("full"), m.deltaFull, "deltaFull quadro $i")
                assertClose(e.getDouble("core"), m.deltaCore, "deltaCore quadro $i")
                assertClose(e.getDouble("bg"), m.deltaBackground, "deltaBackground quadro $i")
                eng.frame(m)
            }
            applier.apply(eng, "frame:$i")
        }
        assertTransitions(exp.getJSONArray("transitions"), eng.transitions)
        assertEffects(exp.getJSONArray("effects"), applier.log)
        assertEquals(exp.getString("finalState"), eng.state.wire, "estado final")
        assertClose(exp.getDouble("threshold"), eng.threshold!!, "limiar")
        assertEquals(exp.getInt("lag"), eng.lag, "lag")
        assertTrigger(exp.optJSONObject("start"), eng.start, "start")
        assertEquals(exp.getInt("drops"), eng.drops, "drops")
    }

    // ------------------------------------------------------------------ calibração
    private fun runCalibration(v: JSONObject) {
        val cfg = config(v.getJSONObject("config"))
        val cal = NoiseCalibrator(cfg)
        val samples = v.getJSONArray("samples")
        val exp = v.getJSONObject("expected")
        val expResults = exp.getJSONArray("results")
        for (i in 0 until samples.length()) {
            val r = cal.addSample(samples.getDouble(i))
            assertEquals(expResults.getString(i), r.name.lowercase(), "resultado da amostra $i")
        }
        if (exp.isNull("threshold")) assertNull(cal.threshold) else assertClose(exp.getDouble("threshold"), cal.threshold!!, "limiar")
        assertEquals(exp.getInt("retries"), cal.retries, "retries")
        assertEquals(exp.getBoolean("failed"), cal.failed, "failed")
        assertClose(exp.getDouble("mean"), cal.stats.mean, "média")
        assertClose(exp.getDouble("sigma"), cal.stats.sigma, "sigma")
        assertEquals(exp.getInt("count"), cal.stats.count, "count")
    }

    // ------------------------------------------------------------------ FSM
    private fun intArray(a: JSONArray?): IntArray = if (a == null) IntArray(0) else IntArray(a.length()) { a.getInt(it) }
    private fun doubleArray(a: JSONArray?): DoubleArray = if (a == null) DoubleArray(0) else DoubleArray(a.length()) { a.getDouble(it) }

    private fun runFsm(v: JSONObject) {
        val cfg = config(v.getJSONObject("config"))
        val roi = roi(v.getJSONObject("roi"))
        val planeHeight = v.getInt("planeHeight")
        val eng = PhotocellEngine(cfg, roi, planeHeight)
        val applier = EffectApplier(null, cfg)
        val steps = v.getJSONArray("steps")
        var idx = 0
        for (s in 0 until steps.length()) {
            val st = steps.getJSONObject(s)
            when (st.getString("type")) {
                "frames" -> {
                    val count = st.getInt("count")
                    val rows = doubleArray(st.optJSONArray("rows"))
                    val prev = intArray(st.optJSONArray("stripPrev"))
                    val cur = intArray(st.optJSONArray("stripCur"))
                    val bg = doubleArray(st.optJSONArray("stripBg"))
                    for (k in 0 until count) {
                        val ts = st.getLong("ts0") + k * st.getLong("period")
                        val m = FrameMeasurement(ts, st.getDouble("full"), st.getDouble("core"), st.getDouble("bg"),
                            rows.copyOf(), prev.copyOf(), cur.copyOf(), bg.copyOf(), null, 1)
                        eng.frame(m)
                        applier.apply(eng, "frame:$idx")
                        idx += 1
                    }
                }
                "seed" -> { eng.frame(null, st.getLong("ts")); applier.apply(eng, "seed:$idx"); idx += 1 }
                "wakeup" -> { eng.wakeup(st.getLong("ts")); applier.apply(eng, "wakeup:${st.getLong("ts")}") }
                "user" -> { val ev = st.getString("event"); userEvent(eng, ev); applier.apply(eng, "user:$ev:$idx") }
                else -> error("passo desconhecido")
            }
        }
        val exp = v.getJSONObject("expected")
        assertTransitions(exp.getJSONArray("transitions"), eng.transitions)
        assertEffects(exp.getJSONArray("effects"), applier.log)
        assertEquals(exp.getString("finalState"), eng.state.wire, "estado final")
        if (exp.isNull("errorReason")) assertNull(eng.errorReason) else assertEquals(exp.getString("errorReason"), eng.errorReason)
        if (exp.isNull("threshold")) assertNull(eng.threshold) else assertClose(exp.getDouble("threshold"), eng.threshold!!, "limiar")
        assertTrigger(exp.optJSONObject("start"), eng.start, "start")
        assertTrigger(exp.optJSONObject("finish"), eng.finish, "finish")
        assertEquals(exp.getInt("drops"), eng.drops, "drops")
        val er = exp.optJSONObject("result")
        val r = eng.result
        if (er == null) { assertNull(r, "result"); return }
        assertNotNull(r, "result")
        assertEquals(er.getLong("elapsedRawNs"), r!!.elapsedRawNs, "elapsedRaw")
        assertTrue(abs(er.getLong("elapsedRefinedNs") - r.elapsedRefinedNs) <= 2, "elapsedRefined")
        assertEquals(er.getInt("drops"), r.drops)
        assertEquals(er.getBoolean("degraded"), r.degraded)
        assertClose(er.getDouble("thresholdStart"), r.thresholdStart, "thresholdStart")
        assertClose(er.getDouble("thresholdFinish"), r.thresholdFinish, "thresholdFinish")
        assertEquals(er.getString("elapsedText"), TimeFormatter.formatElapsed(r.elapsedRawNs), "elapsedText")
    }

    // ------------------------------------------------------------------ formatação
    private fun runFormat(v: JSONObject) {
        val cases = v.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("text"), TimeFormatter.formatElapsed(c.getLong("ns")), "ns=${c.getLong("ns")}")
        }
    }
}
