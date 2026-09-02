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
    var exposureNs: Int64 = 0
    var iso: Float = 0
    var locked: Bool = false
    var measuredFps: Double = 0
}

/// Gerencia o `AVCaptureSession`: permissão, câmera traseira 1x, formato 240 FPS em NV12, travas
/// de exposição/foco/balanço de branco, saída de dados e suspensão de quadros.
///
/// Toda configuração roda em `sessionQueue`; os quadros chegam em `processingQueue`
/// (serial, `.userInteractive`), onde vive o `PhotocellSession`.
final class CameraManager: NSObject {
    static let log = Logger(subsystem: "br.com.tportooliveira.fotocelulatambor", category: "camera")

    let session = AVCaptureSession()
    let sessionQueue = DispatchQueue(label: "br.com.tportooliveira.fotocelula.session")
    let processingQueue = DispatchQueue(label: "br.com.tportooliveira.fotocelula.processing",
                                        qos: .userInteractive, autoreleaseFrequency: .workItem)
    let videoOutput = AVCaptureVideoDataOutput()

    private(set) var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    /// O `AVCaptureVideoDataOutput` NÃO retém o delegate: mantemos referência forte aqui.
    private var frameDelegate: AVCaptureVideoDataOutputSampleBufferDelegate?
    private var kvo: [NSKeyValueObservation] = []
    private var notificationTokens: [NSObjectProtocol] = []

    var suspendStrategy: SuspendStrategy = .disableConnection
    /// Usado pela estratégia `.softGate`; lido no delegate (thread de processamento).
    let softGateOpen = ManagedAtomicBool(true)

    @Published private(set) var activeInfo = ActiveCaptureInfo()
    @Published private(set) var systemPressure: AVCaptureDevice.SystemPressureState.Level = .nominal
    @Published private(set) var isRunning = false

    var onInterruption: ((Bool) -> Void)?
    var onRuntimeError: ((Error) -> Void)?

    /// Duração de exposição desejada (ns). A 240 FPS o hardware limita a ≤ 1/240 s.
    var desiredExposureNs: Int64 = 2_083_333

