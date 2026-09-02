import Foundation
import PhotocellCore

/// Configurações persistidas (UserDefaults). Os padrões seguem a especificação e as decisões do estudo.
struct AppSettings: Codable, Equatable {
    var stripWidthPx: Int = 15
    var coreWidth: Int = 3
    var lineXFraction: Double = 0.5          // posição da linha na tela (fração da largura do preview)
    var bandTopFraction: Double = 0.25       // banda de linhas (fração da altura do preview)
    var bandBottomFraction: Double = 0.75
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
    var feedbackSound: Bool = true
    var feedbackFlash: Bool = true

    static let exposureChoices: [(label: String, ns: Int64)] = [
        ("1/240 s (sem janela cega, mais blur)", 4_166_666),
        ("1/480 s (padrão)", 2_083_333),
        ("1/1000 s", 1_000_000),
        ("1/2000 s (sol forte)", 500_000),
        ("1/4000 s", 250_000),
    ]

    func makeConfig() -> PhotocellConfig {
        var c = PhotocellConfig()
        c.startLockoutNs = Int64(startLockoutMs) * 1_000_000
        c.frameResumeNs = Int64(frameResumeS * 1e9)
        c.finishArmNs = Int64(finishArmS * 1e9)
        c.finishLockoutNs = Int64(finishLockoutMs) * 1_000_000
        c.confirmRequired = confirmRequired
        c.confirmWindow = confirmWindow
        c.flickerAuto = flickerAuto
        c.coreWidth = coreWidth
        c.exposureNs = exposureNs
        c.skewNs = skewNs
        c.thresholdFloor = thresholdFloor
        return c
    }

    private static let key = "fotocelula.settings.v1"

    static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let s = try? JSONDecoder().decode(AppSettings.self, from: data) else { return AppSettings() }
        return s
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.key)
        }
    }
}
