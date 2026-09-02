package br.com.tportooliveira.fotocelula.results

import android.content.Context
import br.com.tportooliveira.fotocelula.core.EventScoring
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

/** Uma prova (evento). Vive só no aparelho: sem conta, sem servidor, sem rede. */
data class Event(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val dateMillis: Long = System.currentTimeMillis(),
    val place: String = "",
    val notes: String = "",
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("dateMillis", dateMillis); put("place", place); put("notes", notes)
    }

    companion object {
        fun fromJson(j: JSONObject) = Event(
            id = j.getString("id"), name = j.optString("name"), dateMillis = j.optLong("dateMillis"),
            place = j.optString("place"), notes = j.optString("notes"),
        )
    }
}

/** Uma inscrição na prova: quem larga, em que ordem, em que categoria. */
data class Entry(
    val id: String = UUID.randomUUID().toString(),
    val eventId: String,
    val order: Int,
    val rider: String,
    val horse: String = "",
    val category: String = "",
) {
    /** Rótulo curto para a faixa "Próximo" (o operador lê de longe). */
    val label: String get() = buildString {
        append("#").append(order).append(' ').append(rider)
        if (horse.isNotBlank()) append(" / ").append(horse)
        if (category.isNotBlank()) append(" — ").append(category)
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("eventId", eventId); put("order", order)
        put("rider", rider); put("horse", horse); put("category", category)
    }

    companion object {
        fun fromJson(j: JSONObject) = Entry(
            id = j.getString("id"), eventId = j.getString("eventId"), order = j.optInt("order"),
            rider = j.optString("rider"), horse = j.optString("horse"), category = j.optString("category"),
        )
    }
}

/**
 * Provas e inscrições em JSON no armazenamento interno, no mesmo padrão do [RunHistoryStore]:
 * escrita fora da main thread, gravação atômica (temporário + rename) e leitura tolerante a arquivo
 * corrompido (o app abre vazio em vez de morrer na arena).
 */
