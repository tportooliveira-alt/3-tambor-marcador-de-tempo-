package br.com.tportooliveira.fotocelula.core

/** nanos -> "S.mmm" (arredondamento half-up para milésimos). Negativo vira "0.000". */
object TimeFormatter {
    fun formatElapsed(ns: Nanos): String {
        val v = if (ns < 0) 0L else ns
        val ms = (v + 500_000L) / 1_000_000L
        val s = ms / 1000
        val rem = ms % 1000
        return "$s." + rem.toString().padStart(3, '0')
    }

    /** "M:SS.mmm" para mostradores grandes. */
    fun formatClock(ns: Nanos): String {
        val v = if (ns < 0) 0L else ns
        val ms = (v + 500_000L) / 1_000_000L
        val totalS = ms / 1000
        val m = totalS / 60
        val s = totalS % 60
        val rem = ms % 1000
        return "$m:" + s.toString().padStart(2, '0') + "." + rem.toString().padStart(3, '0')
    }
}
