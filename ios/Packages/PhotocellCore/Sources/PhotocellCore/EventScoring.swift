import Foundation

/// Regra de classificação de uma prova (porte de `Tools/event_scoring.py`, conferida pelo vetor
/// compartilhado `event_ranking.json`).
///
/// Tempo final = tempo REFINADO da passada + 5 s por tambor derrubado; "sem tempo" (SAT) fica sempre
/// por último, sem colocação; empate resolve pelo tempo bruto e, persistindo, pela ordem de largada.
///
/// O refinado é sempre o usado (mesmo em qualidade 0, onde ele é o centro do intervalo físico do
/// gatilho): é o número que o app mostra, e classificar por outro seria mentir para o competidor.
public enum EventScoring {
    public static let penaltyPerBarrelNs: Nanos = 5_000_000_000

    /// O mínimo de uma passada para classificar (o `RunRecord` do app se converte nisto).
    public struct Run: Equatable, Sendable {
        public var entryOrder: Int
        public var elapsedRefinedNs: Nanos
        public var elapsedRawNs: Nanos
        public var barrelsKnocked: Int
        public var noTime: Bool
        public var category: String

        public init(entryOrder: Int, elapsedRefinedNs: Nanos, elapsedRawNs: Nanos,
                    barrelsKnocked: Int = 0, noTime: Bool = false, category: String = "") {
            self.entryOrder = entryOrder
            self.elapsedRefinedNs = elapsedRefinedNs
            self.elapsedRawNs = elapsedRawNs
            self.barrelsKnocked = barrelsKnocked
            self.noTime = noTime
            self.category = category
        }
    }

    public struct Placing: Equatable, Sendable {
        public var entryOrder: Int
        /// nil para SAT (sem colocação).
        public var place: Int?
        public var finalNs: Nanos
        public var penaltyNs: Nanos
    }

    public static func penaltyNs(_ r: Run) -> Nanos { Nanos(r.barrelsKnocked) * penaltyPerBarrelNs }

    public static func finalNs(_ r: Run) -> Nanos { r.elapsedRefinedNs + penaltyNs(r) }

    /// Classifica uma lista já filtrada por categoria. Ordem determinística nas três linguagens.
    ///
    /// O índice de entrada entra como último critério de desempate: `Array.sorted` do Swift não é
    /// estável, e sem ele duas passadas idênticas (mesmo tempo e mesmo número de largada) poderiam
    /// sair em ordem diferente da do Kotlin, cuja ordenação é estável.
    public static func rank(_ runs: [Run]) -> [Placing] {
        let sorted = runs.enumerated().sorted { a, b in
            let ka = (a.element.noTime ? 1 : 0, finalNs(a.element), a.element.elapsedRawNs, a.element.entryOrder, a.offset)
            let kb = (b.element.noTime ? 1 : 0, finalNs(b.element), b.element.elapsedRawNs, b.element.entryOrder, b.offset)
            if ka.0 != kb.0 { return ka.0 < kb.0 }
            if ka.1 != kb.1 { return ka.1 < kb.1 }
            if ka.2 != kb.2 { return ka.2 < kb.2 }
            if ka.3 != kb.3 { return ka.3 < kb.3 }
            return ka.4 < kb.4
        }.map(\.element)
        var out: [Placing] = []
        out.reserveCapacity(sorted.count)
        var place = 0
        for r in sorted {
            if r.noTime {
                out.append(Placing(entryOrder: r.entryOrder, place: nil, finalNs: 0, penaltyNs: penaltyNs(r)))
            } else {
                place += 1
                out.append(Placing(entryOrder: r.entryOrder, place: place, finalNs: finalNs(r), penaltyNs: penaltyNs(r)))
            }
        }
        return out
    }

    /// Classifica dentro de cada categoria; a saída sai agrupada por categoria (ordem alfabética).
    public static func rankByCategory(_ runs: [Run]) -> [Placing] {
        var out: [Placing] = []
        // ordenação por unidades escalares (não por colação): é a mesma ordem que o Kotlin produz
        // com `sorted()`, para categoria acentuada não sair em posição diferente entre plataformas
        var cats: [String] = []
        for r in runs where !cats.contains(r.category) { cats.append(r.category) }
        for cat in cats.sorted(by: { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }) {
            out.append(contentsOf: rank(runs.filter { $0.category == cat }))
        }
        return out
    }
}
