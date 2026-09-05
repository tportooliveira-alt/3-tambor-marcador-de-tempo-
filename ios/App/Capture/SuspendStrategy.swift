import Foundation

/// Como suspender a recepção de quadros durante RUNNING (economia térmica).
enum SuspendStrategy: String, CaseIterable, Codable, Identifiable {
    /// `AVCaptureConnection.isEnabled = false` na saída de dados: a sessão e o preview continuam,
    /// o delegate para de receber quadros e o ISP para de escrever buffers para nós.
    case disableConnection
    /// O delegate continua recebendo quadros e os descarta imediatamente (mais previsível na retomada,
    /// porém sem a economia de banda de memória).
    case softGate

    var id: String { rawValue }

    var label: String {
        switch self {
        case .disableConnection: return "Desligar conexão (padrão)"
        case .softGate: return "Descartar quadros"
        }
    }
}
