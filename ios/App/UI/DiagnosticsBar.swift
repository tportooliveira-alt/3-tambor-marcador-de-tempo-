import AVFoundation
import PhotocellCore
import SwiftUI

/// Badges de estado, térmico e medições (ISO, exposição, FPS medido, ΔY/limiar, drops, precisão estimada).
struct DiagnosticsBar: View {
    @ObservedObject var vm: PhotocellViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                badge(vm.snapshot.state.label, color: stateColor)
                badge(thermalLabel, color: thermalColor)
                if vm.lowPowerMode { badge("Pouca Energia", color: .red) }
                if vm.snapshot.lag == 2 { badge("Flicker 120 Hz", color: .purple) }
            }
            Group {
                Text(String(format: "%dx%d · %.0f FPS (medido %.1f · jitter ΔPTS %.3f ms)", vm.captureInfo.width, vm.captureInfo.height,
                            vm.captureInfo.fps, vm.diagnostics.measuredFps, vm.diagnostics.ptsJitterMs))
                Text(vm.captureInfo.locked
                     ? String(format: "Exposição 1/%.0f s · ISO %.0f · travada", 1e9 / Double(max(vm.captureInfo.exposureNs, 1)), vm.captureInfo.iso)
                     : "Exposição/foco/branco: NÃO travados — toque em Calibrar")
                Text(String(format: "ΔY %.2f (núcleo %.2f) · limiar %@ · ruído %.2f",
                            vm.diagnostics.lastDeltaFull, vm.diagnostics.lastDeltaCore,
                            vm.snapshot.threshold.map { String(format: "%.2f", $0) } ?? "—", vm.snapshot.noiseMean))
                Text(String(format: "Drops %d · custo/quadro %.0f µs · %@", vm.snapshot.drops,
                            vm.diagnostics.lastFrameCostMicros, precisionLabel))
                // o iOS não expõe o tempo de leitura (skew): o offset por linha não é compensado e cancela
                // entre largada e chegada quando a mesma banda dispara (≤ 0,4 ms por 96 linhas)
                Text("Tempo por linha (rolling shutter): não compensado — cancela entre largada e chegada")
            }
            .font(.caption2.monospacedDigit())
            .foregroundColor(.white.opacity(0.9))
            deltaMeter
        }
    }

    private var deltaMeter: some View {
        GeometryReader { geo in
            let th = vm.snapshot.threshold ?? 4
            let scale = max(th * 3, 1)
            let frac = min(vm.diagnostics.lastDeltaCore / scale, 1)
            let thFrac = min(th / scale, 1)
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.15))
                RoundedRectangle(cornerRadius: 3).fill(frac > thFrac ? Color.red : Color.green)
                    .frame(width: geo.size.width * CGFloat(frac))
                Rectangle().fill(Color.yellow).frame(width: 2).offset(x: geo.size.width * CGFloat(thFrac))
            }
        }
        .frame(height: 8)
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text).font(.caption.bold()).padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.85)).foregroundColor(.white).cornerRadius(6)
    }

    private var stateColor: Color {
        switch vm.snapshot.state {
        case .idle: return .gray
        case .calibrating: return .blue
        case .armed, .awaitingFinish: return .green
        case .confirmingStart, .confirmingFinish: return .orange
        case .debounceStart, .running, .debounceFinish: return .red
        case .finished: return .teal
        case .error: return .black
        }
    }

    private var thermalLabel: String {
        switch vm.systemPressure {
        case .nominal: return vm.thermalState == .nominal ? "Térmico OK" : "Aquecendo"
        case .fair: return "Térmico: leve"
        case .serious: return "Térmico: sério"
        case .critical: return "Térmico: crítico"
        case .shutdown: return "Térmico: desligando"
        default: return "Térmico ?"
        }
    }

    private var thermalColor: Color {
        switch vm.systemPressure {
        case .nominal: return .green
        case .fair: return .yellow
        case .serious: return .orange
        default: return .red
        }
    }

    private var precisionLabel: String {
        if vm.captureInfo.fps >= 239 { return "precisão ≈ ±0,1 ms (refinado) / ±2 ms (bruto)" }
        return String(format: "precisão ≈ ±%.0f ms", 500.0 / max(vm.captureInfo.fps, 1))
    }
}
