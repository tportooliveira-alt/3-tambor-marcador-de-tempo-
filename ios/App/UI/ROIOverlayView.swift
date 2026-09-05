import SwiftUI

/// Linha virtual da fotocélula: arrastável em X (linha) e em Y (alças da banda). Travada fora de IDLE.
struct ROIOverlayView: View {
    @Binding var lineX: Double
    @Binding var bandTop: Double
    @Binding var bandBottom: Double
    var stripWidthPx: Int
    var mmPerPx: Double?
    var locked: Bool

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let x = CGFloat(lineX) * w
            let top = CGFloat(bandTop) * h
            let bottom = CGFloat(bandBottom) * h
            ZStack(alignment: .topLeading) {
                // linha completa (referência visual para alinhar com a estaca do outro lado da pista)
                Path { p in p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: h)) }
                    .stroke(Color.yellow.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [6, 6]))
                // banda ativa
                Rectangle()
                    .fill(locked ? Color.red.opacity(0.35) : Color.green.opacity(0.35))
                    .frame(width: 6, height: max(0, bottom - top))
                    .position(x: x, y: (top + bottom) / 2)
                Rectangle()
                    .stroke(locked ? Color.red : Color.green, lineWidth: 1.5)
                    .frame(width: 22, height: max(0, bottom - top))
                    .position(x: x, y: (top + bottom) / 2)
                    .gesture(dragLine(width: w), including: locked ? .none : .all)
                handle(y: top, x: x, h: h, isTop: true)
                handle(y: bottom, x: x, h: h, isTop: false)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Faixa: \(stripWidthPx) px")
                    if let mm = mmPerPx { Text(String(format: "≈ %.0f mm/px", mm)) }
                }
                .font(.caption2.monospacedDigit())
                .foregroundColor(.white)
                .padding(4)
                .background(Color.black.opacity(0.5))
                .cornerRadius(4)
                .position(x: min(max(x + 60, 50), w - 50), y: max(top - 14, 12))
            }
        }
        .allowsHitTesting(!locked)
    }

    private func dragLine(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1).onChanged { v in
            lineX = min(max(Double(v.location.x / width), 0.02), 0.98)
        }
    }

    private func handle(y: CGFloat, x: CGFloat, h: CGFloat, isTop: Bool) -> some View {
        Circle()
            .fill(locked ? Color.red : Color.green)
            .frame(width: 18, height: 18)
            .position(x: x, y: y)
            .gesture(DragGesture(minimumDistance: 1).onChanged { v in
                let f = min(max(Double(v.location.y / h), 0.0), 1.0)
                if isTop { bandTop = min(f, bandBottom - 0.03) } else { bandBottom = max(f, bandTop + 0.03) }
            }, including: locked ? .none : .all)
    }
}
