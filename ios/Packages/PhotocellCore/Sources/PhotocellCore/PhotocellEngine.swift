import Foundation

/// Estados da máquina (nomes exatamente como na especificação, mais CONFIRMING e ERROR).
public enum PhotocellState: String, Sendable {
    case idle, calibrating, armed, confirmingStart, debounceStart, running,
         awaitingFinish, confirmingFinish, debounceFinish, finished, error

    public var isActive: Bool {
        switch self {
        case .armed, .confirmingStart, .debounceStart, .running, .awaitingFinish, .confirmingFinish, .debounceFinish:
            return true
        default:
            return false
        }
    }

    /// Nome legível em pt-BR para a interface.
    public var label: String {
        switch self {
        case .idle: return "Em espera"
        case .calibrating: return "Calibrando ruído"
        case .armed: return "Armada"
        case .confirmingStart: return "Confirmando largada"
        case .debounceStart: return "Largada!"
        case .running: return "Prova em andamento"
        case .awaitingFinish: return "Aguardando chegada"
        case .confirmingFinish: return "Confirmando chegada"
        case .debounceFinish: return "Chegada!"
        case .finished: return "Finalizada"
        case .error: return "Erro"
        }
    }
}

/// Efeitos que a camada de plataforma deve executar após cada evento.
public enum Effect: Equatable, Sendable {
    public enum FeedbackKind: Sendable { case start, finish }
    case setFrameDelivery(Bool)
    case resetDifferencer
    case updateBackground
    case setReferenceLag(Int)
    case scheduleWakeup(Nanos)
    case cancelWakeups
    case feedback(FeedbackKind)
    case publish

    /// Representação textual idêntica à da referência Python (usada nos vetores de teste).
    public var wire: String {
        switch self {
        case .setFrameDelivery(let on): return "setFrameDelivery:\(on ? "true" : "false")"
        case .resetDifferencer: return "resetDifferencer"
        case .updateBackground: return "updateBackground"
        case .setReferenceLag(let l): return "setReferenceLag:\(l)"
        case .scheduleWakeup(let at): return "scheduleWakeup:\(at)"
        case .cancelWakeups: return "cancelWakeups"
        case .feedback(let k): return "feedback:" + (k == .start ? "start" : "finish")
        case .publish: return "publish"
        }
    }
}

public struct TriggerInfo: Equatable, Sendable {
    public var rawTsNs: Nanos
    public var refinedTsNs: Nanos
    public var quality: Int
    public var uncertaintyNs: Nanos
    public var interiorCount: Int
    public var degraded: Bool
    /// Colunas cuja dispersão de tempos excede o ruído (textura/inclinação do bordo).
    public var texturedColumns: Int = 0
}

public struct RunResult: Equatable, Sendable {
    public var start: TriggerInfo
    public var finish: TriggerInfo
    public var elapsedRawNs: Nanos
    public var elapsedRefinedNs: Nanos
    public var drops: Int
    public var degraded: Bool
    public var thresholdStart: Double
    public var thresholdFinish: Double
}

private struct Candidate {
    var inp: CrossingInput      // cópias das faixas do candidato (os buffers do differencer rotacionam)
    let degraded: Bool
    var seen = 0
    var confirmed = 0
}

/// Dono único da máquina de estados. Deve ser acionado sempre da MESMA fila (a do processamento
/// de quadros); o `CADisplayLink` apenas lê o snapshot. Após cada evento, execute e limpe `effects`.
public final class PhotocellEngine {
    public let cfg: PhotocellConfig
    public let roi: RoiRect
    public let planeHeight: Int

    public private(set) var state: PhotocellState = .idle
    public private(set) var errorReason: String? = nil
    public private(set) var threshold: Double? = nil
    public private(set) var lag: Int = 1
    public private(set) var start: TriggerInfo? = nil
    public private(set) var finish: TriggerInfo? = nil
    public private(set) var result: RunResult? = nil
    public private(set) var drops: Int = 0
    public private(set) var noiseSigmaPx: Double = 0.0
    /// Estatísticas da última calibração (para diagnóstico na UI).
    public private(set) var noiseMean: Double = 0.0

