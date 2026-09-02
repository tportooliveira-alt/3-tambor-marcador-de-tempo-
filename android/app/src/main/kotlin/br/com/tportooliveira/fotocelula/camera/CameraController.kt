package br.com.tportooliveira.fotocelula.camera

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraConstrainedHighSpeedCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.MeteringRectangle
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.util.concurrent.Executor

/** Estado das travas de exposição/foco/branco, para diagnóstico na UI. */
data class LockState(
    val locked: Boolean = false,
    val exposureNs: Long = 0,
    val iso: Int = 0,
    val skewNs: Long? = null,
    val measuredFps: Double = 0.0,
)

/**
 * Abre a câmera traseira principal e cria a sessão (alta velocidade ou normal) conforme a sonda.
 * Aplica as travas (AE/AF/AWB fixos, estabilização e pós-processamento desligados) e permite
 * suspender a entrega de quadros no RUNNING (stopRepeating / retomada).
 */
class CameraController(
    private val context: Context,
    private val capability: DeviceCapability,
    private val sink: StripSink,
    /** Relógio do sensor compartilhado com o serviço (um só deslocamento estimado). */
    val sensorClock: SensorClock = SensorClock(capability.timestampRealtime),
    /** ROI inicial para o leitor GL (a mesma que o serviço usa). */
    private val initialRoi: NormalizedRoi = NormalizedRoi(),
) {
    companion object { private const val TAG = "CameraController" }

    private val thread = HandlerThread("camera2").apply { start() }
    val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }
    private val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var glReader: GlStripReader? = null
    private var yuvReader: YuvStripReader? = null
    private var previewSurface: Surface? = null   // sessão normal: superfície do TextureView

    @Volatile var lockState = LockState()
        private set
    var onLockStateChanged: ((LockState) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    private var lastResultTs = 0L
    private var fpsWindowStart = 0L
    private var fpsWindowCount = 0
    @Volatile private var delivering = false
    private var lockedExposure: Long? = null
    private var lockedIso: Int? = null
    private var lockedFocus: Float? = null

    val glStripReader: GlStripReader? get() = glReader

    // ------------------------------------------------------------ abertura
    @SuppressLint("MissingPermission")
    fun open(previewSurface: Surface?, previewW: Int, previewH: Int) {
        handler.post {
            this.previewSurface = previewSurface
            try {
                cm.openCamera(capability.cameraId, executor, object : CameraDevice.StateCallback() {
                    override fun onOpened(cam: CameraDevice) { device = cam; createSession(previewW, previewH) }
                    override fun onDisconnected(cam: CameraDevice) { cam.close(); device = null; onError?.invoke("Câmera desconectada") }
                    override fun onError(cam: CameraDevice, error: Int) { cam.close(); device = null; onError?.invoke("Erro da câmera ($error)") }
                })
            } catch (e: CameraAccessException) {
                onError?.invoke("Sem acesso à câmera: ${e.message}")
            }
        }
    }

    private fun createSession(previewW: Int, previewH: Int) {
        val dev = device ?: return
        val size = capability.size
        val outputs = ArrayList<OutputConfiguration>()
        if (capability.mode.highSpeed) {
            // Sessão restrita: só superfícies de preview/gravação → lemos a faixa via GL.
            val gl = GlStripReader(size.width, size.height, sink)
            gl.roi = initialRoi
            val camSurface = gl.start()
            if (camSurface == null) { onError?.invoke("Falha ao iniciar o leitor OpenGL da faixa"); return }
            previewSurface?.let { gl.setPreviewSurface(it, previewW, previewH) }
            glReader = gl
            outputs.add(OutputConfiguration(camSurface))
        } else {
            val yuv = YuvStripReader(size.width, size.height, handler, sink)
            yuvReader = yuv
            outputs.add(OutputConfiguration(yuv.surface))
            previewSurface?.let { outputs.add(OutputConfiguration(it)) }
        }
        val type = if (capability.mode.highSpeed) SessionConfiguration.SESSION_HIGH_SPEED else SessionConfiguration.SESSION_REGULAR
        val cfg = SessionConfiguration(type, outputs, executor, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) { session = s; startRepeating() }
            override fun onConfigureFailed(s: CameraCaptureSession) { onError?.invoke("Falha ao configurar a sessão (${capability.mode.label})") }
        })
        try {
            dev.createCaptureSession(cfg)
        } catch (e: Exception) {
            onError?.invoke("createCaptureSession: ${e.message}")
        }
    }

    // ------------------------------------------------------------ requests
    private fun buildRequest(template: Int): CaptureRequest.Builder {
        val dev = device!!
        val b = dev.createCaptureRequest(template)
        glReader?.let { b.addTarget(it.cameraSurface) }
        yuvReader?.let { b.addTarget(it.surface) }
        if (!capability.mode.highSpeed) previewSurface?.let { b.addTarget(it) }
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, capability.fpsRange)
        b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
        b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF)
        b.set(CaptureRequest.NOISE_REDUCTION_MODE, CameraMetadata.NOISE_REDUCTION_MODE_OFF)
        b.set(CaptureRequest.EDGE_MODE, CameraMetadata.EDGE_MODE_OFF)
        b.set(CaptureRequest.CONTROL_SCENE_MODE, CameraMetadata.CONTROL_SCENE_MODE_DISABLED)
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
        // travas, se já calibrado. Numa sessão de alta velocidade o dispositivo ignora controles
        // manuais (AE_MODE_OFF é sobrescrito para ON): nesse caso a trava é CONTROL_AE_LOCK e a
        // exposição realmente aplicada é lida dos resultados (alimenta o estimador).
        val e = lockedExposure; val i = lockedIso
        if (e != null && i != null && capability.manualSensor && !capability.mode.highSpeed) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, e)
            b.set(CaptureRequest.SENSOR_SENSITIVITY, i)
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, 1_000_000_000L / capability.mode.fps)
        } else if (e != null) {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
            b.set(CaptureRequest.CONTROL_AE_LOCK, true)
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
            b.set(CaptureRequest.CONTROL_AE_LOCK, false)
        }
        val f = lockedFocus
        if (f != null && capability.manualFocus) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            b.set(CaptureRequest.LENS_FOCUS_DISTANCE, f)
        } else {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
        }
        b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_AWB_LOCK, lockedExposure != null)
        return b
    }

    private val resultCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            val ts = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
            sensorClock.observe(ts)
            val exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: 0L
            val iso = result.get(CaptureResult.SENSOR_SENSITIVITY) ?: 0
            val skew = result.get(CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW)
            if (fpsWindowStart == 0L) { fpsWindowStart = ts; fpsWindowCount = 0 }
            fpsWindowCount++
            var fps = lockState.measuredFps
            if (ts - fpsWindowStart >= 1_000_000_000L) {
                fps = fpsWindowCount * 1e9 / (ts - fpsWindowStart)
                fpsWindowStart = ts; fpsWindowCount = 0
            }
            val ls = LockState(locked = lockedExposure != null, exposureNs = exp, iso = iso, skewNs = skew, measuredFps = fps)
            if (ls != lockState) { lockState = ls; onLockStateChanged?.invoke(ls) }
            lastResultTs = ts
        }
    }

    private fun startRepeating() {
        val s = session ?: return
        try {
            val req = buildRequest(if (capability.mode.highSpeed) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW)
            if (s is CameraConstrainedHighSpeedCaptureSession) {
                val list = s.createHighSpeedRequestList(req.build())
                s.setRepeatingBurst(list, resultCallback, handler)
            } else {
                s.setRepeatingRequest(req.build(), resultCallback, handler)
            }
            delivering = true
        } catch (e: Exception) {
            onError?.invoke("Falha ao iniciar a captura: ${e.message}")
        }
    }

    /** Suspende/retoma a entrega de quadros (efeito setFrameDelivery da FSM). */
    fun setFrameDelivery(enabled: Boolean) {
        handler.post {
            glReader?.enabled = enabled
            yuvReader?.enabled = enabled
            if (!capability.mode.highSpeed) {
                // Na sessão normal também paramos a captura para poupar o ISP; o preview congela.
                if (!enabled && delivering) { session?.stopRepeating(); delivering = false }
                if (enabled && !delivering) startRepeating()
            }
        }
    }

    /**
     * Calibrar: deixa AE/AF/AWB convergirem (~1,5 s com ponto de interesse no centro da faixa) e
     * depois fixa exposição/ISO (MANUAL_SENSOR) ou trava AE/AWB, e o foco.
     */
    fun convergeAndLock(roiCenterNorm: Pair<Double, Double>, desiredExposureNs: Long, done: (String?) -> Unit) {
        handler.post {
            val s = session ?: run { done("Sessão não iniciada"); return@post }
            lockedExposure = null; lockedIso = null; lockedFocus = null
            try {
                val req = buildRequest(if (capability.mode.highSpeed) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW)
                val ch = cm.getCameraCharacteristics(capability.cameraId)
                val active = ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
                if (active != null) {
                    val cx = (active.left + roiCenterNorm.first * active.width()).toInt()
                    val cy = (active.top + roiCenterNorm.second * active.height()).toInt()
                    val half = active.height() / 10
                    val rect = MeteringRectangle(
                        (cx - half).coerceAtLeast(active.left), (cy - half).coerceAtLeast(active.top),
                        (2 * half).coerceAtMost(active.width()), (2 * half).coerceAtMost(active.height()), 800)
                    req.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(rect))
                    req.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(rect))
                }
                if (s is CameraConstrainedHighSpeedCaptureSession) s.setRepeatingBurst(s.createHighSpeedRequestList(req.build()), resultCallback, handler)
                else s.setRepeatingRequest(req.build(), resultCallback, handler)
            } catch (e: Exception) {
                done("Convergência: ${e.message}"); return@post
            }
            handler.postDelayed({
                val st = lockState
                val period = 1_000_000_000L / capability.mode.fps
                var exp = st.exposureNs
                if (exp <= 0) exp = desiredExposureNs
                exp = exp.coerceAtMost(minOf(desiredExposureNs, period))
                capability.exposureRangeNs?.let { exp = exp.coerceIn(it.lower, it.upper) }
                var iso = st.iso
                capability.isoRange?.let { iso = iso.coerceIn(it.lower, it.upper) }
                lockedExposure = exp
                lockedIso = iso
                lockedFocus = null // foco travado via CONTROL_AF_MODE_OFF só com calibração de lente; senão contínuo
                try {
                    startRepeating()
                    Log.i(TAG, "Travado: exposição $exp ns ISO $iso (manual=${capability.manualSensor})")
                    done(null)
                } catch (e: Exception) {
                    done("Travamento: ${e.message}")
                }
            }, 1500)
        }
    }

    fun close() {
        handler.post {
            try { session?.stopRepeating() } catch (_: Exception) {}
            session?.close(); session = null
            device?.close(); device = null
            glReader?.release(); glReader = null
            yuvReader?.release(); yuvReader = null
            thread.quitSafely()
        }
    }
}
