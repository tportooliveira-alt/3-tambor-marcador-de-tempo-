import AVFoundation
import Combine
import CoreMedia
import os

/// Informações do formato ativo e das travas, para diagnóstico na interface.
struct ActiveCaptureInfo: Equatable {
    var width: Int = 0
    var height: Int = 0
    var fps: Double = 0
    var isBinned: Bool = false
    /// Exposição REALMENTE aplicada pelo aparelho após a trava (ns). É este valor que alimenta o
    /// estimador sub-quadro (E), nunca o desejado.
    var exposureNs: Int64 = 0
    var iso: Float = 0
    var locked: Bool = false
}

/// Gerencia o `AVCaptureSession`: permissão, câmera traseira 1x, formato 240 FPS em NV12, travas
/// de exposição/foco/balanço de branco, saída de dados e suspensão de quadros.
///
/// Toda configuração roda em `sessionQueue`; os quadros chegam em `processingQueue`
/// (serial, `.userInteractive`), onde vive o `PhotocellSession`. Estado lido de outras filas
/// (`suspendStrategy`, `desiredExposureNs`, dimensões do formato) fica atrás de `stateLock`.
final class CameraManager: NSObject {
    static let log = Logger(subsystem: "br.com.tportooliveira.fotocelulatambor", category: "camera")

    let session = AVCaptureSession()
    let sessionQueue = DispatchQueue(label: "br.com.tportooliveira.fotocelula.session")
    let processingQueue = DispatchQueue(label: "br.com.tportooliveira.fotocelula.processing",
                                        qos: .userInteractive, autoreleaseFrequency: .workItem)
    let videoOutput = AVCaptureVideoDataOutput()

    /// Só acessado na `sessionQueue`.
    private var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    /// O `AVCaptureVideoDataOutput` NÃO retém o delegate: mantemos referência forte aqui.
    private var frameDelegate: AVCaptureVideoDataOutputSampleBufferDelegate?
    private var kvo: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []

    private let stateLock = NSLock()
    private var _suspendStrategy: SuspendStrategy = .disableConnection
    private var _desiredExposureNs: Int64 = 2_083_333
    private var _formatDimensions: (width: Int, height: Int) = (0, 0)