    public var effects: [Effect] = []
    /// Histórico de estados (para testes/diagnóstico).
    public private(set) var transitions: [PhotocellState] = []

    private var calibrator: NoiseCalibrator
    private var calibratorLag2: NoiseCalibrator
    private var afterCalibration: PhotocellState = .idle
    private var candidate: Candidate? = nil
    private var thresholdStart = 0.0
    private var wakeups: [Nanos] = []
    private var lastFrameTs: Nanos? = nil
    /// Quadro visto antes do atual (para o intervalo de qualidade 0).
    /// Intervalo de qualidade 0: o limite inferior é o último quadro em que a faixa foi REALMENTE
    /// comparada (o differencer devolve nil enquanto ressemeia depois de um drop/arm/retomada); se
    /// ainda não houve nenhum, o primeiro quadro recebido desde o ressemeio.
    private var lastMeasuredTs: Nanos? = nil
    private var seedTs: Nanos? = nil
    private var lastDropTs: Nanos? = nil
    private var dropPending = false   // a plataforma avisou de quadros perdidos sem timestamp

    /// Lança `PhotocellConfig.ValidationError` se as janelas forem incoerentes (a prova travaria).
    public init(cfg: PhotocellConfig, roi: RoiRect, planeHeight: Int) throws {
        try cfg.validate()
        self.cfg = cfg
        self.roi = roi
        self.planeHeight = planeHeight
        calibrator = NoiseCalibrator(cfg: cfg)
        calibratorLag2 = NoiseCalibrator(cfg: cfg)
    }

    // MARK: - utilitários
    private func emit(_ e: Effect) { effects.append(e) }

    private func go(_ s: PhotocellState) {
        state = s
        transitions.append(s)
        emit(.publish)
    }

    private func schedule(_ atNs: Nanos) {
        wakeups.append(atNs)
        wakeups.sort()
        emit(.scheduleWakeup(atNs))
    }

    private func cancelWakeups() {
        wakeups.removeAll()
        emit(.cancelWakeups)
    }

    private func processDeadlines(_ nowNs: Nanos) {
        while let first = wakeups.first, first <= nowNs {
            wakeups.removeFirst()
            onDeadline(first)
        }
    }

    // MARK: - eventos do usuário
    public func userCalibrate() {
        if state == .idle || state == .finished || state == .error || state == .armed {
            beginCalibration(next: .idle)
        }
    }

    public func userArm() {
        if state == .idle || state == .finished { beginCalibration(next: .armed) }
    }

    public func userReset() {
        cancelWakeups()
        emit(.setFrameDelivery(false))
        if lag != 1 {
            lag = 1
            emit(.setReferenceLag(1))
        }
        candidate = nil
        start = nil
        finish = nil
        result = nil
        errorReason = nil
        drops = 0
        lastDropTs = nil
        dropPending = false
        lastFrameTs = nil
        lastMeasuredTs = nil
        seedTs = nil
        go(.idle)
    }

    public func captureInterrupted() {
        if state.isActive || state == .calibrating { fail("captureInterrupted") }
    }

    /// A plataforma soube de quadros perdidos (TN2445 "Discontinuity", ImageReader estourado) sem
    /// conhecer os timestamps: o candidato em confirmação perde a base de tempo e é descartado, o
    /// próximo quadro conta como drop (passada "degradada" se estiver perto do gatilho) e a
    /// referência do differencer é ressemeada.
    public func framesDropped() {
        drops += 1
        dropPending = true
        lastFrameTs = nil
        seedTs = nil
        if state == .confirmingStart {
            candidate = nil
            go(.armed)
        } else if state == .confirmingFinish {
            candidate = nil
            go(.awaitingFinish)
        }
        if state == .calibrating || state == .armed || state == .awaitingFinish {
            emit(.resetDifferencer)
        }
    }

