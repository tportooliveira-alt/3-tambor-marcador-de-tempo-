import PhotocellCore
import SwiftUI
import UniformTypeIdentifiers

/// Prova: criar/escolher evento, lista de largada (digitada ou importada por CSV), classificação por
/// categoria e a pasta de backup. Tudo local — o app não fala com servidor nenhum.
struct EventView: View {
    @ObservedObject var vm: PhotocellViewModel
    @ObservedObject var events: EventStore
    @ObservedObject var history: RunHistoryStore
    @Environment(\.dismiss) private var dismiss

    @State private var newName = ""
    @State private var newPlace = ""
    @State private var importingCSV = false
    @State private var choosingFolder = false
    @State private var rankingURL: URL? = nil

    var body: some View {
        NavigationStack {
            List {
                eventsSection
                if let ev = events.currentEvent {
                    entriesSection(ev)
                    rankingSection(ev)
                }
                backupSection
            }
            .navigationTitle(events.currentEvent.map { "Prova: \($0.name)" } ?? "Prova")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } } }
            .fileImporter(isPresented: $importingCSV,
                          allowedContentTypes: [.commaSeparatedText, .plainText, .text],
                          allowsMultipleSelection: false) { result in
                handleImport(result)
            }
            .fileImporter(isPresented: $choosingFolder, allowedContentTypes: [.folder]) { result in
                if case .success(let url) = result { vm.setBackupFolder(url) }
            }
        }
    }

    // MARK: - provas
    private var eventsSection: some View {
        Section("Provas") {
            HStack {
                TextField("Nome", text: $newName).textFieldStyle(.roundedBorder)
                TextField("Local", text: $newPlace).textFieldStyle(.roundedBorder)
                Button("Criar") {
                    events.add(Event(name: newName.isEmpty ? "Prova" : newName, place: newPlace))
                    newName = ""; newPlace = ""
                }
                .buttonStyle(.borderedProminent)
                .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            ForEach(events.events) { e in
                HStack {
                    Image(systemName: e.id == events.currentEventId ? "largecircle.fill.circle" : "circle")
                    VStack(alignment: .leading) {
                        Text(e.name)
                        Text([e.place, e.date.formatted(date: .abbreviated, time: .shortened)]
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundColor(.secondary)
                    }
                    Spacer()
                    Button("Abrir") { events.select(e.id) }.buttonStyle(.bordered)
                    Button(role: .destructive) { events.remove(eventId: e.id) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                }
            }
            if events.currentEventId != nil {
                Button("Fechar a prova (voltar ao cronômetro avulso)") { events.select(nil) }
            }
        }
    }

    // MARK: - inscrições
    @State private var order = ""
    @State private var rider = ""
    @State private var horse = ""
    @State private var category = ""

    private func entriesSection(_ ev: Event) -> some View {
        Section("Inscrições (\(events.entries(of: ev.id).count))") {
            HStack {
                TextField("Nº", text: $order).frame(width: 54).textFieldStyle(.roundedBorder)
                TextField("Competidor", text: $rider).textFieldStyle(.roundedBorder)
                TextField("Cavalo", text: $horse).textFieldStyle(.roundedBorder)
                TextField("Cat.", text: $category).frame(width: 80).textFieldStyle(.roundedBorder)
                Button {
                    let n = Int(order) ?? ((events.entries(of: ev.id).map(\.order).max() ?? 0) + 1)
                    events.add(Entry(eventId: ev.id, order: n, rider: rider, horse: horse, category: category))
                    order = ""; rider = ""; horse = ""
                } label: { Image(systemName: "plus.circle.fill") }
                .disabled(rider.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            Button { importingCSV = true } label: {
                Label("Importar CSV (ordem;competidor;cavalo;categoria)", systemImage: "square.and.arrow.down")
            }
            ForEach(events.entries(of: ev.id)) { e in
                HStack {
                    Image(systemName: history.records.contains { $0.entryId == e.id } ? "checkmark.circle.fill" : "circle")
                        .foregroundColor(history.records.contains { $0.entryId == e.id } ? .green : .secondary)
                    Text(e.label)
                    Spacer()
                    Button(role: .destructive) { events.remove(entryId: e.id) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    // MARK: - classificação
    private func rankingSection(_ ev: Event) -> some View {
        let placings = events.ranking(of: ev.id, records: history.records)
        let byOrder = Dictionary(history.records.filter { $0.eventId == ev.id }
            .map { ($0.entryOrder ?? 0, $0) }, uniquingKeysWith: { a, _ in a })
        return Section("Classificação") {
            if placings.isEmpty {
                Text("Nenhuma passada salva nesta prova ainda.").foregroundColor(.secondary)
            }
            // índice como identidade: a mesma ordem de largada pode aparecer em categorias diferentes
            ForEach(Array(placings.enumerated()), id: \.offset) { _, p in
                let r = byOrder[p.entryOrder]
                HStack {
                    Text(p.place.map { "\($0)º" } ?? "SAT")
                        .font(.title3.bold()).frame(width: 52, alignment: .leading)
                        .foregroundColor(p.place == nil ? .red : .primary)
                    VStack(alignment: .leading) {
                        Text("#\(p.entryOrder) " + (r?.rider ?? "") + ((r?.horse).map { $0.isEmpty ? "" : " / \($0)" } ?? ""))
                        Text([(r?.category ?? "").isEmpty ? nil : r?.category,
                              "bruto \(TimeFormatter.formatElapsed(r?.elapsedRawNs ?? 0))",
                              p.penaltyNs > 0 ? "+\(p.penaltyNs / 1_000_000_000)s" : nil]
                            .compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundColor(.secondary)
                    }
                    Spacer()
                    Text(p.place == nil ? "—" : TimeFormatter.formatElapsed(p.finalNs))
                        .font(.title3.monospacedDigit().bold())
                }
            }
            if !placings.isEmpty {
                if let url = rankingURL {
                    ShareLink(item: url) { Label("Compartilhar classificação", systemImage: "square.and.arrow.up") }
                } else {
                    Button {
                        let csv = events.rankingCsv(of: ev.id, records: history.records)
                        let url = FileManager.default.temporaryDirectory
                            .appendingPathComponent(HistoryBackup.eventFileName(ev.name))
                        rankingURL = (try? csv.data(using: .utf8)!.write(to: url, options: .atomic)) == nil ? nil : url
                    } label: { Label("Gerar CSV da prova", systemImage: "doc.text") }
                }
            }
        }
    }

    // MARK: - backup
    private var backupSection: some View {
        Section("Backup do histórico") {
            Text("Escolha uma pasta (iCloud Drive, Arquivos). A cada passada salva o app reescreve ali "
                 + "fotocelula-historico.csv e, com uma prova aberta, a classificação. Se o aparelho sumir, "
                 + "a planilha sobrevive.")
                .font(.caption).foregroundColor(.secondary)
            if let err = vm.backupError { Text(err).font(.caption).foregroundColor(.red) }
            HStack {
                Button(vm.settings.backupBookmark == nil ? "Escolher pasta" : "Trocar pasta") { choosingFolder = true }
                    .buttonStyle(.borderedProminent)
                if vm.settings.backupBookmark != nil {
                    Button("Copiar agora") { vm.writeBackup() }.buttonStyle(.bordered)
                    Button("Desligar") { vm.clearBackupFolder() }.buttonStyle(.bordered)
                }
            }
        }
    }

    private func handleImport(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first, let ev = events.currentEventId else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else {
            vm.errorMessage = "Não consegui ler o arquivo escolhido."
            return
        }
        let n = events.importEntries(into: ev, csv: text)
        if n == 0 {
            vm.errorMessage = "Nenhuma inscrição reconhecida (esperado: ordem;competidor;cavalo;categoria)."
        } else {
            vm.infoMessage = "\(n) inscrições importadas."
        }
    }
}

/// Escolher outra inscrição para a passada em aberto (quando a ordem de largada muda na hora).
struct AssignEntryView: View {
    @ObservedObject var vm: PhotocellViewModel
    @ObservedObject var events: EventStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button("Sem competidor") { vm.assignPending(to: nil); dismiss() }
                if let ev = events.currentEventId {
                    ForEach(events.entries(of: ev)) { e in
                        Button { vm.assignPending(to: e); dismiss() } label: {
                            HStack {
                                Text(e.label)
                                Spacer()
                                if vm.history.records.contains(where: { $0.entryId == e.id && $0.id != vm.pendingResult?.id }) {
                                    Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Atribuir a passada")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } } }
        }
    }
}

/// Faixa "Próximo: #12 João / Estrela" — o operador lê de longe, com luva, no sol.
struct NextEntryBanner: View {
    @ObservedObject var vm: PhotocellViewModel
    @ObservedObject var events: EventStore
    @ObservedObject var history: RunHistoryStore

    var body: some View {
        if let e = vm.nextEntry {
            VStack(alignment: .leading, spacing: 0) {
                Text("PRÓXIMO").font(.caption2.bold()).foregroundColor(Color(red: 0.62, green: 0.83, blue: 0.69))
                Text(e.label).font(.title2.bold()).foregroundColor(.white).lineLimit(1)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Color(red: 0.08, green: 0.19, blue: 0.14).opacity(0.9))
            .cornerRadius(10)
        }
    }
}
