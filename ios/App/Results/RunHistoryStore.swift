import Combine
import Foundation

/// Histórico de passadas em JSON dentro de Application Support (sem vídeo, só números).
@MainActor
final class RunHistoryStore: ObservableObject {
    @Published private(set) var records: [RunRecord] = []

    private let fileURL: URL
    /// Escritas em disco fora da main thread, em ordem (o mesmo que o Android faz com um executor).
    private let io = DispatchQueue(label: "historico-io", qos: .utility)

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
        guard let lidos = try? dec.decode([RunRecord].self, from: data) else {
            // arquivo ilegível (gravação interrompida, disco cheio): guardar em vez de continuar
            // vazio — sem isso o próximo save() gravaria "[]" por cima do histórico da prova
            try? FileManager.default.moveItem(at: fileURL, to: fileURL.appendingPathExtension("corrompido"))
            return
        }
        records = lidos
    }

    private func save() {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(records) else { return }
        let url = fileURL
        io.async { try? data.write(to: url, options: .atomic) }
    }
}
