import Foundation

/// Calcula a variação de luminância na faixa (ROI) a partir do plano Y de cada quadro.
///
/// Mantém apenas as duas últimas faixas (c−1 e c−2) e as referências de fundo — nunca o quadro
/// inteiro. Os buffers são alocados uma vez no `init` e liberados no `deinit`; o caminho quente
/// usa ponteiros crus e aritmética de stride: Endereço(x, y) = base + y*stride + x.
///
/// Com `lag == 2` (flicker de 120 Hz a 240 FPS) a comparação é feita com o quadro de mesma fase
/// de iluminação e a referência de fundo é separada por paridade do quadro.
public final class StripDifferencer {
    public let roi: RoiRect
    public let planeHeight: Int
    public let coreWidth: Int
    public private(set) var lag: Int = 1

    private let w: Int
    private let h: Int
    private let n: Int
    private let c0: Int

    // três buffers rotativos (atual, c−1, c−2) alocados uma vez
    private let buffers: [UnsafeMutablePointer<UInt8>]
    private var nextBuf = 0
    private var prev1: UnsafeMutablePointer<UInt8>? = nil
    private var prev2: UnsafeMutablePointer<UInt8>? = nil
    private var background: [UnsafeMutablePointer<Double>?] = [nil, nil]
    private var frameIndex = 0

    public init(roi: RoiRect, planeWidth: Int, planeHeight: Int, coreWidth: Int) throws {
        try roi.validate(planeWidth: planeWidth, planeHeight: planeHeight, coreWidth: coreWidth)
        self.roi = roi
        self.planeHeight = planeHeight
        self.coreWidth = coreWidth
        w = roi.width
        h = roi.height
        n = w * h
        c0 = (w - coreWidth) / 2
        buffers = (0..<3).map { _ in
            let p = UnsafeMutablePointer<UInt8>.allocate(capacity: n)
            p.initialize(repeating: 0, count: n)
            return p
        }
    }

    deinit {
        for b in buffers { b.deallocate() }
        for bg in background { bg?.deallocate() }
    }

    public func reset() {
        prev1 = nil
        prev2 = nil
        for i in 0..<2 {
            background[i]?.deallocate()
            background[i] = nil
        }
        frameIndex = 0
    }

    public func setLag(_ newLag: Int) {
        let l = newLag == 2 ? 2 : 1
        if l != lag {
            // as referências acumuladas misturam fases de iluminação: ressemear por paridade
            for i in 0..<2 {
                background[i]?.deallocate()
                background[i] = nil
            }
        }
        lag = l
    }

    @inline(__always)
    private func bgIndex(_ frameIdx: Int) -> Int { lag == 2 ? (frameIdx & 1) : 0 }

    private func takeBuffer() -> UnsafeMutablePointer<UInt8> {
        let b = buffers[nextBuf]
        nextBuf = (nextBuf + 1) % 3
        return b
    }

    /// Processa o plano Y de um quadro. `plane` é o endereço base do plano 0 e `stride` os bytes por
    /// linha (`CVPixelBufferGetBytesPerRowOfPlane(_, 0)`). Retorna nil para quadros-semente
    /// (1 com lag 1, 2 com lag 2).
    public func process(plane: UnsafePointer<UInt8>, stride: Int, tsNs: Nanos) -> FrameMeasurement? {
        let cur = takeBuffer()
        // extração da faixa: Endereço(x, y) = base + y*stride + x
        var k = 0
        for y in roi.y0..<roi.y1 {
            let rowPtr = plane + (y * stride + roi.x)
            for i in 0..<w {
                cur[k] = rowPtr[i]
                k += 1
            }
        }
        let idxFrame = frameIndex
        frameIndex += 1
        let bi = bgIndex(idxFrame)
        if background[bi] == nil {
            let bg = UnsafeMutablePointer<Double>.allocate(capacity: n)
            for i in 0..<n { bg[i] = Double(cur[i]) }
            background[bi] = bg
        }
        let refOpt = lag == 1 ? prev1 : prev2
        guard let ref = refOpt else {
            prev2 = prev1
            prev1 = cur
            return nil
        }
        let bg = background[bi]!
        var sumFull: Int = 0
        var sumCore: Int = 0
        var sumBg: Double = 0.0
        var rowCore = [Double](repeating: 0, count: h)
        for row in 0..<h {
            let o = row * w
            var rowSumCore = 0
            for i in 0..<w {
                var d = Int(cur[o + i]) - Int(ref[o + i])
                if d < 0 { d = -d }
                sumFull += d
                sumBg += abs(Double(cur[o + i]) - bg[o + i])
            }
            for i in c0..<(c0 + coreWidth) {
                var d = Int(cur[o + i]) - Int(ref[o + i])
                if d < 0 { d = -d }
                rowSumCore += d
            }
            sumCore += rowSumCore
            rowCore[row] = Double(rowSumCore) / Double(coreWidth)
        }
        var lag2: Double? = nil
        if lag == 1, let p2 = prev2 {
            var s2 = 0
            for i in 0..<n {
                var d = Int(cur[i]) - Int(p2[i])
                if d < 0 { d = -d }
                s2 += d
            }
            lag2 = Double(s2) / Double(n)
        }
        let m = FrameMeasurement(
            tsNs: tsNs,
            deltaFull: Double(sumFull) / Double(n),
            deltaCore: Double(sumCore) / Double(coreWidth * h),
            deltaBackground: sumBg / Double(n),
            rowCore: rowCore,
            stripPrev: Array(UnsafeBufferPointer(start: ref, count: n)),
            stripCur: Array(UnsafeBufferPointer(start: cur, count: n)),
            stripBg: Array(UnsafeBufferPointer(start: bg, count: n)),
            deltaFullLag2: lag2,
            lag: lag
        )
        prev2 = prev1
        prev1 = cur
        return m
    }

    /// EMA lenta da referência de fundo (da paridade do último quadro) com a faixa atual.
    public func updateBackground(alpha: Double) {
        guard let cur = prev1, let bg = background[bgIndex(frameIndex - 1)] else { return }
        for i in 0..<n {
            bg[i] = bg[i] + alpha * (Double(cur[i]) - bg[i])
        }
    }
}