    private func fail(_ reason: String) {
        cancelWakeups()
        emit(.setFrameDelivery(false))
        candidate = nil
        errorReason = reason
        go(.error)
    }

    private func beginCalibration(next: PhotocellState) {
        afterCalibration = next
        calibrator.reset()
        calibratorLag2.reset()
        candidate = nil
        lastFrameTs = nil
        lastMeasuredTs = nil
        seedTs = nil
        if lag != 1 {
            lag = 1
            emit(.setReferenceLag(1))
        }
        emit(.setFrameDelivery(true))
        emit(.resetDifferencer)
        go(.calibrating)
    }

    // MARK: - tempo
    public func wakeup(nowNs: Nanos) { processDeadlines(nowNs) }

    private func onDeadline(_ atNs: Nanos) {
        guard let s = start?.rawTsNs else { return }
        if state == .debounceStart && atNs == s + cfg.startLockoutNs {
            go(.running)
        } else if (state == .running || state == .awaitingFinish) && atNs == s + cfg.frameResumeNs {
            lastFrameTs = nil
            seedTs = nil
            emit(.setFrameDelivery(true))
            emit(.resetDifferencer)
        } else if state == .running && atNs == s + cfg.finishArmNs {
            candidate = nil
            go(.awaitingFinish)
        } else if state == .debounceFinish, let f = finish, atNs == f.rawTsNs + cfg.finishLockoutNs {
            finishRun()
        }
    }

    // MARK: - quadros
    /// `m == nil` significa quadro-semente (o differencer acabou de ressemear); passe `tsNs`.
    public func frame(_ m: FrameMeasurement?, tsNs: Nanos? = nil) {
        let ts = m?.tsNs ?? tsNs
        if let ts = ts {
            trackGaps(ts)
            processDeadlines(ts)
        }
        guard let m = m else { return }
        switch state {
        case .calibrating: calibrationFrame(m)
        case .armed: armedFrame(m, confirming: .confirmingStart)
        case .confirmingStart: confirmingFrame(m, back: .armed, isStart: true)
        case .awaitingFinish: armedFrame(m, confirming: .confirmingFinish)
        case .confirmingFinish: confirmingFrame(m, back: .awaitingFinish, isStart: false)
        default: break // RUNNING (após retomada), DEBOUNCE_*, FINISHED, IDLE, ERROR: ignorar
        }
        // depois do despacho: o candidato criado neste quadro precisa do quadro medido ANTERIOR
        lastMeasuredTs = m.tsNs
    }

    private func trackGaps(_ tsNs: Nanos) {
        if dropPending {
            dropPending = false
            lastDropTs = tsNs
        }
        if let last = lastFrameTs {
            let gap = tsNs - last
            if Double(gap) > cfg.dropGapFactor * Double(cfg.framePeriodNs) {
                let missed = Int((Double(gap) / Double(cfg.framePeriodNs) + 0.5).rounded(.down)) - 1
                if missed > 0 {
                    drops += missed
                    lastDropTs = tsNs
                }
            }
        }
        if seedTs == nil { seedTs = tsNs }
        lastFrameTs = tsNs
    }

    private func calibrationFrame(_ m: FrameMeasurement) {
        if let l2 = m.deltaFullLag2 { _ = calibratorLag2.addSample(l2) }
        switch calibrator.addSample(m.deltaFull) {
        case .restarted:
            // as duas janelas precisam cobrir as mesmas amostras para a decisão de flicker valer
            calibratorLag2.reset()
        case .done:
            var stats = calibrator.stats
            var th = calibrator.threshold ?? 0
            let s2 = calibratorLag2.stats
            if cfg.flickerAuto && s2.count >= cfg.calibrationSamples - 1 && s2.mean < cfg.flickerRatio * stats.mean {
                stats = s2
                th = computeThreshold(cfg, mean: s2.mean, sigma: s2.sigma)
                lag = 2
                emit(.setReferenceLag(2))
            }
            threshold = th
            noiseMean = stats.mean
            noiseSigmaPx = stats.mean / meanAbsDiffToSigma
            emit(.updateBackground)
            go(afterCalibration)
        case .failed:
            fail("calibrationUnstable")
        default:
            break
        }
    }

