package br.com.tportooliveira.fotocelula.ui

import android.graphics.Matrix
import android.graphics.RectF
import android.view.Surface

/**
 * Geometria do preview.
 *
 * O buffer do sensor (ImageReader e leitor GL) está na orientação NATIVA do sensor: para uma
 * câmera traseira com SENSOR_ORIENTATION = 90, isso é a paisagem "normal" (ROTATION_90) e fica
 * de cabeça para baixo em ROTATION_270. A imagem é exibida "fit" (letterbox) no TextureView.
 *
 * Na sessão normal, o próprio Camera2 desenha no TextureView já rotacionado para a orientação
 * natural do aparelho (retrato), então o TextureView precisa da transformação clássica do
 * Camera2Basic (rotação de ±90° + escala) para aparecer certo em paisagem; no leitor GL nós
 * desenhamos a textura do sensor diretamente, e só o "fit" (+180° quando invertido) se aplica.
 *
 * As funções bufferX/bufferY convertem frações da tela → frações do buffer do sensor.
 */
data class PreviewGeometry(
    val viewW: Float,
    val viewH: Float,
    val sensorW: Float,
    val sensorH: Float,
    val sensorOrientation: Int,
    val displayRotation: Int,
    val cameraRendersNatural: Boolean,
) {
    /** Verdadeiro quando a imagem do sensor aparece invertida (180°) nesta orientação de tela. */
    val rotated180: Boolean
        get() = (sensorOrientation == 90 && displayRotation == Surface.ROTATION_270) ||
            (sensorOrientation == 270 && displayRotation == Surface.ROTATION_90)

    val imageRect: RectF = run {
        if (viewW <= 0f || viewH <= 0f || sensorW <= 0f || sensorH <= 0f) return@run RectF(0f, 0f, viewW, viewH)
        val scale = minOf(viewW / sensorW, viewH / sensorH)
        val w = sensorW * scale
        val h = sensorH * scale
        val l = (viewW - w) / 2f
        val t = (viewH - h) / 2f
        RectF(l, t, l + w, t + h)
    }

    /** Fração da tela (x) → fração do buffer do sensor. */
    fun bufferX(viewFracX: Float): Double {
        val x = viewFracX * viewW
        val f = ((x - imageRect.left) / imageRect.width()).coerceIn(0f, 1f)
        return (if (rotated180) 1f - f else f).toDouble()
    }

    fun bufferY(viewFracY: Float): Double {
        val y = viewFracY * viewH
        val f = ((y - imageRect.top) / imageRect.height()).coerceIn(0f, 1f)
        return (if (rotated180) 1f - f else f).toDouble()
    }

    /** Transformação a aplicar ao TextureView. */
    fun textureTransform(): Matrix {
        val m = Matrix()
        if (viewW <= 0f || viewH <= 0f) return m
        val cx = viewW / 2f
        val cy = viewH / 2f
        if (cameraRendersNatural && (displayRotation == Surface.ROTATION_90 || displayRotation == Surface.ROTATION_270)) {
            // Camera2Basic: o buffer chega em orientação natural (retrato); em paisagem rotacionamos ±90°
            // e escalamos para caber ("fit") mantendo a proporção do sensor.
            val viewRect = RectF(0f, 0f, viewW, viewH)
            val bufferRect = RectF(0f, 0f, viewH, viewW)
            bufferRect.offset(cx - bufferRect.centerX(), cy - bufferRect.centerY())
            m.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL)
            val fit = minOf(viewW / sensorW, viewH / sensorH)
            val sx = (sensorW * fit) / viewW
            val sy = (sensorH * fit) / viewH
            m.postScale(sx / (viewH / viewW), sy / (viewW / viewH), cx, cy)
            m.postRotate(90f * (displayRotation - 2), cx, cy)
            return m
        }
        // Leitor GL (ou tela em retrato): só o fit e a inversão de 180° quando necessário.
        val sx = imageRect.width() / viewW
        val sy = imageRect.height() / viewH
        m.setScale(sx, sy, cx, cy)
        if (rotated180) m.postRotate(180f, cx, cy)
        return m
    }
}
