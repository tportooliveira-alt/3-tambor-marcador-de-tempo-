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
) {
    /** Texto de precisão esperada mostrado ao operador. */
    val precisionText: String
        get() = when {
            mode.fps >= 240 -> "≈ ±0,1 ms (refinado) / ±2 ms (por quadro)"
            mode.fps >= 120 -> "≈ ±0,2 ms (refinado) / ±4 ms (por quadro)"
            mode.fps >= 60 -> "≈ ±0,5 ms (refinado) / ±8 ms (por quadro)"
            else -> "≈ ±17 ms por quadro — este aparelho não libera alta velocidade"
        }
}

/**
 * Sonda de capacidade: escolhe a câmera traseira principal (sem lógica multi-câmera) e o melhor
 * modo disponível para apps de terceiros.
 */
object CapabilityProbe {
    fun probe(context: Context): DeviceCapability? {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val backIds = cm.cameraIdList.filter {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        }
        // A primeira câmera traseira listada é a principal (1x) na grande maioria dos aparelhos.
        val id = backIds.firstOrNull() ?: return null
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
        fun pickNormal(fps: Int): Pair<Size, Range<Int>>? {
            val r = aeRanges.firstOrNull { it.lower == fps && it.upper == fps } ?: return null
            // 720p (ou a menor ≥ 640 px de largura) para reduzir banda
            val s = yuvSizes.filter { it.height in 480..1080 }.minByOrNull { it.width.toLong() * it.height } ?: yuvSizes.minByOrNull { it.width.toLong() * it.height } ?: return null
            return s to r
        }

        val chosen: Triple<CaptureMode, Size, Range<Int>> = run {
            pickHighSpeed(240)?.let { return@run Triple(CaptureMode.HIGH_SPEED_240, it.first, it.second) }
            pickHighSpeed(120)?.let { return@run Triple(CaptureMode.HIGH_SPEED_120, it.first, it.second) }
            pickNormal(120)?.let { return@run Triple(CaptureMode.NORMAL_120, it.first, it.second) }
            pickNormal(60)?.let { return@run Triple(CaptureMode.NORMAL_60, it.first, it.second) }
            val r = aeRanges.maxByOrNull { it.upper } ?: Range(30, 30)
            val s = yuvSizes.filter { it.height in 480..1080 }.minByOrNull { it.width.toLong() * it.height } ?: Size(1280, 720)
            Triple(CaptureMode.NORMAL_30, s, r)
        }
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
        )
    }
}
