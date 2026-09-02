package br.com.tportooliveira.fotocelula.core

/** Estados da máquina (nomes exatamente como na especificação, mais CONFIRMING e ERROR). */
enum class PhotocellState(val wire: String) {
    IDLE("idle"),
    CALIBRATING("calibrating"),
    ARMED("armed"),
    CONFIRMING_START("confirmingStart"),
    DEBOUNCE_START("debounceStart"),
    RUNNING("running"),
    AWAITING_FINISH("awaitingFinish"),
    CONFIRMING_FINISH("confirmingFinish"),
    DEBOUNCE_FINISH("debounceFinish"),
    FINISHED("finished"),
    ERROR("error");

    val isActive: Boolean
        get() = this == ARMED || this == CONFIRMING_START || this == DEBOUNCE_START || this == RUNNING ||
            this == AWAITING_FINISH || this == CONFIRMING_FINISH || this == DEBOUNCE_FINISH
}

/** Efeitos que a camada de plataforma deve executar após cada evento. */
sealed class Effect {
    data class SetFrameDelivery(val enabled: Boolean) : Effect()
    object ResetDifferencer : Effect()
    object UpdateBackground : Effect()
    data class SetReferenceLag(val lag: Int) : Effect()
    data class ScheduleWakeup(val atNs: Nanos) : Effect()
    object CancelWakeups : Effect()
    data class Feedback(val kind: Kind) : Effect() { enum class Kind { START, FINISH } }
    object Publish : Effect()

    /** Representação textual idêntica à da referência Python (usada nos vetores de teste). */
    fun wire(): String = when (this) {
        is SetFrameDelivery -> "setFrameDelivery:$enabled"
        ResetDifferencer -> "resetDifferencer"
        UpdateBackground -> "updateBackground"
        is SetReferenceLag -> "setReferenceLag:$lag"
        is ScheduleWakeup -> "scheduleWakeup:$atNs"
        CancelWakeups -> "cancelWakeups"
        is Feedback -> "feedback:" + if (kind == Feedback.Kind.START) "start" else "finish"
        Publish -> "publish"
    }
}

data class TriggerInfo(
    val rawTsNs: Nanos,
    val refinedTsNs: Nanos,
    val quality: Int,
    val uncertaintyNs: Nanos,
    val interiorCount: Int,
    val degraded: Boolean,
    /** Colunas cuja dispersão de tempos excede o ruído (textura/inclinação do bordo). */
    val texturedColumns: Int = 0,
)

data class RunResult(
    val start: TriggerInfo,
    val finish: TriggerInfo,
    val elapsedRawNs: Nanos,
    val elapsedRefinedNs: Nanos,
    val drops: Int,
    val degraded: Boolean,
    val thresholdStart: Double,
    val thresholdFinish: Double,
)

private class Candidate(val inp: CrossingInput, val degraded: Boolean) {
    var seen = 0
    var confirmed = 0
}

/**
 * Dono único da máquina de estados. Deve ser acionado sempre da MESMA fila/thread
 * (a do processamento de quadros); o display link/Choreographer apenas lê o snapshot.
 *
 * Eventos: [userCalibrate], [userArm], [userReset], [frame], [wakeup], [captureInterrupted],
 * [framesDropped]. Após cada evento, execute e limpe [effects].
 */