    private func armedFrame(_ m: FrameMeasurement, confirming: PhotocellState) {
        guard let th = threshold else { return }
        if m.deltaCore > th {
            var degraded = false
            if let ld = lastDropTs { degraded = abs(m.tsNs - ld) < cfg.degradedDropWindowNs }
            // cópias: os buffers do differencer rotacionam no próximo quadro
            var inp = CrossingInput(tsNs: m.tsNs, prevTsNs: m.prevTsNs, stripPrev: Array(m.stripPrev),
                                    stripCur: Array(m.stripCur), stripBg: Array(m.stripBg), lag: m.lag)
            inp.lastSeenTsNs = lastMeasuredTs ?? seedTs
            candidate = Candidate(inp: inp, degraded: degraded)
            go(confirming)
        } else if m.deltaFull <= th {
            emit(.updateBackground)
        }
    }

    private func confirmingFrame(_ m: FrameMeasurement, back: PhotocellState, isStart: Bool) {
        guard var c = candidate, let th = threshold else { return }
        c.seen += 1
        if c.seen == lag {
            c.inp.nextStrip = Array(m.stripCur)
            c.inp.nextTsNs = m.tsNs
        }
        if c.seen == 2 * lag {
            c.inp.plateauStrip = Array(m.stripCur)
            c.inp.plateauTsNs = m.tsNs
        }
        if m.deltaBackground > th * cfg.backgroundThresholdMultiplier { c.confirmed += 1 }
        if c.confirmed >= cfg.confirmRequired && c.seen >= 2 * lag {
            let est = CrossingEstimator.estimate(cfg: cfg, roi: roi, planeHeight: planeHeight, input: c.inp,
                                                 noiseSigmaPx: noiseSigmaPx)
            let info = TriggerInfo(rawTsNs: c.inp.tsNs, refinedTsNs: est.refinedTsNs, quality: est.quality,
                                   uncertaintyNs: est.uncertaintyNs, interiorCount: est.interiorCount,
                                   degraded: c.degraded, texturedColumns: est.texturedColumns)
            candidate = nil
            if isStart { triggerStart(info) } else { triggerFinish(info) }
        } else if c.seen >= cfg.confirmWindow {
            candidate = nil
            go(back)
        } else {
            candidate = c
        }
    }

    private func triggerStart(_ info: TriggerInfo) {
        start = info
        thresholdStart = threshold ?? 0.0
        emit(.feedback(.start))
        emit(.setFrameDelivery(false))
        go(.debounceStart)
        let s = info.rawTsNs
        schedule(s + cfg.startLockoutNs)
        schedule(s + cfg.frameResumeNs)
        schedule(s + cfg.finishArmNs)
    }

    private func triggerFinish(_ info: TriggerInfo) {
        finish = info
        emit(.feedback(.finish))
        emit(.setFrameDelivery(false))
        go(.debounceFinish)
        schedule(info.rawTsNs + cfg.finishLockoutNs)
    }

    private func finishRun() {
        guard let s = start, let f = finish else { return }
        result = RunResult(start: s, finish: f,
                           elapsedRawNs: f.rawTsNs - s.rawTsNs,
                           elapsedRefinedNs: f.refinedTsNs - s.refinedTsNs,
                           drops: drops,
                           degraded: s.degraded || f.degraded,
                           thresholdStart: thresholdStart,
                           thresholdFinish: threshold ?? 0.0)
        go(.finished)
    }
}
