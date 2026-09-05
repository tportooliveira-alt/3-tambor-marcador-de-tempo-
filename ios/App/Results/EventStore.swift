import Combine
import Foundation
import PhotocellCore

/// Uma linha da classificação: a colocação e a passada que a produziu.
/// Tipo nomeado, não tupla — `ForEach(_:id:)` precisa de um key path, e key path para elemento de
/// tupla não existe em Swift.
struct RankingRow: Identifiable {
    let placing: EventScoring.Placing
    let run: RunRecord
    var id: UUID { run.id }
}

/// Uma prova (evento). Vive só no aparelho: sem conta, sem servidor, sem rede.
struct Event: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var name: String
    var date: Date = Date()
    var place: String = ""
    var notes: String = ""
}

/// Uma inscrição na prova: quem larga, em que ordem, em que categoria.
struct Entry: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var eventId: UUID
    var order: Int
    var rider: String
    var horse: String = ""
    var category: String = ""

    /// Rótulo curto para a faixa "Próximo" (o operador lê de longe).
    var label: String {
        var s = "#\(order) \(rider)"
        if !horse.isEmpty { s += " / \(horse)" }
        if !category.isEmpty { s += " — \(category)" }
        return s
    }
}

/// Provas e inscrições em JSON dentro de Application Support, no mesmo padrão do `RunHistoryStore`:
/// gravação atômica e leitura tolerante a arquivo corrompido (o app abre vazio em vez de morrer na arena).
@MainActor
final class EventStore: ObservableObject {
    @Published private(set) var events: [Event] = []
    @Published private(set) var entries: [Entry] = []
    /// Prova aberta no painel (nulo = cronômetro avulso, como o app era antes).
    @Published private(set) var currentEventId: UUID?

    private let fileURL: URL

