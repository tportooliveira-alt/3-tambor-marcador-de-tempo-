package br.com.tportooliveira.fotocelula.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Invariantes da máquina de estados sob sequências aleatórias de eventos (quadros, wake-ups fora
 * de ordem e duplicados, reset, interrupção): nunca dispara fora de ARMED/AWAITING_FINISH, o
 * resultado é sempre finish − start, reset sempre volta a IDLE e cancela timers, sem exceções.
 */
class EngineInvariantTest {
    private val cfg = PhotocellConfig(calibrationSamples = 24, calibrationMinSamplesForOutlier = 6,
        frameResumeNs = 800_000_000L, finishArmNs = 1_000_000_000L, startLockoutNs = 300_000_000L, finishLockoutNs = 200_000_000L)
    private val roi = RoiRect(8, 9, 300, 396)

    private fun meas(ts: Long, full: Double, core: Double, bg: Double) =
        FrameMeasurement(ts, full, core, bg, DoubleArray(0), IntArray(0), IntArray(0), DoubleArray(0), null, 1)

    @Test
    fun randomSequencesKeepInvariants() {
        val rng = Rng(4242)
        var finishedRuns = 0
        for (seq in 0 until 300) {
            val eng = PhotocellEngine(cfg, roi, 720)
            var ts = 10_000_000_000L
            val period = cfg.framePeriodNs
            val pending = ArrayList<Long>()
            var lastState = eng.state
            var burst = 0   // passagem simulada: vários quadros seguidos acima do limiar
            for (step in 0 until 400) {
                val r = rng.uniform()
                val stateBefore = eng.state
                when {
                    r < 0.04 -> eng.userArm()
                    r < 0.05 -> eng.userCalibrate()
                    r < 0.07 -> eng.userReset()
                    r < 0.075 -> eng.captureInterrupted()
                    r < 0.20 -> {
                        // wake-up com um único relógio: o tempo só anda para a frente. Às vezes antes do
                        // prazo (no-op), às vezes no prazo (transição), às vezes duplicado.
                        if (pending.isNotEmpty() && rng.uniform() < 0.8) {
                            val at = pending[(rng.uniform() * pending.size).toInt()]
                            if (rng.uniform() < 0.3 && at - 1 >= ts) {
                                eng.wakeup(at - 1)
                            } else {
                                ts = maxOf(ts, at)
                                eng.wakeup(ts)
                            }
                        } else {
                            eng.wakeup(ts)
                        }
                    }
                    else -> {
                        ts += period
                        if (burst == 0 && rng.uniform() < 0.06) burst = 6
                        val m = if (burst > 0) { burst--; meas(ts, 20.0, 30.0, 40.0) } else meas(ts, 1.0 + rng.uniform(), 0.9 + rng.uniform(), 0.8 + rng.uniform())
                        eng.frame(m)
                    }
                }
                // efeitos: coleta prazos, verifica coerência
                for (e in eng.effects) {
                    when (e) {
                        is Effect.ScheduleWakeup -> pending.add(e.atNs)
                        Effect.CancelWakeups -> pending.clear()
                        is Effect.Feedback -> {
                            val okStart = e.kind == Effect.Feedback.Kind.START && (stateBefore == PhotocellState.CONFIRMING_START)
                            val okFinish = e.kind == Effect.Feedback.Kind.FINISH && (stateBefore == PhotocellState.CONFIRMING_FINISH)
                            assertTrue(okStart || okFinish, "gatilho ${e.kind} emitido a partir de $stateBefore (seq $seq passo $step)")
                        }
                        else -> Unit
                    }
                }
                eng.effects.clear()
                // invariantes de estado
                if (eng.state == PhotocellState.IDLE && stateBefore != PhotocellState.IDLE && r in 0.05..0.07) {
                    assertNull(eng.start); assertNull(eng.result); assertTrue(pending.isEmpty(), "reset deve cancelar wake-ups")
                }
                eng.result?.let { res ->
                    assertEquals(res.finish.rawTsNs - res.start.rawTsNs, res.elapsedRawNs)
                    assertTrue(res.finish.rawTsNs >= res.start.rawTsNs + cfg.finishArmNs, "chegada antes de armar")
                    if (lastState != PhotocellState.FINISHED && eng.state == PhotocellState.FINISHED) finishedRuns++
                }
                if (eng.state == PhotocellState.RUNNING || eng.state == PhotocellState.DEBOUNCE_START || eng.state == PhotocellState.DEBOUNCE_FINISH) {
                    // quadros nesses estados nunca produzem candidato
                    assertTrue(eng.effects.none { it is Effect.Feedback })
                }
                lastState = eng.state
            }
        }
        assertTrue(finishedRuns >= 5, "poucas provas completas nas sequências aleatórias: $finishedRuns")
    }

    @Test
    fun duplicateAndEarlyWakeupsAreNoOps() {
        val eng = PhotocellEngine(cfg, roi, 720)
        eng.userArm(); eng.effects.clear()
        var ts = 5_000_000_000L
        val p = cfg.framePeriodNs
        eng.frame(null, ts)
        repeat(cfg.calibrationSamples) { ts += p; eng.frame(meas(ts, 1.2, 1.1, 0.9)) }
        assertEquals(PhotocellState.ARMED, eng.state)
        ts += p; eng.frame(meas(ts, 20.0, 30.0, 25.0))
        val start = ts
        repeat(2) { ts += p; eng.frame(meas(ts, 18.0, 22.0, 40.0)) }
        assertEquals(PhotocellState.DEBOUNCE_START, eng.state)
        eng.effects.clear()
        eng.wakeup(start + cfg.startLockoutNs - 1)
        assertEquals(PhotocellState.DEBOUNCE_START, eng.state, "wake-up antecipado não pode transitar")
        eng.wakeup(start + cfg.startLockoutNs)
        assertEquals(PhotocellState.RUNNING, eng.state)
        val before = eng.effects.size
        eng.wakeup(start + cfg.startLockoutNs)
        assertEquals(before, eng.effects.size, "wake-up duplicado deve ser no-op")
        eng.wakeup(start + cfg.finishArmNs)
        assertEquals(PhotocellState.AWAITING_FINISH, eng.state)
    }

    @Test
    fun resumeAfterArmStillReenablesFrames() {
        val c2 = cfg.copy(frameResumeNs = 1_500_000_000L, finishArmNs = 1_000_000_000L)
        val eng = PhotocellEngine(c2, roi, 720)
        eng.userArm(); eng.effects.clear()
        var ts = 5_000_000_000L; val p = c2.framePeriodNs
        eng.frame(null, ts)
        repeat(c2.calibrationSamples) { ts += p; eng.frame(meas(ts, 1.2, 1.1, 0.9)) }
        ts += p; eng.frame(meas(ts, 20.0, 30.0, 25.0)); val start = ts
        repeat(2) { ts += p; eng.frame(meas(ts, 18.0, 22.0, 40.0)) }
        eng.effects.clear()
        eng.wakeup(start + c2.startLockoutNs); eng.wakeup(start + c2.finishArmNs)
        assertEquals(PhotocellState.AWAITING_FINISH, eng.state)
        eng.effects.clear()
        eng.wakeup(start + c2.frameResumeNs)
        assertTrue(eng.effects.contains(Effect.SetFrameDelivery(true)), "retomada precisa reativar os quadros mesmo depois de armar a chegada")
    }
}
