import AVFoundation
import Combine
import Foundation
import PhotocellCore
import SwiftUI

/// Estado da interface (main actor). Liga câmera, sessão da fotocélula, display link, feedback e histórico.
@MainActor
final class PhotocellViewModel: ObservableObject {
    enum Permission { case unknown, granted, denied }

    @Published var permission: Permission = .unknown
    @Published var snapshot = PhotocellSnapshot()
    @Published var diagnostics = SessionDiagnostics()
    @Published var captureInfo = ActiveCaptureInfo()
    @Published var systemPressure: AVCaptureDevice.SystemPressureState.Level = .nominal
    @Published var thermalState: ProcessInfo.ThermalState = ProcessInfo.processInfo.thermalState
    /// Modo Pouca Energia corta até 40 % da CPU e trava o display em 60 Hz: bloqueia Armar.
    @Published var lowPowerMode: Bool = ProcessInfo.processInfo.isLowPowerModeEnabled
    @Published var errorMessage: String? = nil
    @Published var infoMessage: String? = nil
    @Published var settings: AppSettings = AppSettings.load() {
        didSet {
            // janelas coerentes (retomada ≥ bloqueio + 0,5 s; chegada ≥ retomada + 0,5 s): sem isso a FSM
            // nunca religaria os quadros e a prova travaria
            let fixed = settings.clamped()
            if fixed != settings { settings = fixed; return }
            settings.save()
            applySettings()
        }
    }
    @Published var flashVisible = false
    @Published var pendingResult: RunRecord? = nil
    @Published var isCalibratingCamera = false

    let camera = CameraManager()
    let history = RunHistoryStore()
    let timerText = TimerTextModel()
    private(set) var session: PhotocellSession!
    private var displayLink: DisplayLinkDriver!
    private let feedback = TriggerFeedback()
    private var cancellables: Set<AnyCancellable> = []
    /// Última ROI mapeada pelo preview (para reenviar quando a largura da faixa muda nos ajustes).
    private var lastROI: (centerX: Double, top: Double, bottom: Double)? = nil
    /// Estado da FSM na última publicação (para detectar o fim da calibração).
    private var lastState: PhotocellState = .idle

