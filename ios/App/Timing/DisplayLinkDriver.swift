import PhotocellCore
import QuartzCore
import UIKit

/// Atualiza o mostrador do cronômetro a cada quadro do display (120 Hz em ProMotion, com a chave
/// `CADisableMinimumFrameDurationOnPhone` no Info.plist). Só LÊ o snapshot do engine; nunca chama a FSM.
final class DisplayLinkDriver {
    private var link: CADisplayLink?
    private let clock: () -> SessionClock
    private let snapshot: () -> PhotocellSnapshot
    private let onTick: (Nanos?) -> Void

    init(clock: @escaping () -> SessionClock, snapshot: @escaping () -> PhotocellSnapshot,
         onTick: @escaping (Nanos?) -> Void) {
        self.clock = clock
        self.snapshot = snapshot
        self.onTick = onTick
    }

    func start() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(tick))
        // ProMotion: 120 Hz; em telas de 60 Hz um mínimo de 80 seria insatisfazível
        let maxFps = Float(UIScreen.main.maximumFramesPerSecond)
        l.preferredFrameRateRange = CAFrameRateRange(minimum: min(30, maxFps), maximum: maxFps, preferred: maxFps)
        l.add(to: .main, forMode: .common)
        link = l
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick() {
        let s = snapshot()
        guard let start = s.startNs else { onTick(nil); return }
        if let finish = s.finishNs {
            onTick(finish - start)
        } else {
            onTick(clock().nowNs() - start)
        }
    }

    deinit { link?.invalidate() }
}
