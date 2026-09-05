package br.com.tportooliveira.fotocelula.engine

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import br.com.tportooliveira.fotocelula.camera.NormalizedRoi
import br.com.tportooliveira.fotocelula.camera.SensorClock
import br.com.tportooliveira.fotocelula.camera.StripSink
import br.com.tportooliveira.fotocelula.core.Effect
import br.com.tportooliveira.fotocelula.core.PhotocellConfig
import br.com.tportooliveira.fotocelula.core.PhotocellEngine
import br.com.tportooliveira.fotocelula.core.PhotocellState
import br.com.tportooliveira.fotocelula.core.RoiRect
import br.com.tportooliveira.fotocelula.core.RunResult
import br.com.tportooliveira.fotocelula.core.StripDifferencer
import java.nio.ByteBuffer

/** Valor imutável publicado para a interface. */
data class Snapshot(
    val state: PhotocellState = PhotocellState.IDLE,
    val errorReason: String? = null,
    val threshold: Double? = null,
    val lag: Int = 1,
    val startNs: Long? = null,
    val finishNs: Long? = null,
    val result: RunResult? = null,
    val drops: Int = 0,
    val noiseSigmaPx: Double = 0.0,
)

data class Diagnostics(
    val lastDeltaFull: Double = 0.0,
    val lastDeltaCore: Double = 0.0,
    val lastDeltaBackground: Double = 0.0,
    /** Taxa medida nos quadros que chegaram ao engine (janela de 1 s, zerada ao religar a entrega). */
    val measuredFps: Double = 0.0,
    val fpsValid: Boolean = false,
    val framesProcessed: Long = 0,
    val lastFrameCostMicros: Double = 0.0,
    val roi: RoiRect? = null,
    val planeWidth: Int = 0,
    val planeHeight: Int = 0,
    /** Exceções no processamento de quadro (bug ou buffer inesperado); nunca silenciadas. */
    val processingErrors: Int = 0,
    /** Quadros ignorados por chegarem com o tamanho de faixa antigo (leitor GL ainda não aplicou a ROI). */
    val sizeMismatches: Int = 0,
)

/**
 * Dono único do engine e do differencer. Quadros (thread do leitor), wake-ups (thread própria) e
 * ações do usuário são serializados por `engineLock`. A UI recebe snapshots imutáveis na main thread.
 * A ROI em pixels calculada aqui é a única fonte da verdade: o leitor GL só a recebe por [onRoiApplied].
 */
