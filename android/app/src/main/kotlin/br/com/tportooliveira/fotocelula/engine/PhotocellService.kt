package br.com.tportooliveira.fotocelula.engine

import android.os.Handler
import android.os.HandlerThread
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
    val measuredFps: Double = 0.0,
    val framesProcessed: Long = 0,
    val lastFrameCostMicros: Double = 0.0,
    val roi: RoiRect? = null,
    val planeWidth: Int = 0,
    val planeHeight: Int = 0,
)

/**
 * Dono único do engine e do differencer. Todos os quadros, eventos do usuário e wake-ups são
 * serializados numa HandlerThread própria. A UI recebe snapshots imutáveis na main thread.
 */
class PhotocellService(
    private val sensorClock: SensorClock,
    private val setFrameDelivery: (Boolean) -> Unit,
    private val mainHandler: Handler,
) : StripSink {
    private val thread = HandlerThread("photocell-engine", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO).apply { start() }
    private val handler = Handler(thread.looper)

    @Volatile var config: PhotocellConfig = PhotocellConfig()
        private set
    @Volatile private var normalizedRoi = NormalizedRoi()
    private var sensorWidth = 0
    private var sensorHeight = 0
    private var differencer: StripDifferencer? = null
    private var engine: PhotocellEngine? = null
    private var engineRoi: RoiRect? = null
    private var localRoiPlane = false
    private var lastPlaneW = 0
    private var lastPlaneH = 0
    private val wakeups = ArrayList<Runnable>()

    @Volatile var snapshot = Snapshot()
        private set
    private var diagnostics = Diagnostics()
    private var fpsWindowStart = 0L
    private var fpsWindowCount = 0

    var onSnapshot: ((Snapshot) -> Unit)? = null
    var onDiagnostics: ((Diagnostics) -> Unit)? = null
    var onFeedback: ((Effect.Feedback.Kind) -> Unit)? = null

    /** Dimensões do sensor (para converter a ROI normalizada em pixels). */
    // O engine tem dono único LÓGICO: todo acesso (quadros na thread do leitor, wake-ups e ações do
    // usuário na thread do serviço) passa por `synchronized(engineLock)`.
    private val engineLock = Any()

    fun setSensorSize(w: Int, h: Int) = handler.post { synchronized(engineLock) { sensorWidth = w; sensorHeight = h; rebuildIfIdle() } }
    fun updateConfig(cfg: PhotocellConfig) = handler.post { synchronized(engineLock) { config = cfg; rebuildIfIdle() } }
    fun updateRoi(roi: NormalizedRoi) = handler.post { synchronized(engineLock) { normalizedRoi = roi; rebuildIfIdle() } }

    fun calibrate() = handler.post { synchronized(engineLock) { engine?.userCalibrate(); runEffects() } }
    fun arm() = handler.post { synchronized(engineLock) { engine?.userArm(); runEffects() } }
    fun reset() = handler.post { synchronized(engineLock) { engine?.userReset(); runEffects(); if (rebuildPending) rebuildIfIdle() } }
    fun captureInterrupted() = handler.post { synchronized(engineLock) { engine?.captureInterrupted(); runEffects() } }

    fun currentRoiPixels(): RoiRect? = engineRoi

    private fun computeRoi(): RoiRect? {
        if (sensorWidth <= 0 || sensorHeight <= 0) return null
        return normalizedRoi.toPixels(sensorWidth, sensorHeight)
    }

    /** Mudanças de ROI/config só valem em IDLE; fora disso ficam pendentes até o próximo Reset. */
    private var rebuildPending = false

    private fun rebuildIfIdle() {
        engine?.let { if (it.state != PhotocellState.IDLE) { rebuildPending = true; return } }
        rebuildPending = false
        val roi = computeRoi() ?: return
        val cw = config.coreWidth.coerceIn(1, roi.width)
        val cfg = config.copy(coreWidth = cw)
        try {
            // O differencer trabalha no plano que recebe: inteiro (ImageReader) ou só a faixa (GL).
            differencer = if (localRoiPlane) {
                StripDifferencer(RoiRect(0, roi.width, 0, roi.height), roi.width, roi.height, cw)
            } else {
                StripDifferencer(roi, sensorWidth, sensorHeight, cw)
            }
        } catch (e: IllegalArgumentException) {
            return
        }
        engineRoi = roi
        engine = PhotocellEngine(cfg, roi, sensorHeight)
        diagnostics = diagnostics.copy(roi = roi, planeWidth = sensorWidth, planeHeight = sensorHeight)
        publish()
        publishDiagnostics()
    }

    // ---------------------------------------------------------------- quadros
    override fun onFrame(plane: ByteBuffer, stride: Int, planeWidth: Int, planeHeight: Int, tsNs: Long, localRoi: Boolean) {
        // Chamado na thread do leitor (GL ou ImageReader). O buffer só é válido durante a chamada,
        // então a faixa é processada AQUI (cópia interna do differencer) e só o resultado vai para a fila.
        val t0 = System.nanoTime()
        sensorClock.observe(tsNs)
        synchronized(engineLock) {
        if (localRoi != localRoiPlane || (localRoi && (planeWidth != lastPlaneW || planeHeight != lastPlaneH))) {
            localRoiPlane = localRoi
            lastPlaneW = planeWidth; lastPlaneH = planeHeight
            if (!localRoi) { sensorWidth = planeWidth; sensorHeight = planeHeight }
            rebuildIfIdle()
        }
        // Plano local (GL): a faixa entregue precisa ter exatamente o tamanho esperado.
        differencer?.let { d ->
            if (localRoi && (d.roi.width != planeWidth || d.roi.height != planeHeight)) { rebuildIfIdle() }
        }
        val diff = differencer ?: return
        val eng = engine ?: return
        val m = try { diff.process(plane, stride, tsNs) } catch (e: IndexOutOfBoundsException) { return }
        // engine e efeitos na mesma thread do leitor (serial por construção): sem lock, sem alocação extra
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
        }
    }

    override fun onDropped() { /* o engine detecta gaps pelos timestamps */ }

    private fun trackFps(ts: Long) {
        if (fpsWindowStart == 0L) { fpsWindowStart = ts; fpsWindowCount = 0; return }
        fpsWindowCount++
        val span = ts - fpsWindowStart
        if (span >= 1_000_000_000L) {
            diagnostics = diagnostics.copy(measuredFps = fpsWindowCount * 1e9 / span)
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
                is Effect.SetFrameDelivery -> { setFrameDelivery(e.enabled); if (e.enabled) fpsWindowStart = 0L }
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
        val r = Runnable {
            // wake-ups rodam na thread do serviço; quadros rodam na thread do leitor. Para manter o
            // engine com dono único, o wake-up é entregue pelo mesmo caminho serial do leitor:
            synchronized(engineLock) {
                engine?.wakeup(sensorClock.nowNs())
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

    fun release() { cancelWakeups(); thread.quitSafely() }
}
