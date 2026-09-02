import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import PhotocellCore
import os

/// Diagnósticos de baixa frequência (≤ 15 Hz) para a interface.
struct SessionDiagnostics: Equatable {
    var lastDeltaFull: Double = 0
    var lastDeltaCore: Double = 0
    var lastDeltaBackground: Double = 0
    /// Taxa medida pelo ΔPTS na última janela de 1 s; válida só com `fpsMeasurementValid`.
    var measuredFps: Double = 0
    /// false até fechar uma janela de 1 s de quadros desde a última (re)ativação da entrega.
    var fpsMeasurementValid: Bool = false
    /// Desvio-padrão de ΔPTS na última janela de 1 s (ms). Espera-se ≪ 0,1 ms a 240 FPS estáveis.
    var ptsJitterMs: Double = 0
    var framesProcessed: Int = 0
    var droppedByOutput: Int = 0
    /// Drops do tipo "Discontinuity" (TN2445): número desconhecido de quadros perdidos.
    var discontinuities: Int = 0
    var lastFrameCostMicros: Double = 0
    var planeWidth: Int = 0
    var planeHeight: Int = 0
    var roi: RoiRect? = nil
}

/// ROI em coordenadas normalizadas do buffer (imagem não rotacionada) + largura em pixels.
struct NormalizedROI: Equatable {
    var centerX: Double = 0.5
    var top: Double = 0.2
    var bottom: Double = 0.8
    var widthPx: Int = 15
}

