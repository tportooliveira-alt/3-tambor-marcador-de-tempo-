import Foundation

/// Erros de configuração da câmera apresentados ao usuário (em pt-BR).
enum CameraError: LocalizedError {
    case permissionDenied
    case noBackWideCamera
    case noHighFrameRateFormat
    case pixelFormatUnavailable
    case cannotAddInput
    case cannotAddOutput
    case configuration(String)
    case frameRateNotHeld(measuredFps: Double)

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Permissão de câmera negada. Libere em Ajustes > Privacidade > Câmera."
        case .noBackWideCamera:
            return "Câmera traseira grande-angular (1x) não encontrada."
        case .noHighFrameRateFormat:
            return "Este aparelho não oferece formato de 240 FPS em NV12 (420v)."
        case .pixelFormatUnavailable:
            return "A saída de vídeo não aceita o formato NV12 (420v)."
        case .cannotAddInput:
            return "Não foi possível adicionar a câmera à sessão."
        case .cannotAddOutput:
            return "Não foi possível adicionar a saída de vídeo à sessão."
        case .configuration(let msg):
            return "Falha de configuração da câmera: \(msg)"
        case .frameRateNotHeld(let fps):
            return String(format: "A câmera não manteve 240 FPS (medido %.1f FPS). Reduza a exposição ou troque de formato.", fps)
        }
    }
}
