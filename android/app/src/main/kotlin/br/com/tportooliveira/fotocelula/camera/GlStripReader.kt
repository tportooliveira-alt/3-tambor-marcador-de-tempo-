package br.com.tportooliveira.fotocelula.camera

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Leitor de faixa via OpenGL ES para a sessão de alta velocidade (que só aceita superfícies de
 * preview/gravação, não ImageReader). Recebe os quadros num SurfaceTexture próprio; a cada quadro:
 *   1. `updateTexImage()` (textura externa OES) e `getTimestamp()` (= SENSOR_TIMESTAMP);
 *   2. renderiza SOMENTE a região da faixa num FBO minúsculo (largura × altura da banda), com o
 *      shader convertendo para luminância (Y = 0.299R + 0.587G + 0.114B);
 *   3. `glReadPixels` do FBO (poucos KB) e entrega ao [StripSink];
 *   4. a cada N quadros desenha o quadro inteiro na superfície de preview (60 Hz na tela).
 * Tudo numa HandlerThread própria com contexto EGL; nenhuma alocação por quadro.
 */
class GlStripReader(
    private val sensorWidth: Int,
    private val sensorHeight: Int,
    private val sink: StripSink,
    private val previewEveryN: Int = 4,
) {
    companion object { private const val TAG = "GlStripReader" }

    private val thread = HandlerThread("gl-strip", android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
    val handler = Handler(thread.looper)

    private var eglDisplay: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var eglContext: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglConfig: EGLConfig? = null
    private var pbufferSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var previewEglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var previewSurface: Surface? = null
    private var previewW = 0
    private var previewH = 0

    private var oesTexture = 0
    private var fbo = 0
    private var fboTexture = 0
    private var program = 0
    private var uTexMatrix = 0
    private var uRegion = 0
    private var uLuma = 0
    private val texMatrix = FloatArray(16)
    private var quadVbo = 0

    lateinit var surfaceTexture: SurfaceTexture
        private set
    lateinit var cameraSurface: Surface
        private set

    @Volatile var roi = NormalizedRoi()
    @Volatile var enabled = true
    private var roiW = 0
    private var roiH = 0
    private var roiX0 = 0
    private var roiY0 = 0
    private var readBuffer: ByteBuffer = ByteBuffer.allocateDirect(4)
    private var lumaBuffer: ByteBuffer = ByteBuffer.allocateDirect(1)
    private var frameCounter = 0L

    /** Inicializa EGL/GL na thread própria e devolve o Surface para a câmera (bloqueante); null em falha. */
    fun start(): Surface? {
        val lock = Object()
        var ready = false
        var failure: Throwable? = null
        handler.post {
            try {
                initEgl()
                initGl()
                surfaceTexture = SurfaceTexture(oesTexture).apply {
                    setDefaultBufferSize(sensorWidth, sensorHeight)
                    setOnFrameAvailableListener({ onFrameAvailable() }, handler)
                }
                cameraSurface = Surface(surfaceTexture)
            } catch (t: Throwable) {
                failure = t
            }
            synchronized(lock) { ready = true; lock.notifyAll() }
        }
        synchronized(lock) { while (!ready) lock.wait() }
        if (failure != null) {
            Log.e(TAG, "Falha ao iniciar GL: ${failure?.message}")
            return null
        }
        return cameraSurface
    }

    fun setPreviewSurface(surface: Surface?, width: Int, height: Int) {
        handler.post {
            if (previewEglSurface != EGL14.EGL_NO_SURFACE) {
                EGL14.eglDestroySurface(eglDisplay, previewEglSurface)
                previewEglSurface = EGL14.EGL_NO_SURFACE
            }
            previewSurface = surface
            previewW = width; previewH = height
            if (surface != null) {
                previewEglSurface = EGL14.eglCreateWindowSurface(eglDisplay, eglConfig, surface, intArrayOf(EGL14.EGL_NONE), 0)
            }
            EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)
        }
    }

    fun release() {
        handler.post {
            try { surfaceTexture.release() } catch (_: Exception) {}
            if (previewEglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, previewEglSurface)
            if (pbufferSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(eglDisplay, pbufferSurface)
            EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
            EGL14.eglDestroyContext(eglDisplay, eglContext)
            EGL14.eglTerminate(eglDisplay)
            thread.quitSafely()
        }
    }

    // ---------------------------------------------------------------- EGL / GL
    private fun initEgl() {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val v = IntArray(2)
        check(EGL14.eglInitialize(eglDisplay, v, 0, v, 1)) { "eglInitialize" }
        val attribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT or 0x40 /* EGL_OPENGL_ES3_BIT_KHR */,
            EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val n = IntArray(1)
        check(EGL14.eglChooseConfig(eglDisplay, attribs, 0, configs, 0, 1, n, 0) && n[0] > 0) { "eglChooseConfig" }
        eglConfig = configs[0]
        eglContext = EGL14.eglCreateContext(eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
        check(eglContext != EGL14.EGL_NO_CONTEXT) { "eglCreateContext" }
        pbufferSurface = EGL14.eglCreatePbufferSurface(eglDisplay, eglConfig,
            intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
        check(EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)) { "eglMakeCurrent" }
    }

    private fun initGl() {
        val tex = IntArray(1)
        GLES30.glGenTextures(1, tex, 0)
        oesTexture = tex[0]
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexture)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)

        program = buildProgram(VERTEX, FRAGMENT)
        uTexMatrix = GLES30.glGetUniformLocation(program, "uTexMatrix")
        uRegion = GLES30.glGetUniformLocation(program, "uRegion")
        uLuma = GLES30.glGetUniformLocation(program, "uLuma")

        val quad = floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)
        val vb = ByteBuffer.allocateDirect(quad.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(quad)
        vb.position(0)
        val ids = IntArray(1)
        GLES30.glGenBuffers(1, ids, 0)
        quadVbo = ids[0]
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, quadVbo)
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, quad.size * 4, vb, GLES30.GL_STATIC_DRAW)

        GLES30.glGenFramebuffers(1, ids, 0)
        fbo = ids[0]
        GLES30.glGenTextures(1, ids, 0)
        fboTexture = ids[0]
    }

    private fun ensureRoiBuffers() {
        val px = roi.toPixels(sensorWidth, sensorHeight)
        val w = px.width
        val h = px.height
        roiX0 = px.x; roiY0 = px.y0
        if (w != roiW || h != roiH) {
            roiW = w; roiH = h
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, fboTexture)
            GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA, w, h, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST)
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
            GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, fboTexture, 0)
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            readBuffer = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
            lumaBuffer = ByteBuffer.allocateDirect(w * h).order(ByteOrder.nativeOrder())
        }
    }

    private fun onFrameAvailable() {
        // Chamado na nossa HandlerThread (listener registrado com o handler).
        surfaceTexture.updateTexImage()
        val ts = surfaceTexture.timestamp   // = SENSOR_TIMESTAMP do quadro
        surfaceTexture.getTransformMatrix(texMatrix)
        frameCounter++
        if (enabled) {
            ensureRoiBuffers()
            renderStrip()
            readStrip(ts)
        }
        if (previewSurface != null && frameCounter % previewEveryN == 0L) renderPreview()
    }

    private fun drawQuad(x0: Float, y0: Float, x1: Float, y1: Float, luma: Boolean) {
        GLES30.glUseProgram(program)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexture)
        GLES30.glUniformMatrix4fv(uTexMatrix, 1, false, texMatrix, 0)
        GLES30.glUniform4f(uRegion, x0, y0, x1, y1)
        GLES30.glUniform1i(uLuma, if (luma) 1 else 0)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, quadVbo)
        GLES30.glEnableVertexAttribArray(0)
        GLES30.glVertexAttribPointer(0, 2, GLES30.GL_FLOAT, false, 0, 0)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun renderStrip() {
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
        GLES30.glViewport(0, 0, roiW, roiH)
        // Região da faixa em coordenadas de textura (0..1). A matriz do SurfaceTexture espera
        // coordenadas com origem no canto INFERIOR esquerdo da imagem, então a banda
        // [roiY0, roiY0+roiH) (linhas contadas do topo) vira t em [1 - (y0+h)/H, 1 - y0/H].
        val x0 = roiX0.toFloat() / sensorWidth
        val x1 = (roiX0 + roiW).toFloat() / sensorWidth
        val t0 = 1f - (roiY0 + roiH).toFloat() / sensorHeight
        val t1 = 1f - roiY0.toFloat() / sensorHeight
        drawQuad(x0, t0, x1, t1, luma = true)
    }

    private fun readStrip(ts: Long) {
        readBuffer.rewind()
        GLES30.glReadPixels(0, 0, roiW, roiH, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, readBuffer)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        // RGBA -> só o canal R (já é a luminância calculada no shader). glReadPixels devolve linhas
        // de baixo para cima: invertemos para manter a convenção "linha 0 = topo".
        val n = roiW * roiH
        for (row in 0 until roiH) {
            val src = (roiH - 1 - row) * roiW
            val dst = row * roiW
            for (i in 0 until roiW) {
                lumaBuffer.put(dst + i, readBuffer.get((src + i) * 4))
            }
        }
        sink.onFrame(lumaBuffer, roiW, roiW, roiH, ts, localRoi = true)
    }

    private fun renderPreview() {
        if (!EGL14.eglMakeCurrent(eglDisplay, previewEglSurface, previewEglSurface, eglContext)) return
        GLES30.glViewport(0, 0, previewW, previewH)
        drawQuad(0f, 0f, 1f, 1f, luma = false)
        EGL14.eglSwapBuffers(eglDisplay, previewEglSurface)
        EGL14.eglMakeCurrent(eglDisplay, pbufferSurface, pbufferSurface, eglContext)
    }

    /** Coordenadas do último recorte (para o serviço montar a ROI em coordenadas do sensor). */
    fun currentRoiRect(): IntArray = intArrayOf(roiX0, roiW, roiY0, roiY0 + roiH)

    private fun buildProgram(vs: String, fs: String): Int {
        fun compile(type: Int, src: String): Int {
            val s = GLES30.glCreateShader(type)
            GLES30.glShaderSource(s, src)
            GLES30.glCompileShader(s)
            val ok = IntArray(1)
            GLES30.glGetShaderiv(s, GLES30.GL_COMPILE_STATUS, ok, 0)
            check(ok[0] != 0) { "shader: " + GLES30.glGetShaderInfoLog(s) }
            return s
        }
        val p = GLES30.glCreateProgram()
        GLES30.glAttachShader(p, compile(GLES30.GL_VERTEX_SHADER, vs))
        GLES30.glAttachShader(p, compile(GLES30.GL_FRAGMENT_SHADER, fs))
        GLES30.glBindAttribLocation(p, 0, "aPos")
        GLES30.glLinkProgram(p)
        val ok = IntArray(1)
        GLES30.glGetProgramiv(p, GLES30.GL_LINK_STATUS, ok, 0)
        check(ok[0] != 0) { "program: " + GLES30.glGetProgramInfoLog(p) }
        Log.i(TAG, "programa GL pronto")
        return p
    }

    private val VERTEX = """
        #version 300 es
        in vec2 aPos;
        uniform mat4 uTexMatrix;
        uniform vec4 uRegion;   // x0, y0, x1, y1 em coordenadas de textura (0..1)
        out vec2 vTex;
        void main() {
            vec2 uv = (aPos + 1.0) * 0.5;
            vec2 region = mix(uRegion.xy, uRegion.zw, uv);
            vTex = (uTexMatrix * vec4(region, 0.0, 1.0)).xy;
            gl_Position = vec4(aPos, 0.0, 1.0);
        }
    """.trimIndent()

    private val FRAGMENT = """
        #version 300 es
        #extension GL_OES_EGL_image_external_essl3 : require
        precision mediump float;
        in vec2 vTex;
        uniform samplerExternalOES uTex;
        uniform int uLuma;
        out vec4 fragColor;
        void main() {
            vec4 c = texture(uTex, vTex);
            if (uLuma == 1) {
                float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                fragColor = vec4(y, y, y, 1.0);
            } else {
                fragColor = c;
            }
        }
    """.trimIndent()
}