class PhotocellEngine(
    val cfg: PhotocellConfig,
    val roi: RoiRect,
    val planeHeight: Int,
) {
    init {
        cfg.validate()
    }

    var state: PhotocellState = PhotocellState.IDLE
        private set
    var errorReason: String? = null
        private set
    var threshold: Double? = null
        private set
    var lag: Int = 1
        private set
    var start: TriggerInfo? = null
        private set
    var finish: TriggerInfo? = null
        private set
    var result: RunResult? = null
        private set
    var drops: Int = 0
        private set
    var noiseSigmaPx: Double = 0.0
        private set

    val effects: MutableList<Effect> = ArrayList()
    /** Histórico de estados (para testes/diagnóstico). */
    val transitions: MutableList<PhotocellState> = ArrayList()

    private val calibrator = NoiseCalibrator(cfg)
    private val calibratorLag2 = NoiseCalibrator(cfg)
    private var afterCalibration = PhotocellState.IDLE
    private var candidate: Candidate? = null
    private var thresholdStart = 0.0
    private val wakeups: MutableList<Nanos> = ArrayList()
    private var lastFrameTs: Nanos? = null
    private var lastDropTs: Nanos? = null
    private var dropPending = false   // a plataforma avisou de quadros perdidos sem timestamp

    // ---- utilitários ----------------------------------------------------------
    private fun emit(e: Effect) { effects.add(e) }

    private fun go(s: PhotocellState) {
        state = s
        transitions.add(s)
        emit(Effect.Publish)
    }

    private fun schedule(atNs: Nanos) {
        wakeups.add(atNs)
        wakeups.sort()
        emit(Effect.ScheduleWakeup(atNs))
    }

    private fun cancelWakeups() {
        wakeups.clear()
        emit(Effect.CancelWakeups)
    }

    private fun processDeadlines(nowNs: Nanos) {
        while (wakeups.isNotEmpty() && wakeups[0] <= nowNs) {
            val at = wakeups.removeAt(0)
            onDeadline(at)
        }
    }

    // ---- eventos do usuário ---------------------------------------------------
    fun userCalibrate() {
        if (state == PhotocellState.IDLE || state == PhotocellState.FINISHED ||
            state == PhotocellState.ERROR || state == PhotocellState.ARMED
        ) beginCalibration(PhotocellState.IDLE)
    }

    fun userArm() {
        if (state == PhotocellState.IDLE || state == PhotocellState.FINISHED) beginCalibration(PhotocellState.ARMED)
    }

    fun userReset() {
        cancelWakeups()
        emit(Effect.SetFrameDelivery(false))
        if (lag != 1) {
            lag = 1
            emit(Effect.SetReferenceLag(1))
        }
        candidate = null
        start = null
        finish = null
        result = null
        errorReason = null
        drops = 0
        lastDropTs = null
        dropPending = false
        lastFrameTs = null
        go(PhotocellState.IDLE)
    }

    fun captureInterrupted() {
        if (state.isActive || state == PhotocellState.CALIBRATING) fail("captureInterrupted")
    }

    /**
     * A plataforma soube de quadros perdidos (TN2445 "Discontinuity", ImageReader estourado) sem
     * conhecer os timestamps: o candidato em confirmação perde a base de tempo e é descartado, o
     * próximo quadro conta como drop (passada "degradada" se estiver perto do gatilho) e a
     * referência do differencer é ressemeada.
     */
    fun framesDropped() {
        drops += 1
        dropPending = true
        lastFrameTs = null
        if (state == PhotocellState.CONFIRMING_START) {
            candidate = null
            go(PhotocellState.ARMED)
        } else if (state == PhotocellState.CONFIRMING_FINISH) {
            candidate = null
            go(PhotocellState.AWAITING_FINISH)
        }
        if (state == PhotocellState.CALIBRATING || state == PhotocellState.ARMED || state == PhotocellState.AWAITING_FINISH) {
            emit(Effect.ResetDifferencer)
        }
    }

    private fun fail(reason: String) {
        cancelWakeups()
        emit(Effect.SetFrameDelivery(false))
        candidate = null
        errorReason = reason
        go(PhotocellState.ERROR)
    }

    private fun beginCalibration(next: PhotocellState) {
        afterCalibration = next
        calibrator.reset()
        calibratorLag2.reset()
        candidate = null
        lastFrameTs = null
        if (lag != 1) {
            lag = 1
            emit(Effect.SetReferenceLag(1))
        }
        emit(Effect.SetFrameDelivery(true))
        emit(Effect.ResetDifferencer)
        go(PhotocellState.CALIBRATING)
    }

    // ---- tempo ----------------------------------------------------------------
    fun wakeup(nowNs: Nanos) { processDeadlines(nowNs) }

    private fun onDeadline(atNs: Nanos) {
        val s = start?.rawTsNs ?: return
        when {
            state == PhotocellState.DEBOUNCE_START && atNs == s + cfg.startLockoutNs -> go(PhotocellState.RUNNING)
            (state == PhotocellState.RUNNING || state == PhotocellState.AWAITING_FINISH) && atNs == s + cfg.frameResumeNs -> {
                lastFrameTs = null
                emit(Effect.SetFrameDelivery(true))
                emit(Effect.ResetDifferencer)
            }
            state == PhotocellState.RUNNING && atNs == s + cfg.finishArmNs -> {
                candidate = null
                go(PhotocellState.AWAITING_FINISH)
            }
            state == PhotocellState.DEBOUNCE_FINISH && finish != null &&
                atNs == finish!!.rawTsNs + cfg.finishLockoutNs -> finishRun()
        }
    }

    // ---- quadros --------------------------------------------------------------
    /** [m] == null significa quadro-semente (o differencer acabou de ressemear); passe [tsNs]. */
    fun frame(m: FrameMeasurement?, tsNs: Nanos? = null) {
        val ts = m?.tsNs ?: tsNs
        if (ts != null) {
            trackGaps(ts)
            processDeadlines(ts)
        }
        if (m == null) return
        when (state) {
            PhotocellState.CALIBRATING -> calibrationFrame(m)
            PhotocellState.ARMED -> armedFrame(m, PhotocellState.CONFIRMING_START)
            PhotocellState.CONFIRMING_START -> confirmingFrame(m, PhotocellState.ARMED, true)
            PhotocellState.AWAITING_FINISH -> armedFrame(m, PhotocellState.CONFIRMING_FINISH)
            PhotocellState.CONFIRMING_FINISH -> confirmingFrame(m, PhotocellState.AWAITING_FINISH, false)
            else -> Unit // RUNNING (após retomada), DEBOUNCE_*, FINISHED, IDLE, ERROR: ignorar
        }
    }

    private fun trackGaps(tsNs: Nanos) {
        if (dropPending) {
            dropPending = false
            lastDropTs = tsNs
        }
        val last = lastFrameTs
        if (last != null) {
            val gap = tsNs - last
            if (gap > cfg.dropGapFactor * cfg.framePeriodNs) {
                val missed = Math.floor(gap.toDouble() / cfg.framePeriodNs + 0.5).toInt() - 1
                if (missed > 0) {
                    drops += missed
                    lastDropTs = tsNs
                }
            }
        }
        lastFrameTs = tsNs
    }

    private fun calibrationFrame(m: FrameMeasurement) {
        m.deltaFullLag2?.let { calibratorLag2.addSample(it) }
        when (calibrator.addSample(m.deltaFull)) {
            CalibrationStep.RESTARTED -> {
                // as duas janelas precisam cobrir as mesmas amostras para a decisão de flicker valer
                calibratorLag2.reset()
            }
            CalibrationStep.DONE -> {
                var stats = calibrator.stats
                var th = calibrator.threshold!!
                val s2 = calibratorLag2.stats
                if (cfg.flickerAuto && s2.count >= cfg.calibrationSamples - 1 &&
                    s2.mean < cfg.flickerRatio * stats.mean
                ) {
                    stats = s2
                    th = computeThreshold(cfg, s2.mean, s2.sigma)
                    lag = 2
                    emit(Effect.SetReferenceLag(2))
                }
                threshold = th
                noiseSigmaPx = stats.mean / MEAN_ABS_DIFF_TO_SIGMA
                emit(Effect.UpdateBackground)
                go(afterCalibration)
            }
            CalibrationStep.FAILED -> fail("calibrationUnstable")
            else -> Unit
        }
    }

    private fun armedFrame(m: FrameMeasurement, confirming: PhotocellState) {
        val th = threshold ?: return
        if (m.deltaCore > th) {
            val ld = lastDropTs
            val degraded = ld != null && Math.abs(m.tsNs - ld) < cfg.degradedDropWindowNs
            // cópias: os buffers do differencer rotacionam no próximo quadro
            val inp = CrossingInput(
                tsNs = m.tsNs, prevTsNs = m.prevTsNs, stripPrev = m.stripPrev.copyOf(),
                stripCur = m.stripCur.copyOf(), stripBg = m.stripBg.copyOf(), lag = m.lag,
            )
            candidate = Candidate(inp, degraded)
            go(confirming)
        } else if (m.deltaFull <= th) {
            emit(Effect.UpdateBackground)
        }
    }

    private fun confirmingFrame(m: FrameMeasurement, back: PhotocellState, isStart: Boolean) {
        val c = candidate ?: return
        val th = threshold ?: return
        c.seen += 1
        if (c.seen == lag) {
            c.inp.nextStrip = m.stripCur.copyOf()
            c.inp.nextTsNs = m.tsNs
        }
        if (c.seen == 2 * lag) {
            c.inp.plateauStrip = m.stripCur.copyOf()
            c.inp.plateauTsNs = m.tsNs
        }
        if (m.deltaBackground > th * cfg.backgroundThresholdMultiplier) c.confirmed += 1
        if (c.confirmed >= cfg.confirmRequired && c.seen >= 2 * lag) {
            val est = CrossingEstimator.estimate(cfg, roi, planeHeight, c.inp, noiseSigmaPx)
            val info = TriggerInfo(
                rawTsNs = c.inp.tsNs, refinedTsNs = est.refinedTsNs, quality = est.quality,
                uncertaintyNs = est.uncertaintyNs, interiorCount = est.interiorCount, degraded = c.degraded,
                texturedColumns = est.texturedColumns,
            )
            candidate = null
            if (isStart) triggerStart(info) else triggerFinish(info)
        } else if (c.seen >= cfg.confirmWindow) {
            candidate = null
            go(back)
        }
    }

    private fun triggerStart(info: TriggerInfo) {
        start = info
        thresholdStart = threshold ?: 0.0
        emit(Effect.Feedback(Effect.Feedback.Kind.START))
        emit(Effect.SetFrameDelivery(false))
        go(PhotocellState.DEBOUNCE_START)
        val s = info.rawTsNs
        schedule(s + cfg.startLockoutNs)
        schedule(s + cfg.frameResumeNs)
        schedule(s + cfg.finishArmNs)
    }

    private fun triggerFinish(info: TriggerInfo) {
        finish = info
        emit(Effect.Feedback(Effect.Feedback.Kind.FINISH))
        emit(Effect.SetFrameDelivery(false))
        go(PhotocellState.DEBOUNCE_FINISH)
        schedule(info.rawTsNs + cfg.finishLockoutNs)
    }

    private fun finishRun() {
        val s = start ?: return
        val f = finish ?: return
        result = RunResult(
            start = s, finish = f,
            elapsedRawNs = f.rawTsNs - s.rawTsNs,
            elapsedRefinedNs = f.refinedTsNs - s.refinedTsNs,
            drops = drops,
            degraded = s.degraded || f.degraded,
            thresholdStart = thresholdStart,
            thresholdFinish = threshold ?: 0.0,
        )
        go(PhotocellState.FINISHED)
    }
}
