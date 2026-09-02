package br.com.tportooliveira.fotocelula.camera

import android.os.SystemClock

/**
 * Relógio do sensor. Os timestamps dos quadros (SENSOR_TIMESTAMP) estão em CLOCK_BOOTTIME
 * (`SystemClock.elapsedRealtimeNanos()`) quando a fonte é REALTIME; caso contrário estão num
 * relógio próprio, ainda monotônico. Estimamos o deslocamento entre os dois a cada quadro
 * (mínimo observado, pois a latência de entrega só atrasa) para poder ler "agora" no relógio
 * do sensor — usado apenas para o cronômetro de tela e para agendar wake-ups; os eventos em si
 * usam sempre o timestamp do quadro.
 */
class SensorClock(private val realtime: Boolean) {
    @Volatile private var offsetNs: Long = if (realtime) 0L else Long.MIN_VALUE

    /** Chame a cada quadro entregue com o timestamp do sensor. */
    fun observe(frameTsNs: Long) {
        if (realtime) return
        val delta = frameTsNs - SystemClock.elapsedRealtimeNanos()
        // delta = ts_sensor − ts_entrega (negativo); o maior valor é a menor latência de entrega
        if (offsetNs == Long.MIN_VALUE || delta > offsetNs) offsetNs = delta
    }

    fun nowNs(): Long {
        val o = offsetNs
        return SystemClock.elapsedRealtimeNanos() + (if (o == Long.MIN_VALUE) 0L else o)
    }
}
