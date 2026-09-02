package br.com.tportooliveira.fotocelula.core

/**
 * Regra de classificação de uma prova (porte de `Tools/event_scoring.py`, conferida pelo vetor
 * compartilhado `event_ranking.json`).
 *
 * Tempo final = tempo REFINADO da passada + 5 s por tambor derrubado; "sem tempo" (SAT) fica sempre
 * por último, sem colocação; empate resolve pelo tempo bruto e, persistindo, pela ordem de largada.
 *
 * O refinado é sempre o usado (mesmo em qualidade 0, onde ele é o centro do intervalo físico do
 * gatilho): é o número que o app mostra, e classificar por outro seria mentir para o competidor.
 */
object EventScoring {
    const val PENALTY_PER_BARREL_NS: Nanos = 5_000_000_000L

    /** O mínimo de uma passada para classificar (o `RunRecord` do app se converte nisto). */
    data class Run(
        val entryOrder: Int,
        val elapsedRefinedNs: Nanos,
        val elapsedRawNs: Nanos,
        val barrelsKnocked: Int = 0,
        val noTime: Boolean = false,
        val category: String = "",
    )

    data class Placing(
        val entryOrder: Int,
        /** null para SAT (sem colocação). */
        val place: Int?,
        val finalNs: Nanos,
        val penaltyNs: Nanos,
    )

    fun penaltyNs(r: Run): Nanos = r.barrelsKnocked * PENALTY_PER_BARREL_NS

    fun finalNs(r: Run): Nanos = r.elapsedRefinedNs + penaltyNs(r)

    /** Classifica uma lista já filtrada por categoria. Ordem determinística nas três linguagens. */
    fun rank(runs: List<Run>): List<Placing> {
        val sorted = runs.sortedWith(
            compareBy<Run> { if (it.noTime) 1 else 0 }
                .thenBy { finalNs(it) }
                .thenBy { it.elapsedRawNs }
                .thenBy { it.entryOrder }
        )
        val out = ArrayList<Placing>(sorted.size)
        var place = 0
        for (r in sorted) {
            if (r.noTime) {
                out.add(Placing(r.entryOrder, null, 0L, penaltyNs(r)))
            } else {
                place += 1
                out.add(Placing(r.entryOrder, place, finalNs(r), penaltyNs(r)))
            }
        }
        return out
    }

    /** Classifica dentro de cada categoria; a saída sai agrupada por categoria (ordem alfabética). */
    fun rankByCategory(runs: List<Run>): List<Placing> {
        val out = ArrayList<Placing>(runs.size)
        for (cat in runs.map { it.category }.distinct().sorted()) {
            out.addAll(rank(runs.filter { it.category == cat }))
        }
        return out
    }
}
