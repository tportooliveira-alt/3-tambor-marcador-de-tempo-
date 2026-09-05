package br.com.tportooliveira.fotocelula.ui

import android.graphics.Matrix
import android.graphics.RectF
import android.view.Surface

/**
 * Geometria do preview.
 *
 * O buffer do sensor (ImageReader e leitor GL) está na orientação NATIVA do sensor: para uma câmera
 * traseira com SENSOR_ORIENTATION = 90, isso é a paisagem "normal" (ROTATION_90) e fica de cabeça
 * para baixo em ROTATION_270. A imagem é exibida "fit" (letterbox) no TextureView.
 *
 * Dois produtores desenham no TextureView:
 *  - o leitor GL (sessão de alta velocidade) desenha a textura do sensor diretamente: só "fit"
 *    (+180° quando invertido);
 *  - o Camera2 (sessão normal) entrega buffers marcados com a rotação do sensor, que o TextureView
 *    aplica como se o aparelho estivesse em retrato; em paisagem é preciso a transformação clássica
 *    do Camera2Basic (rotação de ∓90° + escala) — [bufferRotatedBySensor].
 *
 * bufferX/bufferY convertem frações da tela → frações do buffer do sensor e valem para os dois casos,
 * porque o resultado exibido é o mesmo (sensor "fit", ±180°).
 */
data class PreviewGeometry(
    val viewW: Float,
    val viewH: Float,
    val sensorW: Float,
    val sensorH: Float,
    val sensorOrientation: Int,
    val displayRotation: Int,
    val bufferRotatedBySensor: Boolean,
) {
    /** Verdadeiro quando a imagem do sensor aparece invertida (180°) nesta orientação de tela. */
    val rotated180: Boolean
        get() = (sensorOrientation == 90 && displayRotation == Surface.ROTATION_270) ||
            (sensorOrientation == 270 && displayRotation == Surface.ROTATION_90)

    private val fitScale: Float
        get() = if (viewW <= 0f || viewH <= 0f || sensorW <= 0f || sensorH <= 0f) 1f else minOf(viewW / sensorW, viewH / sensorH)

    /** Retângulo da imagem do sensor na tela ("fit", centrado). */
    val imageRect: RectF = run {
        if (viewW <= 0f || viewH <= 0f || sensorW <= 0f || sensorH <= 0f) return@run RectF(0f, 0f, viewW, viewH)
        val w = sensorW * fitScale
        val h = sensorH * fitScale
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
        val fitW = imageRect.width()
        val fitH = imageRect.height()
        if (bufferRotatedBySensor && (displayRotation == Surface.ROTATION_90 || displayRotation == Surface.ROTATION_270)) {
            // O conteúdo chega rotacionado 90° e esticado na view. Vamos rotacioná-lo de volta (∓90°);
            // a rotação troca os eixos, então ANTES dela o conteúdo precisa medir (fitH × fitW) para
            // terminar em (fitW × fitH) — a mesma conta do Camera2Basic, mas com "fit" em vez de "fill".
            m.setScale(fitH / viewW, fitW / viewH, cx, cy)
            m.postRotate(90f * (displayRotation - 2), cx, cy)
            return m
        }
        // Leitor GL (ou tela em retrato): só o fit e a inversão de 180° quando necessário.
        m.setScale(fitW / viewW, fitH / viewH, cx, cy)
        if (rotated180) m.postRotate(180f, cx, cy)
        return m
    }
}
