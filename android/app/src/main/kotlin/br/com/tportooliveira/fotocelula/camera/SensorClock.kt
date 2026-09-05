package br.com.tportooliveira.fotocelula.camera

import android.os.SystemClock

/**
 * Relógio do sensor. Os timestamps dos quadros (SENSOR_TIMESTAMP) estão em CLOCK_BOOTTIME
 * (`SystemClock.elapsedRealtimeNanos()`) quando a fonte é REALTIME. Com fonte UNKNOWN estão na
 * base de `System.nanoTime()` (CLOCK_MONOTONIC) na prática — comparável só dentro da mesma
 * câmera; estimamos o deslocamento fixo entre os dois a cada quadro (o maior valor observado, pois a
 * latência de entrega só atrasa) para poder ler "agora" no relógio do sensor — usado apenas para o
 * cronômetro de tela e para agendar wake-ups; os eventos em si usam sempre o timestamp do quadro.
 */
class SensorClock(private val realtime: Boolean) {
    @Volatile private var offsetNs: Long = if (realtime) 0L else Long.MIN_VALUE

    /** Chame a cada quadro entregue com o timestamp do sensor. */
    fun observe(frameTsNs: Long) {
        if (realtime) return
        val delta = frameTsNs - System.nanoTime()
        // delta = ts_sensor − agora (negativo pela latência de entrega); o maior valor converge para
        // o deslocamento real entre as bases de tempo (constante enquanto o aparelho não dorme)
        if (offsetNs == Long.MIN_VALUE || delta > offsetNs) offsetNs = delta
    }

    fun nowNs(): Long {
        if (realtime) return SystemClock.elapsedRealtimeNanos()
        val o = offsetNs
        return System.nanoTime() + (if (o == Long.MIN_VALUE) 0L else o)
    }
}