    // MARK: - Permissão
    func requestAccess(_ completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: completion(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .video) { completion($0) }
        default: completion(false)
        }
    }

    // MARK: - Configuração
    /// Configura a sessão (na `sessionQueue`) e chama `completion` com o erro, se houver.
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

    private func configureLocked(delegate: AVCaptureVideoDataOutputSampleBufferDelegate) throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.noBackWideCamera
        }
        self.device = device
        self.frameDelegate = delegate

        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // Prioridade ao formato escolhido por nós e sem troca automática para wide color (420f).
        session.sessionPreset = .inputPriority
        session.automaticallyConfiguresCaptureDeviceForWideColor = false

        // Formato 240 FPS em 420v, menor área.
        let candidates = FormatSelection.candidates(from: device)
        guard let chosen = FormatSelection.select(candidates) else {
            Self.log.error("Sem formato 240 FPS/420v. Melhor taxa disponível: \(FormatSelection.bestAvailableFps(candidates))")
            throw CameraError.noHighFrameRateFormat
        }
        let format = device.formats[chosen.index]

        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        device.activeFormat = format   // ATENÇÃO: reseta as frame durations -> setar logo abaixo
        let frameDuration = CMTime(value: 1, timescale: 240)
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
        if #available(iOS 15.4, *) {
            device.automaticallyAdjustsFaceDrivenAutoFocusEnabled = false
            device.isFaceDrivenAutoFocusEnabled = false
        }
        // Teto da exposição automática durante a convergência: nunca acima do período do quadro.
        let capNs = min(desiredExposureNs, chosen.maxExposureNs)
        device.activeMaxExposureDuration = CMTime(value: max(capNs, chosen.minExposureNs), timescale: 1_000_000_000)

        // Entrada
        if let old = input { session.removeInput(old) }
        let newInput = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(newInput) else { throw CameraError.cannotAddInput }
        session.addInput(newInput)
        input = newInput

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
        DispatchQueue.main.async {
            self.activeInfo = ActiveCaptureInfo(width: Int(dims.width), height: Int(dims.height), fps: 240,
                                                isBinned: format.isVideoBinned, exposureNs: 0, iso: 0, locked: false)
        }
        Self.log.info("Formato: \(dims.width)x\(dims.height) @240 420v binned=\(format.isVideoBinned) expo=[\(chosen.minExposureNs)...\(chosen.maxExposureNs)] ns ISO=[\(chosen.minISO)...\(chosen.maxISO)]")
        observeDevice(device)
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
    /// 1) exposição/foco/balanço contínuos com ponto de interesse no centro da ROI;
    /// 2) espera `isAdjusting*` == false (KVO, timeout);
    /// 3) trava: `setExposureModeCustom(duration, iso)`, `setFocusModeLocked(lensPosition)`,
    ///    `setWhiteBalanceModeLocked(gains)`;
    /// 4) verifica que a duração do quadro continuou em 1/240 s.
    func convergeAndLock(pointOfInterest: CGPoint, timeout: TimeInterval = 1.5,
                         completion: @escaping (Error?) -> Void) {
        sessionQueue.async {
            guard let device = self.device else { completion(CameraError.noBackWideCamera); return }
            do {
                try device.lockForConfiguration()
                if device.isExposurePointOfInterestSupported { device.exposurePointOfInterest = pointOfInterest }
                if device.isFocusPointOfInterestSupported { device.focusPointOfInterest = pointOfInterest }
                if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
                if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { device.whiteBalanceMode = .continuousAutoWhiteBalance }
                device.unlockForConfiguration()
            } catch {
                completion(CameraError.configuration(error.localizedDescription)); return
            }
            let deadline = Date().addingTimeInterval(timeout)
            self.waitForConvergence(device: device, deadline: deadline) {
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
                        // Verificação: a exposição custom não pode ter alongado o quadro.
                        let fd = device.activeVideoMinFrameDuration
                        let fps = Double(fd.timescale) / Double(fd.value)
                        let expNs = CMTimeConvertScale(duration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
                        Self.log.info("Travado: exposição \(expNs) ns, ISO \(iso), frame duration -> \(fps) FPS")
                        DispatchQueue.main.async {
                            self.activeInfo.exposureNs = expNs
                            self.activeInfo.iso = iso
                            self.activeInfo.locked = true
                            self.activeInfo.fps = fps
                        }
                        if abs(fps - 240) > 2.4 {
                            completion(CameraError.frameRateNotHeld(measuredFps: fps))
                        } else {
                            completion(nil)
                        }
                    } catch {
                        completion(CameraError.configuration(error.localizedDescription))
                    }
                }
            }
        }
    }

    private func waitForConvergence(device: AVCaptureDevice, deadline: Date, done: @escaping () -> Void) {
        let settled = !(device.isAdjustingExposure || device.isAdjustingFocus || device.isAdjustingWhiteBalance)
        if settled || Date() >= deadline {
            done()
        } else {
            sessionQueue.asyncAfter(deadline: .now() + 0.05) {
                self.waitForConvergence(device: device, deadline: deadline, done: done)
            }
        }
    }

    /// Exposição/ISO explícitos (ajuste manual nas configurações).
    func setCustomExposure(durationNs: Int64, iso: Float) {
        sessionQueue.async {
            guard let device = self.device else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                let f = device.activeFormat
                let d = CMTime(value: min(max(durationNs, CMTimeConvertScale(f.minExposureDuration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value),
                                          CMTimeConvertScale(f.maxExposureDuration, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value),
                               timescale: 1_000_000_000)
                let i = min(max(iso, f.minISO), f.maxISO)
                if device.isExposureModeSupported(.custom) {
                    device.setExposureModeCustom(duration: d, iso: i, completionHandler: nil)
                }
                DispatchQueue.main.async {
                    self.activeInfo.exposureNs = d.value
                    self.activeInfo.iso = i
                    self.activeInfo.locked = true
                }
            } catch {
                Self.log.error("setCustomExposure: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Observação (pressão do sistema, interrupções, erros)
    private func observeDevice(_ device: AVCaptureDevice) {
        kvo.removeAll()
        kvo.append(device.observe(\.systemPressureState, options: [.initial, .new]) { [weak self] dev, _ in
            let level = dev.systemPressureState.level
            DispatchQueue.main.async { self?.systemPressure = level }
        })
        for t in notificationTokens { NotificationCenter.default.removeObserver(t) }
        notificationTokens.removeAll()
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
