package br.com.tportooliveira.fotocelula.ui

import android.app.Activity
import android.content.Context
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import br.com.tportooliveira.fotocelula.camera.CameraController
import br.com.tportooliveira.fotocelula.camera.CapabilityProbe
import br.com.tportooliveira.fotocelula.camera.DeviceCapability
import br.com.tportooliveira.fotocelula.camera.LockState
import br.com.tportooliveira.fotocelula.camera.NormalizedRoi
import br.com.tportooliveira.fotocelula.camera.SensorClock
import br.com.tportooliveira.fotocelula.core.Effect
import br.com.tportooliveira.fotocelula.core.PhotocellState
import br.com.tportooliveira.fotocelula.engine.Diagnostics
import br.com.tportooliveira.fotocelula.engine.PhotocellService
import br.com.tportooliveira.fotocelula.engine.Snapshot
import br.com.tportooliveira.fotocelula.feedback.TriggerFeedback
import br.com.tportooliveira.fotocelula.results.RunHistoryStore
import br.com.tportooliveira.fotocelula.results.RunRecord
import kotlin.math.abs

/** Estado da interface (main thread). Liga sonda, câmera, serviço da fotocélula, feedback e histórico. */
class PhotocellViewModel(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())

    var capability: DeviceCapability? by mutableStateOf(null); private set
    var snapshot by mutableStateOf(Snapshot()); private set
    var diagnostics by mutableStateOf(Diagnostics()); private set
    var lockState by mutableStateOf(LockState()); private set
    var errorMessage: String? by mutableStateOf(null)
    var infoMessage: String? by mutableStateOf(null)
    var settings by mutableStateOf(AppSettings.load(context))
        private set
    var flashVisible by mutableStateOf(false); private set
    var pendingResult: RunRecord? by mutableStateOf(null)
    var thermalStatus by mutableStateOf(0); private set
    var isCalibratingCamera by mutableStateOf(false); private set
    var historyVersion by mutableStateOf(0); private set

    val history = RunHistoryStore(context)
    private val feedback = TriggerFeedback()
    private var controller: CameraController? = null
    private var service: PhotocellService? = null
    private val placeholderClock = SensorClock(true)
    private var previewTexture: SurfaceTexture? = null
    private var started = false
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null
    private val saveRunnable = Runnable { settings.save(context) }

    val sensorClock: SensorClock get() = controller?.sensorClock ?: placeholderClock

    /** Aplica ajustes coerentes ([AppSettings.fix]) e persiste com debounce (os sliders disparam por pixel). */
    fun updateSettings(s: AppSettings) {
        val fixed = s.fix()
        settings = fixed
        main.removeCallbacks(saveRunnable)
        main.postDelayed(saveRunnable, 400)
        applySettings()
    }

    private fun applySettings() {
        val cap = capability ?: return
        val ls = lockState
        service?.updateConfig(settings.makeConfig(cap.mode.fps, if (ls.locked) ls.exposureNs else 0, ls.skewNs))
    }

    /** Sonda o hardware (chamar após a permissão de câmera). */
    fun probe() {
        if (capability != null) return
        capability = CapabilityProbe.probe(context)
        if (capability == null) errorMessage = "Nenhuma câmera traseira encontrada."
        registerThermal()
    }

    // ---------------------------------------------------------------- ciclo de vida
    /** Superfície do preview disponível (TextureView). */
    fun previewSurfaceAvailable(st: SurfaceTexture) {
        previewTexture = st
        if (started) openCamera()
    }

    /** O TextureView destruiu a superfície: fecha a câmera (devolve true para o TextureView liberá-la). */
    fun previewSurfaceDestroyed() {
        previewTexture = null
        closeCamera()
    }

    fun start() { started = true; if (previewTexture != null) openCamera() }
    fun stop() { started = false; closeCamera() }

    private fun openCamera() {
        val cap = capability ?: return
        val st = previewTexture ?: return
        if (controller != null) return
        val clock = SensorClock(cap.timestampRealtime)
        val svc = service ?: createService(cap, clock)
        val ctrl = CameraController(context, cap, sink = svc, sensorClock = clock, roiProvider = { svc.currentRoiPixels() })
        ctrl.onLockStateChanged = { ls ->
            main.post {
                val prev = lockState
                lockState = ls
                // a exposição REAL aplicada alimenta o estimador: reenvia a configuração quando muda (>1 %)
                val expChanged = abs(ls.exposureNs - prev.exposureNs) > maxOf(prev.exposureNs, 1L) / 100
                if (ls.locked && (expChanged || ls.locked != prev.locked || ls.skewNs != prev.skewNs)) applySettings()
            }
        }
        ctrl.onError = { msg -> main.post { errorMessage = msg; service?.captureInterrupted() } }
        ctrl.onCapabilityChanged = { nc, reason ->
            main.post {
                capability = nc
                infoMessage = "$reason. Usando ${nc.mode.label}."
                service?.setSensorSize(nc.size.width, nc.size.height)
                service?.captureInterrupted()
                applySettings()
            }
        }
        svc.onRoiApplied = { r -> controller?.glStripReader?.setRoiRect(r) }
        controller = ctrl
        ctrl.open(st)
    }

    private fun closeCamera() {
        controller?.close(); controller = null
        service?.captureInterrupted()
        lockState = LockState()
    }

    private fun currentRoi(): NormalizedRoi {
        val s = settings
        return NormalizedRoi(s.lineXFraction.toDouble(), s.bandTopFraction.toDouble(), s.bandBottomFraction.toDouble(), s.stripWidthPx)
    }

    private fun createService(cap: DeviceCapability, clock: SensorClock): PhotocellService {
        val svc = PhotocellService(
            sensorClock = clock,
            setFrameDelivery = { on -> controller?.setFrameDelivery(on) },
            mainHandler = main,
        )
        svc.onSnapshot = { s -> handleSnapshot(s) }
        svc.onDiagnostics = { d -> diagnostics = d }
        svc.onFeedback = { k -> handleFeedback(k) }
        svc.setSensorSize(cap.size.width, cap.size.height)
        svc.updateRoi(currentRoi())
        svc.updateConfig(settings.makeConfig(cap.mode.fps, 0))
        service = svc
        return svc
    }

    /** Chamado pelo preview quando a ROI é mapeada para o buffer. Ignorado com a ROI travada. */
    fun roiMapped(centerX: Double, top: Double, bottom: Double) {
        if (roiLocked) return
        service?.updateRoi(NormalizedRoi(centerX, top, bottom, settings.stripWidthPx))
    }

    val roiLocked: Boolean get() = snapshot.state.isActive || snapshot.state == PhotocellState.CALIBRATING
    val canCalibrate: Boolean get() = controller != null && (snapshot.state == PhotocellState.IDLE || snapshot.state == PhotocellState.FINISHED || snapshot.state == PhotocellState.ERROR)
    val thermalBlocked: Boolean get() = thermalStatus >= 4 // PowerManager.THERMAL_STATUS_CRITICAL
    /** A taxa medida nos quadros entregues ao engine precisa bater com a prometida pelo modo. */
    val frameRateOk: Boolean get() {
        val cap = capability ?: return false
        return diagnostics.fpsValid && diagnostics.measuredFps >= cap.mode.fps - 2.5
    }
    /** Motivo pelo qual não é seguro armar agora; null quando está tudo certo. */
    val armBlockReason: String? get() {
        val cap = capability ?: return "Câmera não sondada."
        if (controller == null) return "Câmera fechada."
        if (thermalBlocked) return "Aparelho quente demais para armar com segurança. Aguarde esfriar."
        if (!lockState.locked) return "Calibre primeiro (exposição, foco e branco precisam estar travados)."
        if (!diagnostics.fpsValid) return "Taxa de quadros ainda não medida: aguarde 1 s após calibrar."
        if (!frameRateOk) return "A câmera está entregando %.1f FPS, não %d. Mais luz ou outra exposição nos Ajustes; calibre de novo.".format(diagnostics.measuredFps, cap.mode.fps)
        return null
    }
    val canArm: Boolean get() = (snapshot.state == PhotocellState.IDLE || snapshot.state == PhotocellState.FINISHED) && armBlockReason == null

    fun calibrate() {
        if (!canCalibrate) return
        val ctrl = controller ?: return
        isCalibratingCamera = true
        errorMessage = null
        // ponto de medição AE/AF em fração do SENSOR (a ROI em pixels já mapeada), não da tela
        val cap = capability
        val roi = service?.currentRoiPixels()
        val center = if (cap != null && roi != null)
            Pair((roi.x + roi.width / 2.0) / cap.size.width, (roi.y0 + roi.y1) / 2.0 / cap.size.height)
        else Pair(0.5, 0.5)
        ctrl.convergeAndLock(center, settings.exposureNs) { err ->
            main.post {
                isCalibratingCamera = false
                if (err != null) errorMessage = err
                // exposição real e skew já chegaram nos resultados: config antes da calibração de ruído
                applySettings()
                service?.calibrate()
            }
        }
    }

    fun arm() {
        val reason = armBlockReason
        if (reason != null) { errorMessage = reason; return }
        if (!canArm) return
        errorMessage = null
        pendingResult = null
        service?.arm()
    }

    fun reset() {
        service?.reset()
        pendingResult = null
    }

    private fun handleSnapshot(s: Snapshot) {
        snapshot = s
        if (s.state == PhotocellState.ERROR) {
            errorMessage = when (s.errorReason) {
                "captureInterrupted" -> "Captura interrompida. Toque em Reset e calibre de novo."
                "calibrationUnstable" -> "Calibração instável: algo se moveu na faixa. Verifique o tripé."
                else -> "Erro: ${s.errorReason}"
            }
        }
        if (s.state == PhotocellState.FINISHED && s.result != null && pendingResult == null) {
            val cap = capability
            val rec = RunRecord.from(s.result, s.lag, lockState.exposureNs, lockState.iso, cap?.mode?.label ?: "")
            pendingResult = rec
            history.add(rec)
            historyVersion++
        }
    }

    private fun handleFeedback(kind: Effect.Feedback.Kind) {
        if (settings.feedbackSound) feedback.play(kind)
        if (settings.feedbackFlash) {
            flashVisible = true
            main.postDelayed({ flashVisible = false }, 120)
        }
    }

    fun savePendingResult() {
        pendingResult?.let { history.update(it); historyVersion++ }
    }

    fun deleteRecord(id: String) { history.remove(id); historyVersion++ }

    private fun registerThermal() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && thermalListener == null) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            thermalStatus = pm.currentThermalStatus
            val l = PowerManager.OnThermalStatusChangedListener { st -> thermalStatus = st }
            thermalListener = l
            pm.addThermalStatusListener(context.mainExecutor, l)
        }
    }

    fun close() {
        main.removeCallbacks(saveRunnable)
        settings.save(context)
        closeCamera()
        service?.release(); service = null
        feedback.release()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            thermalListener?.let { (context.getSystemService(Context.POWER_SERVICE) as PowerManager).removeThermalStatusListener(it) }
            thermalListener = null
        }
    }

    companion object {
        fun keepScreenOn(activity: Activity) {
            activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val lp = activity.window.attributes
                lp.preferredRefreshRate = 120f
                activity.window.attributes = lp
            }
        }
    }
}
