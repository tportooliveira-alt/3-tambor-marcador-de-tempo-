import Combine
import Foundation

/// Histórico de passadas em JSON dentro de Application Support (sem vídeo, só números).
@MainActor
final class RunHistoryStore: ObservableObject {
    @Published private(set) var records: [RunRecord] = []

    private let fileURL: URL

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FotocelulaTambor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("historico.json")
        load()
    }

    func add(_ r: RunRecord) {
        records.insert(r, at: 0)
        save()
    }

    func update(_ r: RunRecord) {
        if let i = records.firstIndex(where: { $0.id == r.id }) {
            records[i] = r
            save()
        }
    }

    func delete(at offsets: IndexSet) {
        records.remove(atOffsets: offsets)
        save()
    }

    func clear() {
        records.removeAll()
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        records = (try? dec.decode([RunRecord].self, from: data)) ?? []
    }

    private func save() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(records) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}
