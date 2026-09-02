import PhotocellCore
import SwiftUI

/// Resultado da passada: tempo refinado (sub-quadro) e bruto (por quadro), penalidades e "sem tempo".
struct ResultView: View {
    @ObservedObject var vm: PhotocellViewModel
    @Binding var record: RunRecord
    /// Abre a lista de inscrições para trocar o competidor desta passada.
    var onAssign: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // quem correu vem antes do número: é o que o operador confere antes de salvar
            if vm.events.currentEventId != nil {
                HStack {
                    Text(record.entryId != nil
                         ? "#\(record.entryOrder ?? 0) \(record.rider)"
                            + (record.horse.isEmpty ? "" : " / \(record.horse)")
                            + ((record.category ?? "").isEmpty ? "" : " — \(record.category ?? "")")
                         : "Sem competidor")
                        .font(.headline)
                        .foregroundColor(record.entryId != nil ? .green : .secondary)
                    Spacer()
                    Button("Trocar", action: onAssign).buttonStyle(.bordered)
                }
            }
            HStack {
                Text("Tempo final").font(.headline)
                Spacer()
                if record.degraded { Label("degradada (drops perto do gatilho)", systemImage: "exclamationmark.triangle").font(.caption).foregroundColor(.orange) }
            }
            Text(record.finalText)
                .font(.system(size: 56, weight: .black, design: .rounded).monospacedDigit())
                .foregroundColor(record.noTime ? .red : .green)
            Group {
                Text("Refinado (sub-quadro): \(TimeFormatter.formatElapsed(record.elapsedRefinedNs)) s  ·  bruto (por quadro): \(TimeFormatter.formatElapsed(record.elapsedRawNs)) s")
                Text(String(format: "Qualidade largada %d (±%.2f ms) · chegada %d (±%.2f ms)", record.startQuality,
                            Double(record.startUncertaintyNs) / 1e6, record.finishQuality, Double(record.finishUncertaintyNs) / 1e6))
                Text("Qualidade 2 = refinamento completo; 1 = só limites (janela cega); 0 = tempo do quadro (±2 ms).")
            }
            .font(.caption.monospacedDigit())
            .foregroundColor(.secondary)
            HStack(spacing: 12) {
                TextField("Competidor", text: $record.rider).textFieldStyle(.roundedBorder)
                TextField("Cavalo", text: $record.horse).textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 12) {
                Stepper("Tambores derrubados: \(record.barrelsKnocked) (+\(record.barrelsKnocked * 5) s)", value: $record.barrelsKnocked, in: 0...3)
                Toggle("Sem tempo (SAT)", isOn: $record.noTime).toggleStyle(.switch)
            }
            .font(.subheadline)
            HStack {
                Button { vm.savePendingResult() } label: { Label("Salvar no histórico", systemImage: "tray.and.arrow.down") }
                    .buttonStyle(.borderedProminent)
                Button { vm.savePendingResult(); vm.reset() } label: {
                    Label(record.entryId != nil ? "Salvar para #\(record.entryOrder ?? 0)" : "Salvar e Reset",
                          systemImage: "arrow.counterclockwise")
                }
                    .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .background(.ultraThinMaterial)
        .cornerRadius(14)
        .onChange(of: record) { _ in vm.savePendingResult() }
    }
}
