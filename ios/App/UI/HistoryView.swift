import PhotocellCore
import SwiftUI

/// Histórico de passadas com exportação CSV (share sheet). Só números — nenhum vídeo é gravado.
struct HistoryView: View {
    @ObservedObject var store: RunHistoryStore
    @Environment(\.dismiss) private var dismiss
    @State private var csvURL: URL? = nil

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.records) { r in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(r.finalText).font(.title3.monospacedDigit().bold())
                            if r.degraded { Image(systemName: "exclamationmark.triangle").foregroundColor(.orange) }
                            Spacer()
                            Text(r.date, format: .dateTime.day().month().hour().minute()).font(.caption).foregroundColor(.secondary)
                        }
                        Text([r.rider, r.horse].filter { !$0.isEmpty }.joined(separator: " · ")).font(.subheadline)
                        Text("bruto \(TimeFormatter.formatElapsed(r.elapsedRawNs)) · refinado \(TimeFormatter.formatElapsed(r.elapsedRefinedNs)) · tambores \(r.barrelsKnocked) · q\(r.startQuality)/\(r.finishQuality) · drops \(r.drops)")
                            .font(.caption2.monospacedDigit()).foregroundColor(.secondary)
                    }
                }
                .onDelete { store.delete(at: $0) }
            }
            .navigationTitle("Histórico (\(store.records.count))")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fechar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    if let url = csvURL {
                        ShareLink(item: url) { Label("CSV", systemImage: "square.and.arrow.up") }
                    } else {
                        Button { csvURL = try? CSVExporter.writeTemporaryFile(store.records) } label: { Label("Gerar CSV", systemImage: "doc.text") }
                            .disabled(store.records.isEmpty)
                    }
                }
            }
        }
    }
}
