package br.com.tportooliveira.fotocelula.ui

import android.app.Activity
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.view.Surface
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

    val sensorClock: SensorClock get() = controller?.sensorClock ?: placeholderClock

    fun updateSettings(s: AppSettings) {
        // a retomada dos quadros precisa acontecer antes de armar a chegada
        val fixed = if (s.frameResumeS > s.finishArmS - 0.5f) s.copy(frameResumeS = (s.finishArmS - 0.5f).coerceAtLeast(1f)) else s
        settings = fixed
        fixed.save(context)
        applySettings()
    }

    private fun applySettings() {
        val cap = capability ?: return
        service?.updateConfig(settings.makeConfig(cap.mode.fps, lockState.exposureNs))
    }

    /** Sonda o hardware (chamar após a permissão de câmera). */
    fun probe() {
        capability = CapabilityProbe.probe(context)
        if (capability == null) errorMessage = "Nenhuma câmera traseira encontrada."
        registerThermal()
    }

    /** Abre a câmera com a superfície do preview (TextureView). */
    fun openCamera(previewSurface: Surface, w: Int, h: Int) {
        val cap = capability ?: return
        if (controller != null) return
        val clock = SensorClock(cap.timestampRealtime)
        val ctrl = CameraController(context, cap, sink = createService(cap, clock), sensorClock = clock, initialRoi = currentRoi())
        ctrl.onLockStateChanged = { ls ->
            main.post {
                val exposureChanged = ls.exposureNs != lockState.exposureNs
                lockState = ls
                if (exposureChanged) applySettings()
            }
        }
        ctrl.onError = { msg -> main.post { errorMessage = msg; service?.captureInterrupted() } }
        controller = ctrl
        ctrl.open(previewSurface, w, h)
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

    fun roiMapped(centerX: Double, top: Double, bottom: Double) {
        val roi = NormalizedRoi(centerX, top, bottom, settings.stripWidthPx)
        service?.updateRoi(roi)
        controller?.glStripReader?.roi = roi
    }

    val roiLocked: Boolean get() = snapshot.state.isActive || snapshot.state == PhotocellState.CALIBRATING
    val canCalibrate: Boolean get() = snapshot.state == PhotocellState.IDLE || snapshot.state == PhotocellState.FINISHED || snapshot.state == PhotocellState.ERROR
    val canArm: Boolean get() = (snapshot.state == PhotocellState.IDLE || snapshot.state == PhotocellState.FINISHED) && lockState.locked
    val thermalBlocked: Boolean get() = thermalStatus >= 4 // PowerManager.THERMAL_STATUS_CRITICAL

    fun calibrate() {
        if (!canCalibrate) return
        val ctrl = controller ?: return
        isCalibratingCamera = true
        errorMessage = null
        ctrl.convergeAndLock(Pair(settings.lineXFraction.toDouble(), 0.5), settings.exposureNs) { err ->
            main.post {
                isCalibratingCamera = false
                if (err != null) errorMessage = err
                // aguarda a exposição travada chegar nos resultados antes da calibração de ruído
                main.postDelayed({ applySettings(); service?.calibrate() }, 300)
            }
        }
    }

    fun arm() {
        if (!canArm) return
        if (thermalBlocked) { errorMessage = "Aparelho quente demais para armar com segurança."; return }
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            thermalStatus = pm.currentThermalStatus
            pm.addThermalStatusListener(context.mainExecutor) { st -> thermalStatus = st }
        }
    }

    fun close() {
        controller?.close(); controller = null
        service?.release(); service = null
        feedback.release()
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
