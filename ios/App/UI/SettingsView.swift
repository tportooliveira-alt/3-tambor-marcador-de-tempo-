import SwiftUI

/// Ajustes: faixa, exposição, janelas de bloqueio, confirmação, flicker, estratégia de suspensão.
struct SettingsView: View {
    @ObservedObject var vm: PhotocellViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Faixa (fotocélula virtual)") {
                    Stepper("Largura da faixa: \(vm.settings.stripWidthPx) px", value: $vm.settings.stripWidthPx, in: 5...40)
                    Picker("Colunas centrais (gatilho)", selection: $vm.settings.coreWidth) {
                        Text("1").tag(1); Text("3").tag(3); Text("5").tag(5)
                    }
                    Text("A faixa toda serve para confirmar e refinar; o gatilho usa as colunas centrais, que definem o plano da fotocélula. Mova o tripé, não a linha: o plano só é perpendicular à pista no centro da imagem.")
                        .font(.caption).foregroundColor(.secondary)
                }
                Section("Exposição (travada na calibração)") {
                    Picker("Duração", selection: $vm.settings.exposureNs) {
                        ForEach(AppSettings.exposureChoices) { Text($0.label).tag($0.ns) }
                    }
                    Text("Mais curta = menos blur e menos ISO disponível. A 240 FPS o máximo físico é 1/240 s e alguns iPhones não aceitam menos que isso no formato de 240 FPS; o estimador usa sempre a exposição REAL aplicada (mostrada nos diagnósticos) e funciona em qualquer valor.")
                        .font(.caption).foregroundColor(.secondary)
                }
                Section("Máquina de estados") {
                    Stepper("Bloqueio na largada: \(vm.settings.startLockoutMs) ms", value: $vm.settings.startLockoutMs, in: 500...5000, step: 100)
                    Stepper(String(format: "Retomar quadros aos %.1f s", vm.settings.frameResumeS), value: $vm.settings.frameResumeS, in: 1...20, step: 0.5)
                    Stepper(String(format: "Armar chegada aos %.1f s", vm.settings.finishArmS), value: $vm.settings.finishArmS, in: 1...20, step: 0.5)
                    Stepper("Bloqueio na chegada: \(vm.settings.finishLockoutMs) ms", value: $vm.settings.finishLockoutMs, in: 500...5000, step: 100)
                    Stepper("Confirmação: \(vm.settings.confirmRequired) de \(vm.settings.confirmWindow) quadros", value: $vm.settings.confirmRequired, in: 1...4)
                    Stepper("Piso do limiar: \(String(format: "%.1f", vm.settings.thresholdFloor))", value: $vm.settings.thresholdFloor, in: 1...20, step: 0.5)
                }
                Section("Avançado") {
                    Toggle("Detectar flicker de 120 Hz (referência c−2)", isOn: $vm.settings.flickerAuto)
                    Picker("Suspensão em RUNNING", selection: $vm.settings.suspendStrategy) {
                        ForEach(SuspendStrategy.allCases) { Text($0.label).tag($0) }
                    }
                    Toggle("Bipe na largada/chegada", isOn: $vm.settings.feedbackSound)
                    Toggle("Flash na tela", isOn: $vm.settings.feedbackFlash)
                }
            }
            .navigationTitle("Ajustes")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("OK") { dismiss() } } }
        }
    }
}