    private struct Payload: Codable {
        var events: [Event]
        var entries: [Entry]
        var currentEventId: UUID?
    }

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FotocelulaTambor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("provas.json")
        load()
    }

    // MARK: - consultas
    var currentEvent: Event? { events.first { $0.id == currentEventId } }

    func entries(of eventId: UUID) -> [Entry] {
        entries.filter { $0.eventId == eventId }.sorted { ($0.order, $0.rider) < ($1.order, $1.rider) }
    }

    func entry(_ id: UUID?) -> Entry? {
        guard let id else { return nil }
        return entries.first { $0.id == id }
    }

    /// Próxima inscrição a largar: a de menor ordem que ainda não tem passada salva.
    func nextEntry(of eventId: UUID, records: [RunRecord]) -> Entry? {
        let done = Set(records.compactMap { $0.entryId })
        return entries(of: eventId).first { !done.contains($0.id) }
    }

    // MARK: - edição
    func add(_ e: Event) { events.insert(e, at: 0); currentEventId = e.id; save() }

    func update(_ e: Event) {
        if let i = events.firstIndex(where: { $0.id == e.id }) { events[i] = e; save() }
    }

    func remove(eventId: UUID) {
        events.removeAll { $0.id == eventId }
        entries.removeAll { $0.eventId == eventId }
        if currentEventId == eventId { currentEventId = nil }
        save()
    }

    func select(_ id: UUID?) { currentEventId = id; save() }

    func add(_ e: Entry) { entries.append(e); save() }

    func update(_ e: Entry) {
        if let i = entries.firstIndex(where: { $0.id == e.id }) { entries[i] = e; save() }
    }

    func remove(entryId: UUID) { entries.removeAll { $0.id == entryId }; save() }

    /// Importa a lista de largada de um CSV `ordem;competidor;cavalo;categoria` (separador ";" ou ",",
    /// cabeçalho opcional). Devolve quantas inscrições entraram. Linhas inválidas são ignoradas — a
    /// planilha vem de terceiros e não pode derrubar o app na hora da prova.
    @discardableResult
    func importEntries(into eventId: UUID, csv: String) -> Int {
        var added = 0
        var nextOrder = (entries(of: eventId).map(\.order).max() ?? 0) + 1
        for raw in csv.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\u{FEFF}", with: "")
            if line.isEmpty { continue }
            let sep: Character = line.filter { $0 == ";" }.count >= line.filter { $0 == "," }.count ? ";" : ","
            let cols = Self.splitCsvLine(line, separator: sep)
            if cols.isEmpty { continue }
            let order = Int(cols[0])
            let rider = order != nil ? (cols.count > 1 ? cols[1] : "") : cols[0]
            if rider.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if order == nil, ["competidor", "nome", "ordem"].contains(rider.lowercased()) { continue }
            let horse = order != nil ? (cols.count > 2 ? cols[2] : "") : (cols.count > 1 ? cols[1] : "")
            let category = order != nil ? (cols.count > 3 ? cols[3] : "") : (cols.count > 2 ? cols[2] : "")
            entries.append(Entry(eventId: eventId, order: order ?? nextOrder, rider: rider,
                                 horse: horse, category: category))
            if let order { nextOrder = max(nextOrder, order + 1) } else { nextOrder += 1 }
            added += 1
        }
        if added > 0 { save() }
        return added
    }

    // MARK: - classificação
    /// Classificação da prova por categoria (regra do núcleo compartilhado).
    func ranking(of eventId: UUID, records: [RunRecord]) -> [EventScoring.Placing] {
        rankingRows(of: eventId, records: records).map(\.placing)
    }

    /// Classificação já pareada com a passada de cada colocação.
    ///
    /// O pareamento é feito DENTRO de cada categoria: a ordem de largada costuma ser numerada por
    /// categoria (o #1 da Amador e o #1 da Aberta existem os dois), então um mapa por `entryOrder`
    /// sobre a prova inteira mostraria o competidor errado. Tela e CSV usam esta mesma função.
    func rankingRows(of eventId: UUID, records: [RunRecord]) -> [RankingRow] {
        let mine = records.filter { $0.eventId == eventId }
        var cats: [String] = []
        for r in mine where !cats.contains(r.category ?? "") { cats.append(r.category ?? "") }
        var out: [RankingRow] = []
        for cat in cats.sorted(by: { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }) {
            let inCat = mine.filter { ($0.category ?? "") == cat }
            // dentro da categoria a ordem ainda pode repetir (duas passadas do mesmo número): a
            // colocação sai na mesma ordem do ranking, então consome-se a fila por posição
            var remaining: [Int: [RunRecord]] = [:]
            for r in inCat { remaining[r.entryOrder ?? 0, default: []].append(r) }
            for p in EventScoring.rank(inCat.map(\.scoringRun)) {
                guard var queue = remaining[p.entryOrder], !queue.isEmpty else { continue }
                let r = queue.removeFirst()
                remaining[p.entryOrder] = queue
                out.append(RankingRow(placing: p, run: r))
            }
        }
        return out
    }

    /// CSV da prova: colocação, competidor, tempos, penalidade — o que se imprime ou se manda no zap.
    func rankingCsv(of eventId: UUID, records: [RunRecord]) -> String {
        func dec(_ v: Double, _ places: Int) -> String {
            String(format: "%.\(places)f", v).replacingOccurrences(of: ".", with: ",")
        }
        func q(_ s: String) -> String { "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }
        var out = "categoria;colocacao;ordem;competidor;cavalo;tempo_final;tempo_bruto_s;tambores;penalidade_s;sem_tempo\n"
        for row in rankingRows(of: eventId, records: records) {
            let p = row.placing
            let r = row.run
            let e = entry(r.entryId)
            let cols = [
                q(r.category ?? ""), p.place.map(String.init) ?? "SAT", "\(p.entryOrder)",
                q(e?.rider ?? r.rider), q(e?.horse ?? r.horse),
                r.noTime ? "SAT" : TimeFormatter.formatElapsed(p.finalNs).replacingOccurrences(of: ".", with: ","),
                dec(Double(r.elapsedRawNs) / 1e9, 3), "\(r.barrelsKnocked)",
                "\(p.penaltyNs / 1_000_000_000)", r.noTime ? "sim" : "não",
            ]
            out += cols.joined(separator: ";") + "\n"
        }
        return out
    }

    // MARK: - persistência
    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        guard let p = try? dec.decode(Payload.self, from: data) else { return }
        events = p.events
        entries = p.entries
        currentEventId = p.events.contains { $0.id == p.currentEventId } ? p.currentEventId : nil
    }

    private func save() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        let payload = Payload(events: events, entries: entries, currentEventId: currentEventId)
        if let data = try? enc.encode(payload) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    /// Divide uma linha de CSV respeitando aspas duplas (planilhas exportam nomes com ponto e vírgula).
    private static func splitCsvLine(_ line: String, separator: Character) -> [String] {
        var out: [String] = []
        var cur = ""
        var quoted = false
        var it = line.makeIterator()
        var pending: Character? = nil
        while let c = pending ?? it.next() {
            pending = nil
            if quoted, c == "\"" {
                if let n = it.next() {
                    if n == "\"" { cur.append("\"") } else { quoted = false; pending = n }
                } else {
                    quoted = false
                }
            } else if c == "\"" {
                quoted = true
            } else if c == separator, !quoted {
                out.append(cur.trimmingCharacters(in: .whitespaces))
                cur = ""
            } else {
                cur.append(c)
            }
        }
        out.append(cur.trimmingCharacters(in: .whitespaces))
        return out
    }
}
