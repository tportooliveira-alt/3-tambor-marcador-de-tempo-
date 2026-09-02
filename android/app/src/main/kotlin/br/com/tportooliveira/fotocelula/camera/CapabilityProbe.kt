package br.com.tportooliveira.fotocelula.camera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.util.Range
import android.util.Size

/** Modo de captura escolhido pela sonda, do melhor para o pior. */
enum class CaptureMode(val fps: Int, val highSpeed: Boolean) {
    HIGH_SPEED_240(240, true),
    HIGH_SPEED_120(120, true),
    NORMAL_120(120, false),
    NORMAL_60(60, false),
    NORMAL_30(30, false);

    val label: String
        get() = when (this) {
            HIGH_SPEED_240 -> "240 FPS (sessão de alta velocidade)"
            HIGH_SPEED_120 -> "120 FPS (sessão de alta velocidade)"
            NORMAL_120 -> "120 FPS (sessão normal)"
            NORMAL_60 -> "60 FPS (sessão normal)"
            NORMAL_30 -> "30 FPS (sessão normal) — precisão limitada"
        }
}

/** O que o hardware permite a um app de terceiros (Samsung costuma expor só 30 FPS). */
data class DeviceCapability(
    val cameraId: String,
    val mode: CaptureMode,
    val size: Size,
    val fpsRange: Range<Int>,
    val manualSensor: Boolean,
    val manualFocus: Boolean,
    val timestampRealtime: Boolean,
    val exposureRangeNs: Range<Long>?,
    val isoRange: Range<Int>?,
    val sensorHeightPx: Int,
    /** CameraCharacteristics.SENSOR_ORIENTATION (90 na maioria das traseiras). */
    val sensorOrientation: Int,
    val highSpeedSizes: List<Pair<Size, List<Range<Int>>>>,
    val aeFpsRanges: List<Range<Int>>,
    /** Disponibilidade das travas e dos modos OFF (LIMITED costuma não ter todos). */
    val aeLockAvailable: Boolean = true,
    val awbLockAvailable: Boolean = true,
    val noiseReductionOff: Boolean = true,
    val edgeOff: Boolean = true,
    val oisOff: Boolean = true,
    /** Câmera lógica (multi-câmera): precisa fixar zoom 1x explicitamente. */
    val logicalMultiCamera: Boolean = false,
    val zoomRatioRange: Range<Float>? = null,
    /** Melhor modo NORMAL disponível, para cair nele se a superfície de alta velocidade não entregar a taxa. */
    val normalFallback: Triple<CaptureMode, Size, Range<Int>>? = null,
) {
    /** Texto de precisão esperada mostrado ao operador. */
    val precisionText: String
        get() = when {
            mode.fps >= 240 -> "≈ ±0,1 ms (refinado) / ±2 ms (por quadro)"
            mode.fps >= 120 -> "≈ ±0,2 ms (refinado) / ±4 ms (por quadro)"
            mode.fps >= 60 -> "≈ ±0,5 ms (refinado) / ±8 ms (por quadro)"
            else -> "≈ ±17 ms por quadro — este aparelho não libera alta velocidade"
        }

    /** Mesma capacidade, mas no modo normal de fallback (null se não houver). */
    fun withNormalFallback(): DeviceCapability? {
        val f = normalFallback ?: return null
        return copy(mode = f.first, size = f.second, fpsRange = f.third, normalFallback = null)
    }
}

/**
 * Sonda de capacidade: escolhe a câmera traseira principal (evitando a câmera lógica multi-câmera
 * quando há uma física) e o melhor modo disponível para apps de terceiros. Um modo NORMAL só é
 * escolhido com faixa de AE FIXA (lower == upper) e com um tamanho YUV que o hardware realmente
 * entrega nessa taxa (`getOutputMinFrameDuration`, sem stall).
 */
