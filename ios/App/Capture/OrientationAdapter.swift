import AVFoundation
import UIKit

/// Encapsula a diferença de API entre iOS 16 (`videoOrientation`) e iOS 17+ (`videoRotationAngle`).
///
/// Importante: a conexão do `AVCaptureVideoDataOutput` NUNCA é rotacionada — o buffer fica na
/// orientação nativa do sensor (paisagem, `landscapeRight`), o que evita rotacionar 240 quadros por
/// segundo e mantém o mapeamento da ROI trivial. Só a conexão do preview é ajustada.
enum OrientationAdapter {
    /// Aplica à conexão do preview a rotação correspondente à orientação da interface.
    static func applyPreviewOrientation(_ connection: AVCaptureConnection, interface: UIInterfaceOrientation) {
        if #available(iOS 17.0, *) {
            let angle: CGFloat = (interface == .landscapeLeft) ? 180 : 0
            if connection.isVideoRotationAngleSupported(angle) {
                connection.videoRotationAngle = angle
            }
        } else {
            let orientation: AVCaptureVideoOrientation = (interface == .landscapeLeft) ? .landscapeLeft : .landscapeRight
            if connection.isVideoOrientationSupported {
                connection.videoOrientation = orientation
            }
        }
    }

    /// Garante que a conexão de dados fique na orientação nativa (sem rotação).
    static func ensureNativeOrientation(_ connection: AVCaptureConnection) {
        if #available(iOS 17.0, *) {
            if connection.isVideoRotationAngleSupported(0) { connection.videoRotationAngle = 0 }
        } else {
            if connection.isVideoOrientationSupported { connection.videoOrientation = .landscapeRight }
        }
    }
}
