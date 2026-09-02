package br.com.tportooliveira.fotocelula.camera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.SurfaceTexture
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
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import br.com.tportooliveira.fotocelula.core.RoiRect
import java.util.concurrent.Executor
import kotlin.math.abs
import kotlin.math.roundToInt

/** Estado das travas de exposição/foco/branco e da taxa medida, para diagnóstico e para o estimador. */
data class LockState(
    val locked: Boolean = false,
    /** Exposição REAL aplicada (CaptureResult.SENSOR_EXPOSURE_TIME) — alimenta E do estimador. */
    val exposureNs: Long = 0,
    val iso: Int = 0,
    /** Tempo de leitura do sensor (CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW), se o aparelho reporta. */
    val skewNs: Long? = null,
    val frameDurationNs: Long = 0,
    /** Taxa medida: na sessão de alta velocidade, nos quadros que chegam ao leitor GL; na normal, nos resultados. */
    val measuredFps: Double = 0.0,
    val fpsValid: Boolean = false,
    val focusMode: String = "contínuo",
    val aeLocked: Boolean = false,
    val awbLocked: Boolean = false,
)

/**
 * Abre a câmera traseira principal e cria a sessão (alta velocidade ou normal) conforme a sonda.
 * Aplica as travas (AE/AF/AWB fixos, estabilização e pós-processamento desligados quando o hardware
 * permite), mede a taxa real e cai para a sessão normal quando a de alta velocidade não entrega os
 * quadros prometidos. Permite suspender a entrega de quadros no RUNNING.
 *
 * Todo o estado vive na thread "camera2"; a UI só recebe cópias imutáveis ([LockState]).
 */
