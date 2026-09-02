import AVFoundation
import SwiftUI
import UIKit

/// Preview da câmera direto na GPU (`AVCaptureVideoPreviewLayer`), sem passar pela CPU.
/// Também converte a ROI desenhada na tela para coordenadas normalizadas do buffer
/// (`metadataOutputRectConverted(fromLayerRect:)` já considera `videoGravity` e a rotação do preview).
struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    var lineXFraction: Double
    var bandTopFraction: Double
    var bandBottomFraction: Double
    var onROIMapped: (_ centerX: Double, _ top: Double, _ bottom: Double) -> Void

    func makeUIView(context: Context) -> PreviewUIView {
        let v = PreviewUIView()
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspect
        v.onROIMapped = onROIMapped
        return v
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {
        uiView.roi = (lineXFraction, bandTopFraction, bandBottomFraction)
        uiView.onROIMapped = onROIMapped
        uiView.setNeedsLayout()
    }

    final class PreviewUIView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        var roi: (Double, Double, Double) = (0.5, 0.25, 0.75) { didSet { if roi != oldValue { setNeedsLayout() } } }
        var onROIMapped: ((Double, Double, Double) -> Void)?
        private var lastMapped: (Double, Double, Double)?

        override func layoutSubviews() {
            super.layoutSubviews()
            applyOrientation()
            remapROI()
        }

        private func applyOrientation() {
            guard let conn = previewLayer.connection else { return }
            let orientation = window?.windowScene?.interfaceOrientation ?? .landscapeRight
            OrientationAdapter.applyPreviewOrientation(conn, interface: orientation)
        }

        /// Converte a linha/banda da tela para o retângulo normalizado da imagem NÃO rotacionada.
        private func remapROI() {
            guard previewLayer.connection != nil, bounds.width > 0, bounds.height > 0 else { return }
            let w = bounds.width, h = bounds.height
            let rect = CGRect(x: CGFloat(roi.0) * w - 0.5, y: CGFloat(roi.1) * h, width: 1, height: CGFloat(roi.2 - roi.1) * h)
            var m = previewLayer.metadataOutputRectConverted(fromLayerRect: rect)
            // Clampar a [0,1]: arrastar sobre as barras pretas (letterbox) devolve valores fora da faixa.
            m.origin.x = min(max(m.origin.x, 0), 1)
            m.origin.y = min(max(m.origin.y, 0), 1)
            m.size.width = min(max(m.size.width, 0), 1 - m.origin.x)
            m.size.height = min(max(m.size.height, 0), 1 - m.origin.y)
            let mapped = (Double(m.midX), Double(m.minY), Double(m.maxY))
            if let last = lastMapped, abs(last.0 - mapped.0) < 1e-6, abs(last.1 - mapped.1) < 1e-6, abs(last.2 - mapped.2) < 1e-6 { return }
            lastMapped = mapped
            onROIMapped?(mapped.0, mapped.1, mapped.2)
        }
    }
}