    /// Estratégia de suspensão (lida no `setFrameDelivery`, fila de processamento).
    var suspendStrategy: SuspendStrategy {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _suspendStrategy }
        set { stateLock.lock(); _suspendStrategy = newValue; stateLock.unlock() }
    }
    /// Duração de exposição desejada (ns). O aparelho pode aplicar outra (limites do formato; a 240 FPS
    /// há relatos de mínimo em 1/240 s): o valor aplicado é o de `activeInfo.exposureNs`.
    var desiredExposureNs: Int64 {
        get { stateLock.lock(); defer { stateLock.unlock() }; return _desiredExposureNs }
        set {
            stateLock.lock(); _desiredExposureNs = newValue; stateLock.unlock()
            sessionQueue.async { self.applyDesiredExposure() }
        }
    }
    /// Dimensões do formato ativo (0×0 antes de configurar); seguro de qualquer fila.
    var formatDimensions: (width: Int, height: Int) {
        stateLock.lock(); defer { stateLock.unlock() }; return _formatDimensions
    }

    /// Usado pela estratégia `.softGate`; lido no delegate (thread de processamento).
    let softGateOpen = ManagedAtomicBool(true)

    @Published private(set) var activeInfo = ActiveCaptureInfo()
    @Published private(set) var systemPressure: AVCaptureDevice.SystemPressureState.Level = .nominal
    @Published private(set) var isRunning = false

    var onInterruption: ((Bool) -> Void)?
    var onRuntimeError: ((Error) -> Void)?

    override init() {
        super.init()
        observeSession()
    }

    // MARK: - Permissão
    func requestAccess(_ completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: completion(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { completion($0) }
        default: completion(false)
        }
    }

    // MARK: - Configuração
    /// Configura (ou reconfigura) a sessão na `sessionQueue` e chama `completion` com o erro, se houver.
    func configure(delegate: AVCaptureVideoDataOutputSampleBufferDelegate,
                   completion: @escaping (Error?) -> Void) {
        sessionQueue.async {
            do {
                try self.configureLocked(delegate: delegate)
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Ordem (Apple): entrada adicionada ANTES de escolher o formato; `activeFormat` e as frame durations no
    /// mesmo `lockForConfiguration`; tudo dentro de begin/commitConfiguration. Em falha o input anterior volta.
    private func configureLocked(delegate: AVCaptureVideoDataOutputSampleBufferDelegate) throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.noBackWideCamera
        }
        self.frameDelegate = delegate

        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // Prioridade ao formato escolhido por nós e sem troca automática para wide color (420f).
        session.sessionPreset = .inputPriority
        session.automaticallyConfiguresCaptureDeviceForWideColor = false
        session.automaticallyConfiguresApplicationAudioSession = false

        // Entrada (antes do formato)
        let oldInput = input
        if let old = oldInput { session.removeInput(old) }
        let newInput: AVCaptureDeviceInput
        do {
            newInput = try AVCaptureDeviceInput(device: device)
        } catch {
            if let old = oldInput, session.canAddInput(old) { session.addInput(old) }
            throw error
        }
        guard session.canAddInput(newInput) else {
            if let old = oldInput, session.canAddInput(old) { session.addInput(old) }
            throw CameraError.cannotAddInput
        }
        session.addInput(newInput)
        input = newInput
        self.device = device

        // Formato 240 FPS em 420v, menor área.
        let candidates = FormatSelection.candidates(from: device)
        guard let picked = FormatSelection.selectWithFallback(candidates) else {
            Self.log.error("Sem formato 420v acima de 60 FPS. Melhor taxa disponível: \(FormatSelection.bestAvailableFps(candidates))")
            throw CameraError.noHighFrameRateFormat
        }
        let chosen = picked.format
        let activeFps = picked.fps
        let format = device.formats[chosen.index]

        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.activeFormat = format   // ATENÇÃO: reseta as frame durations -> setar logo abaixo
            let frameDuration = CMTime(value: 1, timescale: CMTimeScale(activeFps))
            device.activeVideoMinFrameDuration = frameDuration
            device.activeVideoMaxFrameDuration = frameDuration
            device.videoZoomFactor = 1.0
            if format.isVideoHDRSupported {
                device.automaticallyAdjustsVideoHDREnabled = false
                device.isVideoHDREnabled = false
            }
            if device.isGeometricDistortionCorrectionSupported {
                device.isGeometricDistortionCorrectionEnabled = false
            }
            if device.isLowLightBoostSupported {
                device.automaticallyEnablesLowLightBoostWhenAvailable = false
            }
            device.isSubjectAreaChangeMonitoringEnabled = false
            device.automaticallyAdjustsFaceDrivenAutoFocusEnabled = false
            device.isFaceDrivenAutoFocusEnabled = false
            // Teto da exposição automática durante a convergência: nunca acima do período do quadro.
            device.activeMaxExposureDuration = Self.clampExposure(ns: desiredExposureNs, format: format)
        }

        // Saída de dados: NV12 (420v), plano 0 = luminância. Quadros atrasados são descartados.
        let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        guard videoOutput.availableVideoPixelFormatTypes.contains(nv12) else { throw CameraError.pixelFormatUnavailable }
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: nv12]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(delegate, queue: processingQueue)
        if session.outputs.contains(videoOutput) == false {
            guard session.canAddOutput(videoOutput) else { throw CameraError.cannotAddOutput }
            session.addOutput(videoOutput)
        }
        if let conn = videoOutput.connection(with: .video) {
            if conn.isVideoStabilizationSupported { conn.preferredVideoStabilizationMode = .off }
            OrientationAdapter.ensureNativeOrientation(conn)
            conn.isEnabled = false   // IDLE: só o preview roda; quadros só quando o engine pedir
        }

        let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
        stateLock.lock(); _formatDimensions = (Int(dims.width), Int(dims.height)); stateLock.unlock()
        DispatchQueue.main.async {
            self.activeInfo = ActiveCaptureInfo(width: Int(dims.width), height: Int(dims.height), fps: activeFps,
                                                isBinned: format.isVideoBinned, exposureNs: 0, iso: 0, locked: false)
        }
        Self.log.info("Formato: \(dims.width)x\(dims.height) @\(activeFps) 420v binned=\(format.isVideoBinned) expo=[\(chosen.minExposureNs)...\(chosen.maxExposureNs)] ns ISO=[\(chosen.minISO)...\(chosen.maxISO)]")
        observeDevice(device)
    }

    /// Limita uma duração (ns) aos limites do formato comparando `CMTime` (não inteiros arredondados:
    /// um valor arredondado para baixo do mínimo real lança uma exceção Objective-C impossível de capturar).
    static func clampExposure(ns: Int64, format: AVCaptureDevice.Format) -> CMTime {
        var d = CMTime(value: ns, timescale: 1_000_000_000)
        if CMTimeCompare(d, format.minExposureDuration) < 0 { d = format.minExposureDuration }
        if CMTimeCompare(d, format.maxExposureDuration) > 0 { d = format.maxExposureDuration }
        return d
    }

    func start() {
        sessionQueue.async {
            guard !self.session.isRunning else { return }
            self.session.startRunning()
            DispatchQueue.main.async { self.isRunning = self.session.isRunning }
        }
    }

    func stop() {
        sessionQueue.async {
            guard self.session.isRunning else { return }
            self.session.stopRunning()
            DispatchQueue.main.async { self.isRunning = false }
        }
    }

    // MARK: - Suspensão de quadros (efeito setFrameDelivery da FSM)
    func setFrameDelivery(_ enabled: Bool) {
        switch suspendStrategy {
        case .disableConnection:
            softGateOpen.store(true)
            sessionQueue.async {
                self.videoOutput.connection(with: .video)?.isEnabled = enabled
            }
        case .softGate:
            softGateOpen.store(enabled)
            sessionQueue.async {
                if let c = self.videoOutput.connection(with: .video), !c.isEnabled { c.isEnabled = true }
            }
        }
    }

    // MARK: - Convergir e travar (Calibrar)
    /// 1) reaplica o teto de exposição desejado e liga exposição/foco/balanço contínuos com ponto de
    ///    interesse no centro da ROI;
    /// 2) espera a convergência de verdade: piso de 400 ms, depois `isAdjusting*` == false em duas
    ///    leituras seguidas (50 ms), com timeout;
    /// 3) trava: `setExposureModeCustom(duration, iso)`, `setFocusModeLocked(lensPosition)`,
    ///    `setWhiteBalanceModeLocked(gains)`, e publica a exposição REAL aplicada.
    /// A verificação de que a taxa continuou em 240 FPS é feita pela `PhotocellSession` com o ΔPTS dos
    /// quadros que chegam durante a calibração de ruído (`activeVideoMinFrameDuration` é o valor pedido,
    /// nunca muda sozinho e por isso não serve de verificação).
    func convergeAndLock(pointOfInterest: CGPoint, timeout: TimeInterval = 2.0,
                         completion: @escaping (Error?) -> Void) {
        sessionQueue.async {
            guard let device = self.device else { completion(CameraError.noBackWideCamera); return }
            do {
                try device.lockForConfiguration()
                device.activeMaxExposureDuration = Self.clampExposure(ns: self.desiredExposureNs, format: device.activeFormat)
                if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = pointOfInterest }
                if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = pointOfInterest }
                if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
                if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
                device.unlockForConfiguration()
            } catch {
                completion(CameraError.configuration(error.localizedDescription)); return
            }
            let startedAt = Date()
            let deadline = startedAt.addingTimeInterval(timeout)
            self.sessionQueue.asyncAfter(deadline: .now() + 0.4) {
                self.waitForConvergence(device: device, deadline: deadline, settledStreak: 0) {
                    self.sessionQueue.async {
                        do {
                            try device.lockForConfiguration()
                            defer { device.unlockForConfiguration() }
                            let duration = device.exposureDuration
                            let iso = device.iso
                            if device.isExposureModeSupported(.custom) {
                                device.setExposureModeCustom(duration: duration, iso: iso, completionHandler: nil)
                            } else if device.isExposureModeSupported(.locked) {
                                device.exposureMode = .locked
                            }
                            if device.isFocusModeSupported(.locked) {
                                if device.isLockingFocusWithCustomLensPositionSupported {
                                    device.setFocusModeLocked(lensPosition: AVCaptureDevice.currentLensPosition, completionHandler: nil)
                                } else {
                                    device.focusMode = .locked
                                }
                            }
                            if device.isWhiteBalanceModeSupported(.locked) {
                                if device.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                                    device.setWhiteBalanceModeLocked(with: AVCaptureDevice.currentWhiteBalanceGains, completionHandler: nil)
                                } else {
                                    device.whiteBalanceMode = .locked
                                }
                            }
                            let expNs = CMTimeConvertScale(duration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
                            Self.log.info("Travado: exposição \(expNs) ns (desejada \(self.desiredExposureNs)), ISO \(iso), convergência \(Int(Date().timeIntervalSince(startedAt) * 1000)) ms")
                            DispatchQueue.main.async {
                                self.activeInfo.exposureNs = expNs
                                self.activeInfo.iso = iso
                                self.activeInfo.locked = true
                            }
                            completion(nil)
                        } catch {
                            completion(CameraError.configuration(error.localizedDescription))
                        }
                    }
                }
            }
        }
    }

    /// Convergência: duas leituras seguidas (50 ms) sem `isAdjusting*`, ou timeout.
    private func waitForConvergence(device: AVCaptureDevice, deadline: Date, settledStreak: Int, done: @escaping () -> Void) {
        let settled = !(device.isAdjustingExposure || device.isAdjustingFocus || device.isAdjustingWhiteBalance)
        let streak = settled ? settledStreak + 1 : 0
        if streak >= 2 || Date() >= deadline {
            done()
        } else {
            sessionQueue.asyncAfter(deadline: .now() + 0.05) {
                self.waitForConvergence(device: device, deadline: deadline, settledStreak: streak, done: done)
            }
        }
    }

    /// Aplica a exposição desejada: como teto do AE (antes de travar) ou como nova exposição custom
    /// (já travada, mantendo o ISO atual). Sempre na `sessionQueue`.
    private func applyDesiredExposure() {
        guard let device = self.device else { return }
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            let d = Self.clampExposure(ns: desiredExposureNs, format: device.activeFormat)
            device.activeMaxExposureDuration = d
            if device.exposureMode == .custom, device.isExposureModeSupported(.custom) {
                let iso = device.iso
                device.setExposureModeCustom(duration: d, iso: iso, completionHandler: nil)
                let expNs = CMTimeConvertScale(d, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
                DispatchQueue.main.async {
                    self.activeInfo.exposureNs = expNs
                    self.activeInfo.iso = iso
                    self.activeInfo.locked = true
                }
            }
        } catch {
            Self.log.error("applyDesiredExposure: \(error.localizedDescription)")
        }
    }

    // MARK: - Observação (pressão do sistema, interrupções, erros)
    /// Observadores da SESSÃO: registrados no `init`, antes de qualquer `throw` da configuração.
    private func observeSession() {
        let nc = NotificationCenter.default
        notificationTokens.append(nc.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil) { [weak self] note in
            let reason = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
            Self.log.warning("Sessão interrompida (motivo \(reason ?? -1))")
            self?.onInterruption?(true)
        })
        notificationTokens.append(nc.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: session, queue: nil) { [weak self] _ in
            self?.onInterruption?(false)
        })
        notificationTokens.append(nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { [weak self] note in
            if let err = note.userInfo?[AVCaptureSessionErrorKey] as? Error {
                Self.log.error("Erro de runtime: \(err.localizedDescription)")
                self?.onRuntimeError?(err)
            }
        })
    }

    private func observeDevice(_ device: AVCaptureDevice) {
        kvo.removeAll()
        kvo.append(device.observe(\.systemPressureState, options: [.initial, .new]) { [weak self] dev, _ in
            let level = dev.systemPressureState.level
            DispatchQueue.main.async { self?.systemPressure = level }
        })
    }

    deinit {
        for t in notificationTokens { NotificationCenter.default.removeObserver(t) }
    }
}

/// Booleano atômico simples (sem dependências) para o portão de quadros.
final class ManagedAtomicBool {
    private let lock = NSLock()
    private var value: Bool
    init(_ v: Bool) { value = v }
    func load() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    func store(_ v: Bool) { lock.lock(); value = v; lock.unlock() }
}
