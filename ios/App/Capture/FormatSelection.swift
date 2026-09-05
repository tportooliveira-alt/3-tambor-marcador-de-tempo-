import AVFoundation
import CoreMedia

/// Descrição mínima de um formato de captura, extraída do `AVCaptureDevice.Format` para permitir
/// uma escolha determinística (função pura, testável sem hardware).
struct CaptureFormatCandidate: Equatable {
    var index: Int
    var width: Int32
    var height: Int32
    var pixelFormat: FourCharCode
    var maxFrameRate: Double
    var isBinned: Bool
    var minExposureNs: Int64
    var maxExposureNs: Int64
    var minISO: Float
    var maxISO: Float
}

enum FormatSelection {
    /// Regras (ver docs/estudo-tecnico.md §1.3):
    ///  1. subtipo NV12 video-range (`420v`) — o mesmo que a saída entrega, sem conversão no ISP;
    ///  2. alguma faixa com `maxFrameRate >= targetFps`;
    ///  3. menor área (720p240 típico; 1080p240 só gasta banda para uma faixa de poucos pixels);
    ///  4. binning é ignorado no filtro (720p240 costuma ser binned e isso é desejável), só logado.
    static func select(_ candidates: [CaptureFormatCandidate], targetFps: Double = 240) -> CaptureFormatCandidate? {
        let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        let eligible = candidates.filter { $0.pixelFormat == nv12 && $0.maxFrameRate >= targetFps }
        return eligible.min { a, b in
            let areaA = Int(a.width) * Int(a.height)
            let areaB = Int(b.width) * Int(b.height)
            if areaA != areaB { return areaA < areaB }
            return a.index < b.index
        }
    }

    /// Escada de taxas: 240 se existir, senão 120, senão 60 (nunca abaixo — o refinamento perde sentido).
    /// Devolve o formato e a taxa a usar; nil quando nem 60 FPS em 420v existe.
    static func selectWithFallback(_ candidates: [CaptureFormatCandidate]) -> (format: CaptureFormatCandidate, fps: Double)? {
        for target in [240.0, 120.0, 60.0] {
            if let f = select(candidates, targetFps: target) { return (f, target) }
        }
        return nil
    }

    /// Melhor taxa disponível quando 240 não existe (fallback: 120, depois 60), para o aviso de precisão.
    static func bestAvailableFps(_ candidates: [CaptureFormatCandidate]) -> Double {
        let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        return candidates.filter { $0.pixelFormat == nv12 }.map { $0.maxFrameRate }.max() ?? 0
    }

    static func candidates(from device: AVCaptureDevice) -> [CaptureFormatCandidate] {
        device.formats.enumerated().map { (i, f) in
            let dims = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let maxFps = f.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            return CaptureFormatCandidate(
                index: i,
                width: dims.width,
                height: dims.height,
                pixelFormat: CMFormatDescriptionGetMediaSubType(f.formatDescription),
                maxFrameRate: maxFps,
                isBinned: f.isVideoBinned,
                minExposureNs: CMTimeConvertScale(f.minExposureDuration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value,
                maxExposureNs: CMTimeConvertScale(f.maxExposureDuration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value,
                minISO: f.minISO,
                maxISO: f.maxISO
            )
        }
    }
}