    init() {
        session = PhotocellSession(camera: camera, config: settings.makeConfig())
        camera.suspendStrategy = settings.suspendStrategy
        camera.desiredExposureNs = settings.exposureNs
        session.onSnapshot = { [weak self] s in self?.handleSnapshot(s) }
        session.onDiagnostics = { [weak self] d in self?.diagnostics = d }
        session.onFeedback = { [weak self] k in self?.handleFeedback(k) }
        session.onRunFinished = { [weak self] r in self?.handleFinished(r) }
        camera.onInterruption = { [weak self] began in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if began {
                    self.session.captureInterrupted()
                    self.infoMessage = "Captura interrompida pelo sistema. Toque em Reset e calibre novamente."
                } else {
                    self.infoMessage = "Captura retomada. Recalibre antes de armar."
                }
            }
        }
        camera.onRuntimeError = { [weak self] err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.session.captureInterrupted()
                let ns = err as NSError
                if ns.domain == AVFoundationErrorDomain && ns.code == AVError.Code.mediaServicesWereReset.rawValue {
                    // os serviços de mídia foram reiniciados: a sessão precisa ser reconstruída
                    self.errorMessage = "Serviços de câmera reiniciados pelo sistema. Reconfigurando..."
                    self.configured = false
                    self.startCamera()
                } else {
                    self.errorMessage = "Erro da câmera: \(err.localizedDescription)"
                }
            }
        }
        camera.$activeInfo.receive(on: DispatchQueue.main).sink { [weak self] info in
            guard let self = self else { return }
            let exposureChanged = info.exposureNs != self.captureInfo.exposureNs
            self.captureInfo = info
            // a exposição REAL aplicada alimenta o estimador (E): reenvia a configuração quando muda
            if exposureChanged && info.locked { self.applySettings() }
        }.store(in: &cancellables)
        camera.$systemPressure.receive(on: DispatchQueue.main).assign(to: &$systemPressure)
        NotificationCenter.default.publisher(for: ProcessInfo.thermalStateDidChangeNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.thermalState = ProcessInfo.processInfo.thermalState }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled }
            .store(in: &cancellables)
        displayLink = DisplayLinkDriver(clock: { [camera] in SessionClock(session: camera.session) },
                                        snapshot: { [session] in session!.snapshot },
                                        onTick: { [weak self] ns in self?.timerText.update(elapsedNs: ns) })
    }

    private var configured = false

    // MARK: - Ciclo de vida
    func startCamera() {
        if configured {
            camera.start()
            UIApplication.shared.isIdleTimerDisabled = true
            return
        }
        camera.requestAccess { [weak self] ok in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.permission = ok ? .granted : .denied
                guard ok else { return }
                UIApplication.shared.isIdleTimerDisabled = true
                self.camera.configure(delegate: self.session) { err in
                    DispatchQueue.main.async {
                        if let err = err {
                            self.errorMessage = err.localizedDescription
                        } else {
                            self.configured = true
                            self.camera.start()
                            self.session.refreshClock()
                            self.applySettings()
                        }
                    }
                }
            }
        }
    }

    func stopCamera() {
        displayLink.stop()
        camera.stop()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func applySettings() {
        camera.suspendStrategy = settings.suspendStrategy
        if camera.desiredExposureNs != settings.exposureNs { camera.desiredExposureNs = settings.exposureNs }
        let applied = captureInfo.locked ? captureInfo.exposureNs : 0
        session.updateConfig(settings.makeConfig(appliedExposureNs: applied))
        // a largura da faixa faz parte da ROI: reenviar a última ROI mapeada
        if let r = lastROI {
            session.updateROI(NormalizedROI(centerX: r.centerX, top: r.top, bottom: r.bottom, widthPx: settings.stripWidthPx))
        }
    }

    /// Chamado pelo preview quando a ROI é mapeada para coordenadas do buffer.
    func roiMapped(centerX: Double, top: Double, bottom: Double) {
        lastROI = (centerX, top, bottom)
        session.updateROI(NormalizedROI(centerX: centerX, top: top, bottom: bottom, widthPx: settings.stripWidthPx))
    }

    // MARK: - Ações
    var canCalibrate: Bool { snapshot.state == .idle || snapshot.state == .finished || snapshot.state == .error }
    var canArm: Bool { (snapshot.state == .idle || snapshot.state == .finished) && captureInfo.locked && frameRateOk }
    var thermalBlocked: Bool { systemPressure == .critical || systemPressure == .shutdown || thermalState == .critical }
    /// A taxa medida (ΔPTS) desde a última calibração precisa ter se mantido em 240 FPS: a exposição
    /// travada não pode ter alongado o quadro. Exige uma medição válida (janela de 1 s fechada).
    var frameRateOk: Bool { diagnostics.fpsMeasurementValid && diagnostics.measuredFps >= captureInfo.fps - 2.5 }
    /// Motivo (em pt-BR) pelo qual não é seguro armar agora; nil quando está tudo certo.
    var armBlockReason: String? {
        if lowPowerMode { return "Modo Pouca Energia ligado: desligue em Ajustes > Bateria antes de armar." }
        if thermalBlocked { return "Aparelho quente demais para armar com segurança. Aguarde esfriar." }
        if !captureInfo.locked { return "Calibre primeiro (exposição, foco e branco precisam estar travados)." }
        if !diagnostics.fpsMeasurementValid { return "Taxa de quadros ainda não medida: calibre primeiro." }
        if !frameRateOk { return String(format: "A câmera está entregando %.1f FPS, não %.0f. Reduza a exposição (Ajustes) e calibre de novo.", diagnostics.measuredFps, captureInfo.fps) }
        return nil
    }

    /// Calibrar = convergir e travar AE/AF/WB no centro da ROI + calibração de ruído (que também mede a taxa).
    func calibrate() {
        guard canCalibrate else { return }
        isCalibratingCamera = true
        errorMessage = nil
        let poi = CGPoint(x: settings.lineXFraction, y: 0.5)
        camera.convergeAndLock(pointOfInterest: poi) { [weak self] err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isCalibratingCamera = false
                if let err = err {
                    self.errorMessage = err.localizedDescription
                }
                // exposição real -> E do estimador, ANTES de calibrar o ruído
                self.applySettings()
                self.session.calibrate()
            }
        }
    }

    func arm() {
        guard canArm else { return }
        if let reason = armBlockReason {
            errorMessage = reason
            return
        }
        errorMessage = nil
        pendingResult = nil
        session.arm()
    }

    func reset() {
        session.reset()
        pendingResult = nil
    }

    // MARK: - Eventos da sessão
    private func handleSnapshot(_ s: PhotocellSnapshot) {
        snapshot = s
        switch s.state {
        case .debounceStart, .running, .awaitingFinish, .confirmingFinish, .debounceFinish, .finished:
            displayLink.start()
        default:
            displayLink.stop()
            timerText.update(elapsedNs: nil)
        }
        if s.state == .error, let reason = s.errorReason {
            errorMessage = Self.describe(reason)
        }
        // fim da calibração de ruído: a taxa medida durante ela decide se é seguro armar
        if lastState == .calibrating && (s.state == .idle || s.state == .armed) {
            if diagnostics.fpsMeasurementValid && !frameRateOk {
                errorMessage = String(format: "A câmera manteve %.1f FPS com esta exposição, não %.0f. Reduza a exposição em Ajustes e calibre de novo.", diagnostics.measuredFps, captureInfo.fps)
            }
        }
        lastState = s.state
    }

    private func handleFeedback(_ kind: Effect.FeedbackKind) {
        if settings.feedbackSound { feedback.play(kind) }
        if settings.feedbackFlash {
            flashVisible = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { self.flashVisible = false }
        }
    }

    private func handleFinished(_ r: RunResult) {
        guard pendingResult == nil else { return }
        let rec = RunRecord(result: r, capture: captureInfo, lag: snapshot.lag)
        pendingResult = rec
        history.add(rec)
    }

    func savePendingResult() {
        if let r = pendingResult { history.update(r) }
    }

    private static func describe(_ reason: String) -> String {
        switch reason {
        case "captureInterrupted": return "Captura interrompida. Toque em Reset e calibre de novo."
        case "calibrationUnstable": return "Calibração instável: algo se moveu na faixa. Verifique o tripé e tente de novo."
        default: return "Erro: \(reason)"
        }
    }
}
