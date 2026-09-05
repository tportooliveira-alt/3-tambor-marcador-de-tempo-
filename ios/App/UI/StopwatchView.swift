import SwiftUI

/// Mostrador do cronômetro (dígitos monoespaçados, atualizado pelo display link).
struct StopwatchView: View {
    @ObservedObject var model: TimerTextModel
    var body: some View {
        Text(model.text)
            .font(.system(size: 52, weight: .bold, design: .rounded).monospacedDigit())
            .foregroundColor(.white)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
    }
}