class EventStore(context: Context) {
    private val file = File(context.filesDir, "provas.json")
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "events-io") }
    private val _events = ArrayList<Event>()
    private val _entries = ArrayList<Entry>()
    /** Prova aberta no painel (nulo = cronômetro avulso, como o app era antes). */
    var currentEventId: String? = null
        private set

    val events: List<Event> get() = _events

    init { load() }

    fun entriesOf(eventId: String): List<Entry> =
        _entries.filter { it.eventId == eventId }.sortedWith(compareBy({ it.order }, { it.rider }))

    fun event(id: String?): Event? = _events.firstOrNull { it.id == id }

    fun entry(id: String?): Entry? = _entries.firstOrNull { it.id == id }

    fun addEvent(e: Event) { _events.add(0, e); currentEventId = e.id; save() }

    fun updateEvent(e: Event) {
        val i = _events.indexOfFirst { it.id == e.id }
        if (i >= 0) { _events[i] = e; save() }
    }

    fun removeEvent(id: String) {
        _events.removeAll { it.id == id }
        _entries.removeAll { it.eventId == id }
        if (currentEventId == id) currentEventId = null
        save()
    }

    fun select(id: String?) { currentEventId = id; save() }

    fun addEntry(e: Entry) { _entries.add(e); save() }

    fun updateEntry(e: Entry) {
        val i = _entries.indexOfFirst { it.id == e.id }
        if (i >= 0) { _entries[i] = e; save() }
    }

    fun removeEntry(id: String) { _entries.removeAll { it.id == id }; save() }

    /**
     * Próxima inscrição a largar: a de menor ordem que ainda não tem passada salva. `records` é o
     * histórico completo (o vínculo é por `entryId`).
     */
    fun nextEntry(eventId: String, records: List<RunRecord>): Entry? {
        val done = records.mapNotNull { it.entryId }.toHashSet()
        return entriesOf(eventId).firstOrNull { it.id !in done }
    }

    /**
     * Importa a lista de largada de um CSV `ordem;competidor;cavalo;categoria` (separador ";" ou ",",
     * cabeçalho opcional). Devolve quantas inscrições entraram. Linhas inválidas são ignoradas — a
     * planilha vem de terceiros e não pode derrubar o app na hora da prova.
     */
    fun importEntries(eventId: String, csv: String): Int {
        var added = 0
        var nextOrder = (entriesOf(eventId).maxOfOrNull { it.order } ?: 0) + 1
        for (raw in csv.lineSequence()) {
            val line = raw.trim().removePrefix("﻿")
            if (line.isEmpty()) continue
            val sep = if (line.count { it == ';' } >= line.count { it == ',' }) ';' else ','
            val cols = splitCsvLine(line, sep)
            if (cols.isEmpty()) continue
            val order = cols[0].toIntOrNull()
            // cabeçalho ou linha sem número: o nome pode estar na primeira coluna
            val rider = if (order != null) cols.getOrElse(1) { "" } else cols[0]
            if (rider.isBlank()) continue
            if (order == null && rider.lowercase(Locale.ROOT).let {
                    it == "competidor" || it == "nome" || it == "ordem"
                }) continue
            val horse = if (order != null) cols.getOrElse(2) { "" } else cols.getOrElse(1) { "" }
            val category = if (order != null) cols.getOrElse(3) { "" } else cols.getOrElse(2) { "" }
            _entries.add(Entry(eventId = eventId, order = order ?: nextOrder, rider = rider,
                horse = horse, category = category))
            if (order == null) nextOrder++ else nextOrder = maxOf(nextOrder, order + 1)
            added++
        }
        if (added > 0) save()
        return added
    }

    /** Classificação da prova por categoria (regra do núcleo compartilhado). */
    fun ranking(eventId: String, records: List<RunRecord>): List<EventScoring.Placing> =
        EventScoring.rankByCategory(records.filter { it.eventId == eventId }.map { it.toScoringRun() })

    /** CSV da prova: colocação, competidor, tempos, penalidade — o que se imprime ou se manda no zap. */
    fun rankingCsv(eventId: String, records: List<RunRecord>): String {
        fun dec(v: Double, places: Int) = String.format(Locale.ROOT, "%.${places}f", v).replace('.', ',')
        fun q(s: String) = "\"" + s.replace("\"", "\"\"") + "\""
        val mine = records.filter { it.eventId == eventId }
        val byOrder = mine.associateBy { it.entryOrder }
        val sb = StringBuilder()
        sb.append("categoria;colocacao;ordem;competidor;cavalo;tempo_final;tempo_bruto_s;tambores;penalidade_s;sem_tempo\n")
        for (p in ranking(eventId, records)) {
            val r = byOrder[p.entryOrder] ?: continue
            val e = _entries.firstOrNull { it.id == r.entryId }
            sb.append(listOf(
                q(r.category), p.place?.toString() ?: "SAT", "${p.entryOrder}",
                q(e?.rider ?: r.rider), q(e?.horse ?: r.horse),
                if (r.noTime) "SAT" else TimeFormatter.formatElapsed(p.finalNs).replace('.', ','),
                dec(r.elapsedRawNs / 1e9, 3), "${r.barrelsKnocked}", "${p.penaltyNs / 1_000_000_000L}",
                if (r.noTime) "sim" else "não",
            ).joinToString(";")).append('\n')
        }
        return sb.toString()
    }

    // ------------------------------------------------------------------ persistência
    private fun load() {
        if (!file.exists()) return
        try {
            val root = JSONObject(file.readText())
            val ev = root.optJSONArray("events") ?: JSONArray()
            for (i in 0 until ev.length()) _events.add(Event.fromJson(ev.getJSONObject(i)))
            val en = root.optJSONArray("entries") ?: JSONArray()
            for (i in 0 until en.length()) _entries.add(Entry.fromJson(en.getJSONObject(i)))
            currentEventId = if (root.isNull("currentEventId")) null else root.optString("currentEventId").ifEmpty { null }
            if (event(currentEventId) == null) currentEventId = null
        } catch (_: Exception) {
            _events.clear(); _entries.clear(); currentEventId = null
        }
    }

    private fun save() {
        val root = JSONObject()
        val ev = JSONArray(); for (e in _events) ev.put(e.toJson())
        val en = JSONArray(); for (e in _entries) en.put(e.toJson())
        root.put("events", ev); root.put("entries", en)
        currentEventId?.let { root.put("currentEventId", it) }
        val text = root.toString(2)
        io.execute {
            try {
                val tmp = File(file.path + ".tmp")
                tmp.writeText(text)
                if (!tmp.renameTo(file)) file.writeText(text)
            } catch (_: Exception) { }
        }
    }

    /** Divide uma linha de CSV respeitando aspas duplas (planilhas exportam nomes com ponto e vírgula). */
    private fun splitCsvLine(line: String, sep: Char): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var quoted = false
        var i = 0
        while (i < line.length) {
            val c = line[i]
            when {
                quoted && c == '"' && i + 1 < line.length && line[i + 1] == '"' -> { cur.append('"'); i++ }
                c == '"' -> quoted = !quoted
                c == sep && !quoted -> { out.add(cur.toString().trim()); cur.setLength(0) }
                else -> cur.append(c)
            }
            i++
        }
        out.add(cur.toString().trim())
        return out
    }
}