/// Dono único do engine e do differencer. Tudo aqui roda em `camera.processingQueue`
/// (fila serial `.userInteractive`): callback da câmera, eventos do usuário e timers de wake-up.
/// A interface recebe snapshots imutáveis na main thread.
final class PhotocellSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    static let log = Logger(subsystem: "br.com.tportooliveira.fotocelulatambor", category: "session")
    private static let signposter = OSSignposter(subsystem: "br.com.tportooliveira.fotocelulatambor", category: "frame")

    let camera: CameraManager
    private let queue: DispatchQueue
    private var clock: SessionClock

    private(set) var config: PhotocellConfig
    private var normalizedROI = NormalizedROI()
    private var roi: RoiRect?
    private var planeWidth = 0
    private var planeHeight = 0
    private var differencer: StripDifferencer?
    private var engine: PhotocellEngine?
    private var timers: [DispatchSourceTimer] = []

    private let snapshotLock = NSLock()
    private var _snapshot = PhotocellSnapshot()
    private var diagnostics = SessionDiagnostics()
    private var fpsWindowStart: Nanos? = nil
    private var fpsWindowCount = 0
    private var lastPts: Nanos? = nil
    private var deltaSum: Double = 0
    private var deltaSumSq: Double = 0

    var onSnapshot: ((PhotocellSnapshot) -> Void)?           // main thread
    var onDiagnostics: ((SessionDiagnostics) -> Void)?      // main thread
    var onFeedback: ((Effect.FeedbackKind) -> Void)?        // main thread
    var onRunFinished: ((RunResult) -> Void)?               // main thread

    init(camera: CameraManager, config: PhotocellConfig) {
        self.camera = camera
        self.queue = camera.processingQueue
        self.config = config
        self.clock = SessionClock(session: camera.session)
        super.init()
    }

    /// Snapshot atual (leitura segura de qualquer thread; usado pelo display link).
    var snapshot: PhotocellSnapshot {
        snapshotLock.lock(); defer { snapshotLock.unlock() }
        return _snapshot
    }

    func refreshClock() { queue.async { self.clock = SessionClock(session: self.camera.session) } }

    // MARK: - Ações do usuário (sempre na fila de processamento)
    func calibrate() { queue.async { if self.engine == nil { self.rebuildIfIdle() }; self.engine?.userCalibrate(); self.runEffects() } }
    func arm() { queue.async { if self.engine == nil { self.rebuildIfIdle() }; self.engine?.userArm(); self.runEffects() } }
    func reset() {
        queue.async {
            self.engine?.userReset()
            self.runEffects()
            if self.rebuildPending { self.rebuildIfIdle() }
        }
    }
    func captureInterrupted() { queue.async { self.engine?.captureInterrupted(); self.runEffects() } }

    func updateConfig(_ cfg: PhotocellConfig) {
        queue.async {
            self.config = cfg
            self.rebuildIfIdle()
        }
    }

    func updateROI(_ roi: NormalizedROI) {
        queue.async {
            self.normalizedROI = roi
            self.rebuildIfIdle()
        }
    }

    /// Recria differencer + engine. Só acontece em IDLE (nunca no meio da prova nem sobre um
    /// resultado/erro ainda exibido); fora disso a mudança fica pendente até o próximo Reset.
    private var rebuildPending = false

    private func rebuildIfIdle() {
        if let e = engine, e.state != .idle { rebuildPending = true; return }
        rebuildPending = false
        if planeWidth == 0 || planeHeight == 0 {
            // Antes do primeiro quadro (a entrega começa desligada em IDLE) usamos as dimensões do formato ativo
            // (cacheadas pelo CameraManager na configuração; leitura segura de qualquer fila).
            let dims = camera.formatDimensions
            if dims.width > 0, dims.height > 0 {
                planeWidth = dims.width
                planeHeight = dims.height
                diagnostics.planeWidth = planeWidth
                diagnostics.planeHeight = planeHeight
            }
        }
        guard planeWidth > 0, planeHeight > 0 else { return }
        let width = max(1, min(normalizedROI.widthPx, planeWidth))
        var x = Int((normalizedROI.centerX * Double(planeWidth)).rounded()) - width / 2
        x = max(0, min(x, planeWidth - width))
        var y0 = Int((normalizedROI.top * Double(planeHeight)).rounded())
        var y1 = Int((normalizedROI.bottom * Double(planeHeight)).rounded())
        y0 = max(0, min(y0, planeHeight - 1))
        y1 = max(y0 + 1, min(y1, planeHeight))
        let r = RoiRect(x: x, width: width, y0: y0, y1: y1)
        let cw = max(1, min(config.coreWidth, width))
        var cfg = config
        cfg.coreWidth = cw
        do {
            differencer = try StripDifferencer(roi: r, planeWidth: planeWidth, planeHeight: planeHeight, coreWidth: cw)
            engine = try PhotocellEngine(cfg: cfg, roi: r, planeHeight: planeHeight)
        } catch {
            Self.log.error("ROI/configuração inválida: \(String(describing: error))")
            differencer = nil
            engine = nil
            return
        }
        roi = r
        diagnostics.roi = r
        publish()
        publishDiagnostics()
    }

    // MARK: - Callback da câmera (< 4 ms por quadro; sem alocação no caminho quente)
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard camera.softGateOpen.load() else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let state = Self.signposter.beginInterval("frame")
        defer { Self.signposter.endInterval("frame", state) }
        let t0 = mach_absolute_time()

        let pts = SessionClock.presentationNanos(of: sampleBuffer)
        // Bloqueia o buffer somente para leitura e SEMPRE libera ao final do quadro (só se o lock funcionou).
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 1,
              let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return }
        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)   // lido a cada quadro (padding pode variar)

        if width != planeWidth || height != planeHeight || engine == nil {
            if engine == nil || engine?.state == .idle {
                planeWidth = width
                planeHeight = height
                diagnostics.planeWidth = width
                diagnostics.planeHeight = height
                rebuildIfIdle()
            } else {
                // formato mudou fora de IDLE: o differencer atual foi validado para outras dimensões
                rebuildPending = true
            }
        }
        guard let diff = differencer, let eng = engine, let r = roi,
              r.y1 <= height, r.x + r.width <= width else { return }   // nunca ler fora do plano

        let plane = base.assumingMemoryBound(to: UInt8.self)
        let m = diff.process(plane: UnsafePointer(plane), stride: stride, tsNs: pts)
        if let m = m {
            eng.frame(m)
            diagnostics.lastDeltaFull = m.deltaFull
            diagnostics.lastDeltaCore = m.deltaCore
            diagnostics.lastDeltaBackground = m.deltaBackground
        } else {
            eng.frame(nil, tsNs: pts)
        }
        runEffects()
        trackFps(pts)
        diagnostics.framesProcessed += 1
        let dt = mach_absolute_time() - t0
        diagnostics.lastFrameCostMicros = Double(dt) * Self.timebaseNanos / 1000.0
        if diagnostics.framesProcessed % 16 == 0 { publishDiagnostics() }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        // Mesma fila; manter trivial. Drops normais aparecem como gap de PTS no engine; uma
        // "Discontinuity" (TN2445) perdeu um número desconhecido de quadros: o engine descarta o candidato.
        diagnostics.droppedByOutput += 1
        if let reason = CMGetAttachment(sampleBuffer, key: kCMSampleBufferAttachmentKey_DroppedFrameReason, attachmentModeOut: nil),
           CFGetTypeID(reason) == CFStringGetTypeID(),
           CFEqual(reason, kCMSampleBufferDroppedFrameReason_Discontinuity) {
            diagnostics.discontinuities += 1
            engine?.framesDropped()
            runEffects()
        }
    }

    private static let timebaseNanos: Double = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return Double(info.numer) / Double(info.denom)
    }()

    private func trackFps(_ pts: Nanos) {
        if let last = lastPts {
            let d = Double(pts - last)
            deltaSum += d
            deltaSumSq += d * d
        }
        lastPts = pts
        if let start = fpsWindowStart {
            fpsWindowCount += 1
            let span = pts - start
            if span >= nsPerSecond {
                diagnostics.measuredFps = Double(fpsWindowCount) * 1e9 / Double(span)
                diagnostics.fpsMeasurementValid = true
                let n = Double(fpsWindowCount)
                let mean = deltaSum / n
                let variance = max(0, deltaSumSq / n - mean * mean)
                diagnostics.ptsJitterMs = variance.squareRoot() / 1e6
                fpsWindowStart = pts
                fpsWindowCount = 0
                deltaSum = 0
                deltaSumSq = 0
            }
        } else {
            fpsWindowStart = pts
            fpsWindowCount = 0
            deltaSum = 0
            deltaSumSq = 0
        }
    }

    // MARK: - Efeitos da FSM
    private func runEffects() {
        guard let eng = engine else { return }
        if eng.effects.isEmpty { return }
        var shouldPublish = false
        for e in eng.effects {
            switch e {
            case .setFrameDelivery(let on):
                camera.setFrameDelivery(on)
                if on {
                    // nova janela de medição: a taxa anterior não vale mais
                    fpsWindowStart = nil; lastPts = nil
                    diagnostics.fpsMeasurementValid = false
                }
            case .resetDifferencer:
                differencer?.reset()
            case .updateBackground:
                differencer?.updateBackground(alpha: config.backgroundEmaAlpha)
            case .setReferenceLag(let l):
                differencer?.setLag(l)
            case .scheduleWakeup(let at):
                scheduleWakeup(at: at)
            case .cancelWakeups:
                cancelWakeups()
            case .feedback(let kind):
                let cb = onFeedback
                DispatchQueue.main.async { cb?(kind) }
            case .publish:
                shouldPublish = true
            }
        }
        eng.effects.removeAll(keepingCapacity: true)
        if shouldPublish { publish() }
    }

    private func scheduleWakeup(at: Nanos) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let delay = max(0, at - clock.nowNs())
        timer.schedule(deadline: .now() + .nanoseconds(Int(delay)), leeway: .microseconds(250))
        timer.setEventHandler { [weak self, weak timer] in
            timer?.cancel()
            guard let self = self else { return }
            if let t = timer { self.timers.removeAll { $0 === t } }
            guard let eng = self.engine else { return }
            // o timer pode disparar um instante antes do prazo no relógio da sessão: nunca perder o deadline
            eng.wakeup(nowNs: max(self.clock.nowNs(), at))
            self.runEffects()
        }
        timers.append(timer)
        timer.resume()
    }

    private func cancelWakeups() {
        for t in timers { t.cancel() }
        timers.removeAll()
    }

    private func publish() {
        guard let eng = engine else { return }
        let snap = PhotocellSnapshot(engine: eng, lastDeltaFull: diagnostics.lastDeltaFull, lastDeltaCore: diagnostics.lastDeltaCore)
        snapshotLock.lock(); let prevState = _snapshot.state; _snapshot = snap; snapshotLock.unlock()
        // "Calibrar" volta a IDLE sem o engine emitir setFrameDelivery(false) (os vetores compartilhados
        // fixam os efeitos): em IDLE só o preview roda, então a entrega é desligada aqui. `userArm`
        // recalibra e religa; a medição de taxa só é invalidada quando a entrega volta.
        if prevState == .calibrating && snap.state == .idle { camera.setFrameDelivery(false) }
        let cb = onSnapshot
        let finished = onRunFinished
        DispatchQueue.main.async {
            cb?(snap)
            if snap.state == .finished, let r = snap.result { finished?(r) }
        }
    }

    private func publishDiagnostics() {
        let d = diagnostics
        let cb = onDiagnostics
        DispatchQueue.main.async { cb?(d) }
    }

    deinit { cancelWakeups() }
}
