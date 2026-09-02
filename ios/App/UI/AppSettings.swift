import Foundation
import PhotocellCore

/// Opção de exposição do seletor (tipo nominal: key paths não funcionam em tuplas).
struct ExposureChoice: Identifiable, Hashable {
    let label: String
    let ns: Int64
    var id: Int64 { ns }
}

/// Configurações persistidas (UserDefaults). Os padrões seguem a especificação e as decisões do estudo.
struct AppSettings: Codable, Equatable {
    var stripWidthPx: Int = 15
    var coreWidth: Int = 3
    var lineXFraction: Double = 0.5          // posição da linha na tela (fração da largura do preview)
    var bandTopFraction: Double = 0.25       // banda de linhas (fração da altura do preview)
    var bandBottomFraction: Double = 0.75
    /// Exposição DESEJADA (ns); a aplicada pelo aparelho pode ser outra e é ela que vai para o estimador.
    var exposureNs: Int64 = 2_083_333        // 1/480 s
    var startLockoutMs: Int = 1500
    var frameResumeS: Double = 8.0
    var finishArmS: Double = 10.0
    var finishLockoutMs: Int = 2000
    var confirmRequired: Int = 2
    var confirmWindow: Int = 4
    var flickerAuto: Bool = true
    var suspendStrategy: SuspendStrategy = .disableConnection
    var skewNs: Int64? = nil
    var thresholdFloor: Double = 4.0
    /// Curva de tom do vídeo a desfazer no estimador (1,0 = desligado). Vídeo 420v padrão ≈ 2,2.
    var gamma: Double = 1.0
    var feedbackSound: Bool = true
    var feedbackFlash: Bool = true

    static let exposureChoices: [ExposureChoice] = [
        ExposureChoice(label: "1/240 s (sem janela cega, mais blur)", ns: 4_166_666),
        ExposureChoice(label: "1/480 s (padrão)", ns: 2_083_333),
        ExposureChoice(label: "1/1000 s", ns: 1_000_000),
        ExposureChoice(label: "1/2000 s (sol forte)", ns: 500_000),
        ExposureChoice(label: "1/4000 s", ns: 250_000),
    ]

    /// Janelas coerentes com `PhotocellConfig.validate()`: quadros voltam ≥ 0,5 s depois do bloqueio e a
    /// chegada arma ≥ 0,5 s depois de voltarem. Devolve a versão corrigida.
    func clamped() -> AppSettings {
        var s = self
        let lockoutS = Double(s.startLockoutMs) / 1000.0
        if s.frameResumeS < lockoutS + 0.5 { s.frameResumeS = lockoutS + 0.5 }
        if s.finishArmS < s.frameResumeS + 0.5 { s.finishArmS = s.frameResumeS + 0.5 }
        return s
    }

    /// `appliedExposureNs`: exposição real lida do aparelho após a trava (0 = ainda não travou → usa a desejada).
    /// [activeFps] é a taxa REAL do formato ativo (240, 120 ou 60): dela saem o período do quadro e
    /// o número de amostras da calibração (1 s). Nunca assumir 240.
    func makeConfig(appliedExposureNs: Int64 = 0, activeFps: Double = 240) -> PhotocellConfig {
        let s = clamped()
        var c = PhotocellConfig()
        let fps = activeFps >= 1 ? Int(activeFps.rounded()) : 240
        c.frameRateHz = fps
        c.calibrationSamples = fps
        c.startLockoutNs = Int64(s.startLockoutMs) * 1_000_000
        c.frameResumeNs = Int64(s.frameResumeS * 1e9)
        c.finishArmNs = Int64(s.finishArmS * 1e9)
        c.finishLockoutNs = Int64(s.finishLockoutMs) * 1_000_000
        c.confirmRequired = s.confirmRequired
        c.confirmWindow = s.confirmWindow
        c.flickerAuto = s.flickerAuto
        c.coreWidth = s.coreWidth
        c.exposureNs = appliedExposureNs > 0 ? appliedExposureNs : s.exposureNs
        c.skewNs = s.skewNs
        c.thresholdFloor = s.thresholdFloor
        c.gamma = s.gamma
        return c
    }

    private static let key = "fotocelula.settings.v1"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return s.clamped()
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