class PhotocellService(
    private val sensorClock: SensorClock,
    private val setFrameDelivery: (Boolean) -> Unit,
    private val mainHandler: Handler,
) : StripSink {
    companion object { private const val TAG = "PhotocellService" }

    private val thread = HandlerThread("photocell-engine", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO).apply { start() }
    private val handler = Handler(thread.looper)
    private val engineLock = Any()

    /** Configuração em vigor no engine atual (mudanças ficam pendentes até o próximo rebuild em IDLE). */
    @Volatile var config: PhotocellConfig = PhotocellConfig()
        private set
    private var requestedConfig: PhotocellConfig = PhotocellConfig()
    private var normalizedRoi = NormalizedRoi()
    private var sensorWidth = 0
    private var sensorHeight = 0
    private var differencer: StripDifferencer? = null
    private var engine: PhotocellEngine? = null
    @Volatile private var engineRoi: RoiRect? = null
    private var localRoiPlane = false
    private var lastPlaneW = 0
    private var lastPlaneH = 0
    private val wakeups = ArrayList<Runnable>()
    private var released = false

    @Volatile var snapshot = Snapshot()
        private set
    private var diagnostics = Diagnostics()
    private var fpsWindowStart = 0L
    private var fpsWindowCount = 0

    var onSnapshot: ((Snapshot) -> Unit)? = null
    var onDiagnostics: ((Diagnostics) -> Unit)? = null
    var onFeedback: ((Effect.Feedback.Kind) -> Unit)? = null
    /** ROI em pixels aceita (chamado na thread do serviço ou do leitor). */
    var onRoiApplied: ((RoiRect) -> Unit)? = null

    fun setSensorSize(w: Int, h: Int) = handler.post { synchronized(engineLock) { sensorWidth = w; sensorHeight = h; rebuildIfIdle() } }
    fun updateConfig(cfg: PhotocellConfig) = handler.post { synchronized(engineLock) { requestedConfig = cfg; rebuildIfIdle() } }
    fun updateRoi(roi: NormalizedRoi) = handler.post { synchronized(engineLock) { normalizedRoi = roi; rebuildIfIdle() } }

    fun calibrate() = handler.post { synchronized(engineLock) { engine?.userCalibrate(); runEffects() } }
    fun arm() = handler.post { synchronized(engineLock) { engine?.userArm(); runEffects() } }
    fun reset() = handler.post { synchronized(engineLock) { engine?.userReset(); runEffects(); if (rebuildPending) rebuildIfIdle() } }
    fun captureInterrupted() = handler.post { synchronized(engineLock) { engine?.captureInterrupted(); runEffects() } }

    /** ROI em pixels do engine atual (para semear o leitor GL). */
    fun currentRoiPixels(): RoiRect? = engineRoi

    private fun computeRoi(): RoiRect? {
        if (sensorWidth <= 0 || sensorHeight <= 0) return null
        return normalizedRoi.toPixels(sensorWidth, sensorHeight)
    }

    /**
     * Mudanças de ROI/config só valem com a fotocélula parada (IDLE, FINISHED ou ERROR — o operador
     * pode mover a linha depois da prova e armar de novo); durante calibração ou prova ficam
     * pendentes até o próximo Reset.
     */
    private var rebuildPending = false

    private fun rebuildIfIdle() {
        if (released) return
        engine?.let { if (it.state.isActive || it.state == PhotocellState.CALIBRATING) { rebuildPending = true; return } }
        rebuildPending = false
        val roi = computeRoi() ?: return
        val cw = requestedConfig.coreWidth.coerceIn(1, roi.width)
        val cfg = requestedConfig.copy(coreWidth = cw)
        try {
            cfg.validate()
            // O differencer trabalha no plano que recebe: inteiro (ImageReader) ou só a faixa (GL).
            differencer = if (localRoiPlane) {
                StripDifferencer(RoiRect(0, roi.width, 0, roi.height), roi.width, roi.height, cw)
            } else {
                StripDifferencer(roi, sensorWidth, sensorHeight, cw)
            }
            engine = PhotocellEngine(cfg, roi, sensorHeight)
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "Configuração/ROI inválida: ${e.message}")
            return
        }
        config = cfg
        engineRoi = roi
        diagnostics = diagnostics.copy(roi = roi, planeWidth = sensorWidth, planeHeight = sensorHeight)
        onRoiApplied?.invoke(roi)
        publish()
        publishDiagnostics()
    }

    // ---------------------------------------------------------------- quadros
    override fun onFrame(plane: ByteBuffer, stride: Int, planeWidth: Int, planeHeight: Int, tsNs: Long, localRoi: Boolean) {
        // Chamado na thread do leitor (GL ou ImageReader). O buffer só é válido durante a chamada,
        // então a faixa é processada AQUI e só o resultado (snapshot/diagnóstico) vai para a main thread.
        val t0 = System.nanoTime()
        sensorClock.observe(tsNs)
        synchronized(engineLock) {
            if (released) return
            try {
                if (localRoi != localRoiPlane || (!localRoi && (planeWidth != sensorWidth || planeHeight != sensorHeight))) {
                    localRoiPlane = localRoi
                    if (!localRoi) { sensorWidth = planeWidth; sensorHeight = planeHeight }
                    rebuildIfIdle()
                }
                val diff = differencer ?: return
                val eng = engine ?: return
                if (localRoi && (diff.roi.width != planeWidth || diff.roi.height != planeHeight)) {
                    // o leitor GL ainda entrega a faixa antiga: ignora o quadro e reafirma a ROI aceita
                    val n = diagnostics.sizeMismatches + 1
                    diagnostics = diagnostics.copy(sizeMismatches = n)
                    if (n % 30 == 1) engineRoi?.let { onRoiApplied?.invoke(it) }
                    return
                }
                lastPlaneW = planeWidth; lastPlaneH = planeHeight
                val m = diff.process(plane, stride, tsNs)
                if (m != null) {
                    eng.frame(m)
                    diagnostics = diagnostics.copy(lastDeltaFull = m.deltaFull, lastDeltaCore = m.deltaCore, lastDeltaBackground = m.deltaBackground)
                } else {
                    eng.frame(null, tsNs)
                }
                runEffects()
                trackFps(tsNs)
                val cost = (System.nanoTime() - t0) / 1000.0
                diagnostics = diagnostics.copy(framesProcessed = diagnostics.framesProcessed + 1, lastFrameCostMicros = cost)
                if (diagnostics.framesProcessed % 16 == 0L) publishDiagnostics()
            } catch (t: Throwable) {
                // nunca engolir: conta, registra e segue (um quadro perdido é tratado pelos timestamps)
                Log.e(TAG, "Erro ao processar quadro", t)
                diagnostics = diagnostics.copy(processingErrors = diagnostics.processingErrors + 1)
                publishDiagnostics()
            }
        }
    }

    /** O leitor perdeu quadros para o pipeline: o candidato em confirmação não é mais confiável. */
    override fun onDropped() {
        synchronized(engineLock) {
            if (released) return
            engine?.framesDropped()
            runEffects()
        }
    }

    private fun trackFps(ts: Long) {
        if (fpsWindowStart == 0L) { fpsWindowStart = ts; fpsWindowCount = 0; return }
        fpsWindowCount++
        val span = ts - fpsWindowStart
        if (span >= 1_000_000_000L) {
            diagnostics = diagnostics.copy(measuredFps = fpsWindowCount * 1e9 / span, fpsValid = true)
            fpsWindowStart = ts; fpsWindowCount = 0
        }
    }

    // ---------------------------------------------------------------- efeitos
    private fun runEffects() {
        val eng = engine ?: return
        if (eng.effects.isEmpty()) return
        var publish = false
        for (e in eng.effects) {
            when (e) {
                is Effect.SetFrameDelivery -> {
                    setFrameDelivery(e.enabled)
                    if (e.enabled) { fpsWindowStart = 0L; fpsWindowCount = 0; diagnostics = diagnostics.copy(fpsValid = false) }
                }
                Effect.ResetDifferencer -> differencer?.reset()
                Effect.UpdateBackground -> differencer?.updateBackground(config.backgroundEmaAlpha)
                is Effect.SetReferenceLag -> differencer?.setLag(e.lag)
                is Effect.ScheduleWakeup -> scheduleWakeup(e.atNs)
                Effect.CancelWakeups -> cancelWakeups()
                is Effect.Feedback -> { val k = e.kind; mainHandler.post { onFeedback?.invoke(k) } }
                Effect.Publish -> publish = true
            }
        }
        eng.effects.clear()
        if (publish) publish()
    }

    private fun scheduleWakeup(atNs: Long) {
        val delayMs = ((atNs - sensorClock.nowNs()) / 1_000_000L).coerceAtLeast(0L)
        lateinit var r: Runnable
        r = Runnable {
            synchronized(engineLock) {
                wakeups.remove(r)
                if (released) return@Runnable
                // o relógio estimado pode estar levemente atrasado: o prazo é o próprio instante agendado
                engine?.wakeup(maxOf(sensorClock.nowNs(), atNs))
                runEffects()
            }
        }
        wakeups.add(r)
        handler.postDelayed(r, delayMs + 1)
    }

    private fun cancelWakeups() {
        for (r in wakeups) handler.removeCallbacks(r)
        wakeups.clear()
    }

    private fun publish() {
        val eng = engine ?: return
        val s = Snapshot(
            state = eng.state, errorReason = eng.errorReason, threshold = eng.threshold, lag = eng.lag,
            startNs = eng.start?.rawTsNs, finishNs = eng.finish?.rawTsNs, result = eng.result,
            drops = eng.drops, noiseSigmaPx = eng.noiseSigmaPx,
        )
        snapshot = s
        mainHandler.post { onSnapshot?.invoke(s) }
    }

    private fun publishDiagnostics() {
        val d = diagnostics
        mainHandler.post { onDiagnostics?.invoke(d) }
    }

    fun release() {
        synchronized(engineLock) {
            released = true
            cancelWakeups()
            engine = null
            differencer = null
        }
        thread.quitSafely()
    }
}