class CameraController(
    private val context: Context,
    initialCapability: DeviceCapability,
    private val sink: StripSink,
    /** Relógio do sensor compartilhado com o serviço (um só deslocamento estimado). */
    val sensorClock: SensorClock = SensorClock(initialCapability.timestampRealtime),
    /** ROI em pixels aceita pelo serviço (única fonte da verdade), para semear o leitor GL. */
    private val roiProvider: () -> RoiRect? = { null },
) {
    companion object {
        private const val TAG = "CameraController"
        private const val CONVERGE_MIN_MS = 800L
        private const val CONVERGE_TIMEOUT_MS = 3500L
        private const val VERIFY_MS = 1300L
    }

    @Volatile var capability: DeviceCapability = initialCapability
        private set

    private val thread = HandlerThread("camera2").apply { start() }
    val handler = Handler(thread.looper)
    private val executor = Executor { handler.post(it) }
    private val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    private val characteristics = cm.getCameraCharacteristics(initialCapability.cameraId)
    private val afModes: IntArray = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
    private val maxAeRegions = characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AE) ?: 0
    private val maxAfRegions = characteristics.get(CameraCharacteristics.CONTROL_MAX_REGIONS_AF) ?: 0

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    @Volatile private var glReader: GlStripReader? = null
    private var yuvReader: YuvStripReader? = null
    private var previewTexture: SurfaceTexture? = null
    private var previewSurface: Surface? = null
    private var closed = false

    @Volatile var lockState = LockState()
        private set
    var onLockStateChanged: ((LockState) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    /** A sessão de alta velocidade não entregou a taxa: caímos para o modo normal (mensagem para a UI). */
    var onCapabilityChanged: ((DeviceCapability, String) -> Unit)? = null

    // últimos resultados
    private var lastExposure = 0L
    private var lastIso = 0
    private var lastSkew: Long? = null
    private var lastFrameDuration = 0L
    private var lastAeState = -1
    private var lastAfState = -1
    private var lastFocusDistance: Float? = null
    private var resultCount = 0L
    private var fpsWindowStart = 0L
    private var fpsWindowCount = 0
    private var resultFps = 0.0
    private var resultFpsValid = false

    // travas
    private var lockedExposure: Long? = null
    private var lockedIso: Int? = null
    private var lockedFocusMode: Int? = null
    private var lockedFocusDistance: Float? = null
    private var focusLabel = "contínuo"
    private var converging = false
    private var useRegions = true
    @Volatile private var delivering = false
    private var rateProbe: Runnable? = null
    private var rateProbeAttempts = 0

    val glStripReader: GlStripReader? get() = glReader

    // ------------------------------------------------------------ abertura
    /** [preview] é a SurfaceTexture do TextureView (ou null para rodar sem preview). */
    @SuppressLint("MissingPermission")
    fun open(preview: SurfaceTexture?) {
        handler.post {
            if (closed) return@post
            previewTexture = preview
            previewSurface = preview?.let { Surface(it) }
            try {
                cm.openCamera(capability.cameraId, executor, object : CameraDevice.StateCallback() {
                    override fun onOpened(cam: CameraDevice) {
                        if (closed) { cam.close(); return }
                        device = cam; createSession()
                    }
                    override fun onDisconnected(cam: CameraDevice) { cam.close(); device = null; onError?.invoke("Câmera desconectada") }
                    override fun onError(cam: CameraDevice, error: Int) { cam.close(); device = null; onError?.invoke("Erro da câmera ($error)") }
                })
            } catch (e: CameraAccessException) {
                onError?.invoke("Sem acesso à câmera: ${e.message}")
            } catch (e: SecurityException) {
                onError?.invoke("Sem permissão de câmera")
            }
        }
    }

    private fun createSession() {
        val dev = device ?: return
        val cap = capability
        val size = cap.size
        val outputs = ArrayList<OutputConfiguration>()
        if (cap.mode.highSpeed) {
            // Sessão restrita com UMA superfície (a do leitor GL): todos os pedidos do lote a têm como
            // alvo, então ela recebe a taxa cheia. O preview é desenhado pelo próprio leitor.
            val gl = GlStripReader(size.width, size.height, sink)
            roiProvider()?.let { gl.setRoiRect(it) }
            val camSurface = gl.start()
            if (camSurface == null) { gl.release(); onError?.invoke("Falha ao iniciar o leitor OpenGL da faixa"); return }
            gl.setPreviewSurface(previewSurface)
            glReader = gl
            glCameraSurface = camSurface
            outputs.add(OutputConfiguration(camSurface))
        } else {
            previewTexture?.setDefaultBufferSize(size.width, size.height)
            val yuv = YuvStripReader(size.width, size.height, sink)
            yuvReader = yuv
            outputs.add(OutputConfiguration(yuv.surface))
            previewSurface?.let { outputs.add(OutputConfiguration(it)) }
        }
        val type = if (cap.mode.highSpeed) SessionConfiguration.SESSION_HIGH_SPEED else SessionConfiguration.SESSION_REGULAR
        val cfg = SessionConfiguration(type, outputs, executor, object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) {
                if (closed) { s.close(); return }
                session = s
                startRepeating()
                if (cap.mode.highSpeed) scheduleRateProbe()
            }
            override fun onConfigureFailed(s: CameraCaptureSession) {
                if (cap.mode.highSpeed && cap.withNormalFallback() != null) fallbackToNormal("A sessão de alta velocidade foi recusada pelo aparelho")
                else onError?.invoke("Falha ao configurar a sessão (${cap.mode.label})")
            }
        })
        try {
            dev.createCaptureSession(cfg)
        } catch (e: Exception) {
            if (cap.mode.highSpeed && cap.withNormalFallback() != null) fallbackToNormal("createCaptureSession: ${e.message}")
            else onError?.invoke("createCaptureSession: ${e.message}")
        }
    }

    /** Depois de ~3 s de quadros, confere que o leitor GL recebe a taxa prometida; senão, sessão normal. */
    private fun scheduleRateProbe() {
        rateProbe?.let { handler.removeCallbacks(it) }
        rateProbeAttempts = 0
        val r = object : Runnable {
            override fun run() {
                if (closed || !capability.mode.highSpeed) return
                val gl = glReader ?: return
                val target = capability.mode.fps
                if (gl.fpsValid) {
                    val fps = gl.measuredFps
                    if (fps < target * 0.8) {
                        fallbackToNormal("A superfície de alta velocidade recebeu só %.0f FPS (esperado %d)".format(fps, target))
                    } else {
                        Log.i(TAG, "Alta velocidade confirmada: %.1f FPS".format(fps))
                    }
                    return
                }
                rateProbeAttempts++
                if (rateProbeAttempts >= 4) {
                    if (gl.framesReceived == 0L) fallbackToNormal("A sessão de alta velocidade não entregou quadros")
                    return
                }
                handler.postDelayed(this, 1500)
            }
        }
        rateProbe = r
        handler.postDelayed(r, 3000)
    }

    private fun fallbackToNormal(reason: String) {
        val nc = capability.withNormalFallback() ?: run { onError?.invoke(reason); return }
        Log.w(TAG, "Fallback para ${nc.mode.label}: $reason")
        rateProbe?.let { handler.removeCallbacks(it) }
        try { session?.stopRepeating() } catch (_: Exception) {}
        try { session?.close() } catch (_: Exception) {}
        session = null
        glReader?.release(); glReader = null; glCameraSurface = null
        yuvReader?.release(); yuvReader = null
        delivering = false
        lockedExposure = null; lockedIso = null; lockedFocusMode = null; lockedFocusDistance = null
        resetFpsWindows()
        capability = nc
        onCapabilityChanged?.invoke(nc, reason)
        publishLockState(force = true)
        createSession()
    }

    // ------------------------------------------------------------ requests
    private fun buildRequest(converging: Boolean, withRegions: Boolean, roiCenterNorm: Pair<Double, Double>?): CaptureRequest.Builder {
        val dev = device!!
        val cap = capability
        val hs = cap.mode.highSpeed
        val b = dev.createCaptureRequest(if (hs) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW)
        if (hs) glCameraSurface?.let { b.addTarget(it) }
        yuvReader?.let { b.addTarget(it.surface) }
        if (!hs) previewSurface?.let { b.addTarget(it) }
        // Numa sessão restrita de alta velocidade o dispositivo IMPÕE control mode AUTO, AE ON,
        // AWB AUTO e AF CONTINUOUS_VIDEO, e força todo o pós-processamento para FAST
        // (CameraDevice.createCaptureSession, "Constrained high-speed recording"; camera3.h,
        // CONSTRAINED_HIGH_SPEED_MODE). Pedir NR/Edge OFF ou SCENE_MODE ali é silenciosamente
        // ignorado — só faz sentido na sessão normal. Continuam valendo: AE/AWB lock, regiões de
        // medição, zoom e estabilização.
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, cap.fpsRange)
        b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
        if (cap.oisOff) b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF)
        if (!hs) {
            if (cap.noiseReductionOff) b.set(CaptureRequest.NOISE_REDUCTION_MODE, CameraMetadata.NOISE_REDUCTION_MODE_OFF)
            if (cap.edgeOff) b.set(CaptureRequest.EDGE_MODE, CameraMetadata.EDGE_MODE_OFF)
            b.set(CaptureRequest.CONTROL_SCENE_MODE, CameraMetadata.CONTROL_SCENE_MODE_DISABLED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && cap.logicalMultiCamera && cap.zoomRatioRange != null) {
            // câmera lógica: fixar 1x para o framework não trocar de módulo físico no meio da prova
            b.set(CaptureRequest.CONTROL_ZOOM_RATIO, 1f.coerceIn(cap.zoomRatioRange.lower, cap.zoomRatioRange.upper))
        }
        // ---- exposição
        val e = lockedExposure; val i = lockedIso
        if (!converging && e != null && i != null && cap.manualSensor && !hs) {
            // controle manual real (sessão normal): exposição curta fixa, ISO compensa
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, e)
            b.set(CaptureRequest.SENSOR_SENSITIVITY, i)
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, 1_000_000_000L / cap.mode.fps)
        } else if (!converging && e != null) {
            // alta velocidade (ou sem MANUAL_SENSOR): o aparelho ignora AE OFF; trava o AE convergido.
            // A exposição realmente aplicada é lida dos resultados e alimenta o estimador.
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
            b.set(CaptureRequest.CONTROL_AE_LOCK, cap.aeLockAvailable)
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
            b.set(CaptureRequest.CONTROL_AE_LOCK, false)
        }
        // ---- foco: convergir em contínuo; depois fixar a distância (AF OFF) ou parar (AUTO sem
        // gatilho). Em alta velocidade o AF é imposto como CONTINUOUS_VIDEO: pedir OFF é ignorado
        // sem erro, então nem tentamos (e a UI diz a verdade ao operador).
        val fm = if (hs) null else lockedFocusMode
        if (!converging && fm != null) {
            b.set(CaptureRequest.CONTROL_AF_MODE, fm)
            if (fm == CameraMetadata.CONTROL_AF_MODE_OFF) lockedFocusDistance?.let { b.set(CaptureRequest.LENS_FOCUS_DISTANCE, it) }
        } else {
            b.set(CaptureRequest.CONTROL_AF_MODE, continuousAfMode())
        }
        // ---- branco
        b.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_AWB_LOCK, !converging && e != null && cap.awbLockAvailable)
        // ---- regiões de medição no centro da faixa (só durante a convergência)
        if (converging && withRegions && roiCenterNorm != null) {
            val active = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE)
            if (active != null) {
                val cx = (active.left + roiCenterNorm.first * active.width()).toInt()
                val cy = (active.top + roiCenterNorm.second * active.height()).toInt()
                val half = active.height() / 10
                val rect = MeteringRectangle(
                    (cx - half).coerceIn(active.left, active.right - 1), (cy - half).coerceIn(active.top, active.bottom - 1),
                    (2 * half).coerceAtMost(active.width()), (2 * half).coerceAtMost(active.height()), 800)
                if (maxAeRegions > 0) b.set(CaptureRequest.CONTROL_AE_REGIONS, arrayOf(rect))
                if (maxAfRegions > 0) b.set(CaptureRequest.CONTROL_AF_REGIONS, arrayOf(rect))
            }
        }
        return b
    }

    /** Surface da câmera devolvido por [GlStripReader.start] (alvo único da sessão restrita). */
    private var glCameraSurface: Surface? = null

    private fun continuousAfMode(): Int = when {
        afModes.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO) -> CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO
        afModes.contains(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE) -> CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_PICTURE
        afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO) -> CameraMetadata.CONTROL_AF_MODE_AUTO
        else -> CameraMetadata.CONTROL_AF_MODE_OFF
    }

    private val resultCallback = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
            val ts = result.get(CaptureResult.SENSOR_TIMESTAMP) ?: return
            sensorClock.observe(ts)
            lastExposure = result.get(CaptureResult.SENSOR_EXPOSURE_TIME) ?: lastExposure
            lastIso = result.get(CaptureResult.SENSOR_SENSITIVITY) ?: lastIso
            lastSkew = result.get(CaptureResult.SENSOR_ROLLING_SHUTTER_SKEW) ?: lastSkew
            lastFrameDuration = result.get(CaptureResult.SENSOR_FRAME_DURATION) ?: lastFrameDuration
            lastAeState = result.get(CaptureResult.CONTROL_AE_STATE) ?: -1
            lastAfState = result.get(CaptureResult.CONTROL_AF_STATE) ?: -1
            result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { lastFocusDistance = it }
            resultCount++
            // Janela de taxa: numa sessão de alta velocidade o framework só entrega o resultado do
            // ÚLTIMO pedido de cada lote (Camera3Device: "do not send callback to the app" para os
            // demais), então contar resultados daria fps/lote. Ali a taxa vem do leitor GL.
            if (capability.mode.highSpeed) {
                // nada a acumular: measuredFps vem do GlStripReader
            } else if (fpsWindowStart == 0L) { fpsWindowStart = ts; fpsWindowCount = 0 } else {
                fpsWindowCount++
                val span = ts - fpsWindowStart
                if (span >= 1_000_000_000L) {
                    resultFps = fpsWindowCount * 1e9 / span; resultFpsValid = true
                    fpsWindowStart = ts; fpsWindowCount = 0
                }
            }
            // durante a convergência os valores mudam a cada quadro: publica 1 em 8
            publishLockState(force = false, throttle = converging && resultCount % 8 != 0L)
        }
    }

    private fun currentLockState(): LockState {
        val hs = capability.mode.highSpeed
        val gl = glReader
        val fps = if (hs && gl != null) gl.measuredFps else resultFps
        val valid = if (hs && gl != null) gl.fpsValid else resultFpsValid
        val e = lockedExposure
        return LockState(
            locked = e != null, exposureNs = lastExposure, iso = lastIso, skewNs = lastSkew, frameDurationNs = lastFrameDuration,
            measuredFps = fps, fpsValid = valid, focusMode = if (e != null) focusLabel else "contínuo",
            aeLocked = e != null && (capability.aeLockAvailable || (capability.manualSensor && !hs)),
            awbLocked = e != null && capability.awbLockAvailable,
        )
    }

    private fun publishLockState(force: Boolean, throttle: Boolean = false) {
        if (throttle && !force) return
        val ls = currentLockState()
        if (force || ls != lockState) { lockState = ls; onLockStateChanged?.invoke(ls) }
    }

    private fun resetFpsWindows() {
        fpsWindowStart = 0L; fpsWindowCount = 0; resultFpsValid = false
        glReader?.resetFpsWindow()
    }

    private fun submit(req: CaptureRequest.Builder) {
        val s = session ?: error("sem sessão")
        if (s is CameraConstrainedHighSpeedCaptureSession) {
            s.setRepeatingBurst(s.createHighSpeedRequestList(req.build()), resultCallback, handler)
        } else {
            s.setRepeatingRequest(req.build(), resultCallback, handler)
        }
        delivering = true
    }

    private fun startRepeating() {
        if (session == null) return
        try {
            submit(buildRequest(converging = false, withRegions = false, roiCenterNorm = null))
        } catch (e: Exception) {
            // travas não aceitas (ex.: AF OFF numa sessão restrita): volta para foco contínuo e tenta de novo
            if (lockedFocusMode != null) {
                Log.w(TAG, "Trava de foco recusada (${e.message}); usando foco contínuo")
                lockedFocusMode = null; lockedFocusDistance = null; focusLabel = "contínuo (trava recusada)"
                try { submit(buildRequest(converging = false, withRegions = false, roiCenterNorm = null)); return } catch (_: Exception) {}
            }
            onError?.invoke("Falha ao iniciar a captura: ${e.message}")
        }
    }

    /** Suspende/retoma a entrega de quadros (efeito setFrameDelivery da FSM). */
    fun setFrameDelivery(enabled: Boolean) {
        handler.post {
            if (closed) return@post
            glReader?.enabled = enabled
            yuvReader?.enabled = enabled
            if (enabled) resetFpsWindows()
            if (!capability.mode.highSpeed) {
                // Na sessão normal também paramos a captura para poupar o ISP; o preview congela.
                if (!enabled && delivering) { try { session?.stopRepeating() } catch (_: Exception) {}; delivering = false }
                if (enabled && !delivering) startRepeating()
            }
        }
    }

    /**
     * Calibrar: deixa AE/AF/AWB convergirem com ponto de interesse no centro da faixa (mínimo 0,8 s,
     * até 3,5 s, exigindo AE convergido e AF parado), fixa exposição/ISO (MANUAL_SENSOR na sessão
     * normal) ou trava AE/AWB, fixa o foco (AF OFF + distância convergida; senão AUTO parado) e, por
     * fim, confere por ~1,3 s que a taxa medida se manteve. [done] recebe null em sucesso.
     */
    fun convergeAndLock(roiCenterNorm: Pair<Double, Double>, desiredExposureNs: Long, done: (String?) -> Unit) {
        handler.post {
            if (closed) { done("Câmera fechada"); return@post }
            if (session == null) { done("Sessão não iniciada"); return@post }
            lockedExposure = null; lockedIso = null; lockedFocusMode = null; lockedFocusDistance = null
            converging = true
            publishLockState(force = true)
            try {
                submit(buildRequest(converging = true, withRegions = useRegions, roiCenterNorm = roiCenterNorm))
            } catch (e: Exception) {
                // regiões recusadas (sessão restrita em alguns aparelhos): tenta sem
                useRegions = false
                try {
                    submit(buildRequest(converging = true, withRegions = false, roiCenterNorm = null))
                } catch (e2: Exception) {
                    converging = false
                    done("Convergência: ${e2.message}"); return@post
                }
            }
            val t0 = android.os.SystemClock.uptimeMillis()
            var stableCount = 0
            var prevExposure = -1L
            val poll = object : Runnable {
                override fun run() {
                    if (closed) { done("Câmera fechada"); return }
                    val elapsed = android.os.SystemClock.uptimeMillis() - t0
                    val aeOk = lastAeState == CameraMetadata.CONTROL_AE_STATE_CONVERGED || lastAeState == CameraMetadata.CONTROL_AE_STATE_LOCKED || lastAeState == -1
                    val afOk = lastAfState == CameraMetadata.CONTROL_AF_STATE_PASSIVE_FOCUSED || lastAfState == CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED ||
                        lastAfState == CameraMetadata.CONTROL_AF_STATE_INACTIVE || lastAfState == CameraMetadata.CONTROL_AF_STATE_PASSIVE_UNFOCUSED || lastAfState == -1
                    if (prevExposure > 0 && abs(lastExposure - prevExposure) <= prevExposure / 50) stableCount++ else stableCount = 0
                    prevExposure = lastExposure
                    if ((elapsed >= CONVERGE_MIN_MS && aeOk && afOk && stableCount >= 2) || elapsed >= CONVERGE_TIMEOUT_MS) {
                        applyLocks(desiredExposureNs, done)
                    } else {
                        handler.postDelayed(this, 100)
                    }
                }
            }
            handler.postDelayed(poll, 200)
        }
    }

    private fun applyLocks(desiredExposureNs: Long, done: (String?) -> Unit) {
        val cap = capability
        val period = 1_000_000_000L / cap.mode.fps
        converging = false
        val convergedExposure = if (lastExposure > 0) lastExposure else desiredExposureNs
        val convergedIso = if (lastIso > 0) lastIso else (cap.isoRange?.lower ?: 100)
        if (cap.manualSensor && !cap.mode.highSpeed) {
            var exp = minOf(desiredExposureNs, period)
            cap.exposureRangeNs?.let { exp = exp.coerceIn(it.lower, minOf(it.upper, period)) }
            // ISO compensa a exposição mais curta para manter o brilho convergido
            var iso = (convergedIso.toDouble() * convergedExposure / exp).roundToInt()
            cap.isoRange?.let { iso = iso.coerceIn(it.lower, it.upper) }
            lockedExposure = exp; lockedIso = iso
        } else {
            lockedExposure = convergedExposure; lockedIso = convergedIso
        }
        val fd = lastFocusDistance
        if (cap.mode.highSpeed) {
            // a sessão restrita impõe AF contínuo; não há trava de foco possível
            lockedFocusMode = null
            lockedFocusDistance = null
            focusLabel = "contínuo (imposto pela sessão de alta velocidade)"
        } else when {
            afModes.contains(CameraMetadata.CONTROL_AF_MODE_OFF) && fd != null -> {
                lockedFocusMode = CameraMetadata.CONTROL_AF_MODE_OFF; lockedFocusDistance = fd
                focusLabel = if (cap.manualFocus) "fixo (%.2f dpt)".format(fd) else "fixo (distância não calibrada)"
            }
            afModes.contains(CameraMetadata.CONTROL_AF_MODE_AUTO) -> { lockedFocusMode = CameraMetadata.CONTROL_AF_MODE_AUTO; focusLabel = "auto (parado)" }
            else -> { lockedFocusMode = null; focusLabel = "contínuo" }
        }
        resetFpsWindows()
        startRepeating()
        Log.i(TAG, "Travado: exposição ${lockedExposure} ns ISO ${lockedIso} foco=$focusLabel (manual=${cap.manualSensor}, hs=${cap.mode.highSpeed})")
        publishLockState(force = true)
        // verificação: a taxa medida com a exposição travada tem de bater com a prometida
        handler.postDelayed({
            if (closed) { done("Câmera fechada"); return@postDelayed }
            publishLockState(force = true)
            val ls = lockState
            val msg = when {
                !ls.fpsValid -> "Taxa de quadros não medida após a trava: verifique a câmera e calibre de novo."
                ls.measuredFps < cap.mode.fps * 0.97 -> "A câmera manteve %.1f FPS com esta exposição, não %d. Mais luz ou exposição maior nos Ajustes.".format(ls.measuredFps, cap.mode.fps)
                else -> null
            }
            done(msg)
        }, VERIFY_MS)
    }

    fun close() {
        handler.post {
            closed = true
            rateProbe?.let { handler.removeCallbacks(it) }
            try { session?.stopRepeating() } catch (_: Exception) {}
            try { session?.close() } catch (_: Exception) {}
            session = null
            try { device?.close() } catch (_: Exception) {}
            device = null
            glReader?.release(); glReader = null
            yuvReader?.release(); yuvReader = null
            glCameraSurface = null
            try { previewSurface?.release() } catch (_: Exception) {}
            previewSurface = null; previewTexture = null
            thread.quitSafely()
        }
    }
}
