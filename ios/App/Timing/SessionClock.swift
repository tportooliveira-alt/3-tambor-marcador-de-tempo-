import AVFoundation
import CoreMedia
import PhotocellCore

/// Relógio de referência: os PTS dos quadros estão no `synchronizationClock` da sessão (em câmera
/// única, o host clock = `mach_absolute_time`). O "agora" do cronômetro lê o mesmo relógio, então
/// `elapsed = now − PTS_start` não precisa de conversão. Nunca use `Date()`/`CACurrentMediaTime()`
/// para os eventos — só para exibir o cronômetro em andamento.
struct SessionClock {
    let clock: CMClock

    init(session: AVCaptureSession?) {
        if let s = session, let c = s.synchronizationClock {
            clock = c
        } else {
            clock = CMClockGetHostTimeClock()
        }
    }

    /// Agora, em nanossegundos do relógio da sessão.
    func nowNs() -> Nanos {
        Self.nanos(CMClockGetTime(clock))
    }

    /// Converte um `CMTime` (PTS) para nanossegundos inteiros, uma única vez na fronteira.
    static func nanos(_ t: CMTime) -> Nanos {
        CMTimeConvertScale(t, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
    }

    /// PTS do quadro no relógio da sessão.
    static func presentationNanos(of sampleBuffer: CMSampleBuffer) -> Nanos {
        nanos(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }
}
