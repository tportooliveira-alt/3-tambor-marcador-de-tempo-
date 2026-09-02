import AVFoundation
import Foundation
import PhotocellCore

/// Bipe curto (gerado em memória, sem arquivo de áudio) + flash na tela na largada e na chegada.
/// O áudio é pré-carregado para que a latência do feedback não importe (o tempo já foi medido pelo PTS).
final class TriggerFeedback {
    private var single: AVAudioPlayer?
    private var double: AVAudioPlayer?

    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        single = Self.player(for: Self.makeBeepWav(frequency: 1500, beeps: 1))
        double = Self.player(for: Self.makeBeepWav(frequency: 1500, beeps: 2))
    }

    func play(_ kind: Effect.FeedbackKind) {
        let p = (kind == .start) ? single : double
        p?.currentTime = 0
        p?.play()
    }

    private static func player(for data: Data) -> AVAudioPlayer? {
        let p = try? AVAudioPlayer(data: data)
        p?.prepareToPlay()
        p?.volume = 1.0
        return p
    }

    /// WAV PCM 16 bits mono 44,1 kHz com `beeps` tons de 70 ms separados por 60 ms.
    private static func makeBeepWav(frequency: Double, beeps: Int) -> Data {
        let rate = 44_100.0
        let toneSamples = Int(rate * 0.07)
        let gapSamples = Int(rate * 0.06)
        var samples: [Int16] = []
        for b in 0..<beeps {
            for i in 0..<toneSamples {
                let t = Double(i) / rate
                let env = min(1.0, Double(i) / 200.0, Double(toneSamples - i) / 200.0)
                samples.append(Int16(sin(2 * .pi * frequency * t) * 0.8 * env * 32767))
            }
            if b < beeps - 1 { samples.append(contentsOf: [Int16](repeating: 0, count: gapSamples)) }
        }
        var data = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; data.append(Data(bytes: &x, count: 2)) }
        let byteCount = UInt32(samples.count * 2)
        data.append("RIFF".data(using: .ascii)!); u32(36 + byteCount); data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        data.append("data".data(using: .ascii)!); u32(byteCount)
        samples.withUnsafeBufferPointer { data.append(Data(buffer: $0)) }
        return data
    }
}