object CapabilityProbe {
    fun probe(context: Context): DeviceCapability? {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val backIds = cm.cameraIdList.filter {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        }
        if (backIds.isEmpty()) return null
        // Preferir uma câmera traseira que NÃO seja lógica (multi-câmera), com a maior distância focal
        // disponível entre as "normais" (o módulo principal); senão a primeira listada.
        fun isLogical(id: String): Boolean {
            val caps = cm.getCameraCharacteristics(id).get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
            return caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA)
        }
        val physical = backIds.filter { !isLogical(it) }
        val id = (physical.ifEmpty { backIds }).first()
        val ch = cm.getCameraCharacteristics(id)
        val caps = ch.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
        val manualSensor = caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR)
        val focusCalib = ch.get(CameraCharacteristics.LENS_INFO_FOCUS_DISTANCE_CALIBRATION)
        val manualFocus = focusCalib != null && focusCalib != CameraMetadata.LENS_INFO_FOCUS_DISTANCE_CALIBRATION_UNCALIBRATED
        val tsSource = ch.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
        val realtime = tsSource == CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val pixelArray = ch.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
        val sensorHeight = pixelArray?.height ?: 0

        val hsSizes: List<Pair<Size, List<Range<Int>>>> = try {
            map?.highSpeedVideoSizes?.map { s -> s to (map.getHighSpeedVideoFpsRangesFor(s)?.toList() ?: emptyList()) } ?: emptyList()
        } catch (_: Exception) { emptyList() }
        val aeRanges = ch.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList() ?: emptyList()
        val yuvSizes = map?.getOutputSizes(ImageFormat.YUV_420_888)?.toList() ?: emptyList()

        fun pickHighSpeed(fps: Int): Pair<Size, Range<Int>>? {
            // faixas fixas (min == max == fps) na menor área disponível
            val options = hsSizes.flatMap { (s, ranges) -> ranges.filter { it.lower == fps && it.upper == fps }.map { s to it } }
            return options.minByOrNull { it.first.width.toLong() * it.first.height }
        }
        fun sizeSupports(s: Size, fps: Int): Boolean {
            val m = map ?: return true
            val minDur = try { m.getOutputMinFrameDuration(ImageFormat.YUV_420_888, s) } catch (_: Exception) { 0L }
            val stall = try { m.getOutputStallDuration(ImageFormat.YUV_420_888, s) } catch (_: Exception) { 0L }
            return stall == 0L && (minDur == 0L || minDur <= 1_000_000_000L / fps)
        }
        fun pickNormal(fps: Int): Pair<Size, Range<Int>>? {
            val r = aeRanges.firstOrNull { it.lower == fps && it.upper == fps } ?: return null
            // 720p (ou a menor ≥ 480 px de altura) que o hardware entrega nessa taxa, para reduzir banda
            val candidates = yuvSizes.filter { sizeSupports(it, fps) }
            val s = candidates.filter { it.height in 480..1080 }.minByOrNull { it.width.toLong() * it.height }
                ?: candidates.minByOrNull { it.width.toLong() * it.height } ?: return null
            return s to r
        }
        fun pickNormalAny(): Triple<CaptureMode, Size, Range<Int>> {
            // maior faixa FIXA; senão a de maior piso, fixada no piso (nunca uma faixa variável:
            // o período do quadro precisa ser conhecido)
            val fixed = aeRanges.filter { it.lower == it.upper }.maxByOrNull { it.upper }
            val r = fixed ?: (aeRanges.maxByOrNull { it.lower }?.let { Range(it.lower, it.lower) } ?: Range(30, 30))
            val fps = r.upper
            val candidates = yuvSizes.filter { sizeSupports(it, fps) }
            val s = candidates.filter { it.height in 480..1080 }.minByOrNull { it.width.toLong() * it.height }
                ?: candidates.minByOrNull { it.width.toLong() * it.height } ?: Size(1280, 720)
            val mode = when {
                fps >= 120 -> CaptureMode.NORMAL_120
                fps >= 60 -> CaptureMode.NORMAL_60
                else -> CaptureMode.NORMAL_30
            }
            return Triple(mode, s, r)
        }

        val normalBest: Triple<CaptureMode, Size, Range<Int>> = run {
            pickNormal(120)?.let { return@run Triple(CaptureMode.NORMAL_120, it.first, it.second) }
            pickNormal(60)?.let { return@run Triple(CaptureMode.NORMAL_60, it.first, it.second) }
            pickNormalAny()
        }
        val chosen: Triple<CaptureMode, Size, Range<Int>> = run {
            pickHighSpeed(240)?.let { return@run Triple(CaptureMode.HIGH_SPEED_240, it.first, it.second) }
            pickHighSpeed(120)?.let { return@run Triple(CaptureMode.HIGH_SPEED_120, it.first, it.second) }
            normalBest
        }
        val nrModes = ch.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES) ?: intArrayOf()
        val edgeModes = ch.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES) ?: intArrayOf()
        val oisModes = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION) ?: intArrayOf()
        return DeviceCapability(
            cameraId = id,
            mode = chosen.first,
            size = chosen.second,
            fpsRange = chosen.third,
            manualSensor = manualSensor,
            manualFocus = manualFocus,
            timestampRealtime = realtime,
            exposureRangeNs = ch.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE),
            isoRange = ch.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE),
            sensorHeightPx = sensorHeight,
            sensorOrientation = ch.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90,
            highSpeedSizes = hsSizes,
            aeFpsRanges = aeRanges,
            aeLockAvailable = ch.get(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) ?: false,
            awbLockAvailable = ch.get(CameraCharacteristics.CONTROL_AWB_LOCK_AVAILABLE) ?: false,
            noiseReductionOff = nrModes.contains(CameraMetadata.NOISE_REDUCTION_MODE_OFF),
            edgeOff = edgeModes.contains(CameraMetadata.EDGE_MODE_OFF),
            oisOff = oisModes.isEmpty() || oisModes.contains(CameraMetadata.LENS_OPTICAL_STABILIZATION_MODE_OFF),
            logicalMultiCamera = isLogical(id),
            zoomRatioRange = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) ch.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) else null,
            normalFallback = if (chosen.first.highSpeed) normalBest else null,
        )
    }
}
