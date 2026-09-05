import Combine
import Foundation
import PhotocellCore

/// Modelo minúsculo observado apenas pelo texto do cronômetro (atualizado a 120 Hz pelo display link),
/// isolado do resto da tela para não forçar re-render de toda a interface a cada quadro.
@MainActor
final class TimerTextModel: ObservableObject {
    @Published var text: String = "0:00.000"

    func update(elapsedNs: Nanos?) {
        let t = TimeFormatter.formatClock(elapsedNs ?? 0)
        if t != text { text = t }
    }
}
