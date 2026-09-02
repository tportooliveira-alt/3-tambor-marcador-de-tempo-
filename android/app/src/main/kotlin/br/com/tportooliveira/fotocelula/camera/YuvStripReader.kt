package br.com.tportooliveira.fotocelula.camera

import android.graphics.ImageFormat
import android.media.ImageReader
import android.os.Handler
import android.view.Surface

/**
 * Leitor de faixa para a sessão normal: ImageReader em YUV_420_888; lê SOMENTE o plano 0 (Y)
 * com o `rowStride` real. A imagem é fechada antes de sair do callback (nunca segurar buffers).
 */
class YuvStripReader(
    width: Int,
    height: Int,
    private val handler: Handler,
    private val sink: StripSink,
) {
    private val reader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3)
    val surface: Surface get() = reader.surface
    @Volatile var enabled = true

    init {
        reader.setOnImageAvailableListener({ r ->
            val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                if (!enabled) return@setOnImageAvailableListener
                val plane = img.planes[0]
                sink.onFrame(plane.buffer, plane.rowStride, img.width, img.height, img.timestamp, localRoi = false)
            } finally {
                img.close()
            }
        }, handler)
    }

    fun release() = reader.close()
}
