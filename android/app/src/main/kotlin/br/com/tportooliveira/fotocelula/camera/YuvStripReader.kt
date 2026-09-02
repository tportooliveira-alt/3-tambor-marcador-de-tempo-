package br.com.tportooliveira.fotocelula.camera

import android.graphics.ImageFormat
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface

/**
 * Leitor de faixa para a sessão normal: ImageReader em YUV_420_888; lê SOMENTE o plano 0 (Y)
 * com o `rowStride` real. A imagem é fechada antes de sair do callback (nunca segurar buffers).
 *
 * Roda numa HandlerThread PRÓPRIA (nunca na thread do Camera2): o differencer + engine + estimador
 * executam dentro de `sink.onFrame`. Usa `acquireNextImage()` para nunca pular quadros em silêncio;
 * se a fila estourar, drena e avisa o sink (`onDropped`), que descarta o candidato em confirmação.
 */
class YuvStripReader(
    width: Int,
    height: Int,
    private val sink: StripSink,
) {
    private val thread = HandlerThread("yuv-strip", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
    val handler = Handler(thread.looper)
    private val reader = ImageReader.newInstance(width, height, ImageFormat.YUV_420_888, 3)
    val surface: Surface get() = reader.surface
    @Volatile var enabled = true

    init {
        reader.setOnImageAvailableListener({ r ->
            var img = r.acquireNextImage() ?: return@setOnImageAvailableListener
            // Se houver mais de uma imagem na fila, o processamento atrasou: perdemos quadros para
            // o pipeline. Ficamos com a mais recente e avisamos.
            var dropped = false
            while (true) {
                val next = r.acquireNextImage() ?: break
                img.close()
                img = next
                dropped = true
            }
            try {
                if (!enabled) return@setOnImageAvailableListener
                if (dropped) sink.onDropped()
                val plane = img.planes[0]
                sink.onFrame(plane.buffer, plane.rowStride, img.width, img.height, img.timestamp, localRoi = false)
            } finally {
                img.close()
            }
        }, handler)
    }

    fun release() {
        handler.post {
            reader.close()
            thread.quitSafely()
        }
    }
}
