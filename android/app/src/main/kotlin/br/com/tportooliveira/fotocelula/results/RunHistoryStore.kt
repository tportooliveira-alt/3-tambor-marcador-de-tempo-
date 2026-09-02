package br.com.tportooliveira.fotocelula.results

import android.content.Context
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import org.json.JSONArray
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Histórico em JSON no armazenamento interno + exportação CSV (separador ";" e vírgula decimal). */
class RunHistoryStore(context: Context) {
    private val file = File(context.filesDir, "historico.json")
    private val _records = ArrayList<RunRecord>()
    val records: List<RunRecord> get() = _records

    init { load() }

    fun add(r: RunRecord) { _records.add(0, r); save() }
    fun update(r: RunRecord) { val i = _records.indexOfFirst { it.id == r.id }; if (i >= 0) { _records[i] = r; save() } }
    fun remove(id: String) { _records.removeAll { it.id == id }; save() }
    fun clear() { _records.clear(); save() }

    private fun load() {
        if (!file.exists()) return
        try {
            val arr = JSONArray(file.readText())
            _records.clear()
            for (i in 0 until arr.length()) _records.add(RunRecord.fromJson(arr.getJSONObject(i)))
        } catch (_: Exception) { }
    }

    private fun save() {
        val arr = JSONArray()
        for (r in _records) arr.put(r.toJson())
        file.writeText(arr.toString(2))
    }

    fun toCsv(): String {
        val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.ROOT)
        fun dec(v: Double, places: Int) = String.format(Locale.ROOT, "%.${places}f", v).replace('.', ',')
        fun q(s: String) = "\"" + s.replace("\"", "\"\"") + "\""
        val sb = StringBuilder()
        sb.append(listOf("data", "competidor", "cavalo", "tempo_final", "tempo_bruto_s", "tempo_refinado_s", "tambores_derrubados",
            "penalidade_s", "sem_tempo", "degradada", "drops", "qualidade_largada", "qualidade_chegada", "incerteza_largada_ms",
            "incerteza_chegada_ms", "limiar_largada", "limiar_chegada", "lag_referencia", "exposicao_us", "iso", "modo", "observacoes")
            .joinToString(";")).append('\n')
        for (r in _records) {
            sb.append(listOf(
                df.format(Date(r.dateMillis)), q(r.rider), q(r.horse), r.finalText.replace('.', ','),
                dec(r.elapsedRawNs / 1e9, 3), dec(r.elapsedRefinedNs / 1e9, 4), "${r.barrelsKnocked}", "${r.barrelsKnocked * 5}",
                if (r.noTime) "sim" else "não", if (r.degraded) "sim" else "não", "${r.drops}", "${r.startQuality}", "${r.finishQuality}",
                dec(r.startUncertaintyNs / 1e6, 3), dec(r.finishUncertaintyNs / 1e6, 3), dec(r.thresholdStart, 2), dec(r.thresholdFinish, 2),
                "${r.referenceLag}", "${r.exposureNs / 1000}", "${r.iso}", q(r.mode), q(r.notes),
            ).joinToString(";")).append('\n')
        }
        return sb.toString()
    }
}
