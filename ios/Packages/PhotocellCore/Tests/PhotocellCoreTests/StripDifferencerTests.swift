import XCTest
@testable import PhotocellCore

/// Testes unitários locais do differencer (stride, sentinela, semente, ROI nos limites).
final class StripDifferencerTests: XCTestCase {
    let planeW = 32
    let planeH = 64
    let stride = 40   // > largura: bytes de preenchimento nunca podem ser lidos

    private func plane(_ fill: UInt8, band: UInt8? = nil, roi: RoiRect? = nil) -> [UInt8] {
        var b = [UInt8](repeating: 0xEE, count: stride * planeH)
        for y in 0..<planeH { for x in 0..<planeW { b[y * stride + x] = fill } }
        if let band = band, let r = roi {
            for y in r.y0..<r.y1 { for x in r.x..<(r.x + r.width) { b[y * stride + x] = band } }
        }
        return b
    }

    private func process(_ d: StripDifferencer, _ p: [UInt8], _ ts: Nanos) -> FrameMeasurement? {
        p.withUnsafeBufferPointer { d.process(plane: $0.baseAddress!, stride: stride, tsNs: ts) }
    }

    func testSeedThenExactDifference() throws {
        let roi = RoiRect(x: 10, width: 9, y0: 8, y1: 40)
        let d = try StripDifferencer(roi: roi, planeWidth: planeW, planeHeight: planeH, coreWidth: 3)
        XCTAssertNil(process(d, plane(16), 0))
        let m = try XCTUnwrap(process(d, plane(26), 4_166_666))
        XCTAssertEqual(m.deltaFull, 10.0, accuracy: 1e-12)
        XCTAssertEqual(m.deltaCore, 10.0, accuracy: 1e-12)
        XCTAssertEqual(m.deltaBackground, 10.0, accuracy: 1e-12)
        XCTAssertEqual(m.prevTsNs, 0, "timestamp do quadro de referência")
    }

    func testSentinelPaddingIsNeverRead() throws {
        let roi = RoiRect(x: planeW - 9, width: 9, y0: 0, y1: planeH)
        let d = try StripDifferencer(roi: roi, planeWidth: planeW, planeHeight: planeH, coreWidth: 3)
        _ = process(d, plane(50), 0)
        let m = try XCTUnwrap(process(d, plane(50), 1))
        XCTAssertEqual(m.deltaFull, 0.0)
    }

    func testHalfRowsChanged() throws {
        let roi = RoiRect(x: 0, width: 5, y0: 0, y1: 10)
        let d = try StripDifferencer(roi: roi, planeWidth: planeW, planeHeight: planeH, coreWidth: 1)
        _ = process(d, plane(100), 0)
        let half = RoiRect(x: 0, width: 5, y0: 0, y1: 5)
        let m = try XCTUnwrap(process(d, plane(100, band: 120, roi: half), 1))
        XCTAssertEqual(m.deltaFull, 10.0, accuracy: 1e-12)
    }

    func testResetReseeds() throws {
        let roi = RoiRect(x: 4, width: 7, y0: 4, y1: 20)
        let d = try StripDifferencer(roi: roi, planeWidth: planeW, planeHeight: planeH, coreWidth: 3)
        _ = process(d, plane(10), 0)
        XCTAssertNotNil(process(d, plane(10), 1))
        d.reset()
        XCTAssertNil(process(d, plane(10), 2))
    }

    func testLagTwoNeedsTwoSeeds() throws {
        let roi = RoiRect(x: 4, width: 7, y0: 4, y1: 20)
        let d = try StripDifferencer(roi: roi, planeWidth: planeW, planeHeight: planeH, coreWidth: 3)
        d.setLag(2)
        XCTAssertNil(process(d, plane(10), 0))
        XCTAssertNil(process(d, plane(12), 1))
        let m = try XCTUnwrap(process(d, plane(13), 2))
        XCTAssertEqual(m.deltaFull, 3.0, accuracy: 1e-12)   // compara com o quadro c−2 (10)
        XCTAssertEqual(m.lag, 2)
    }

    func testInvalidRoiRejected() {
        XCTAssertThrowsError(try StripDifferencer(roi: RoiRect(x: 30, width: 9, y0: 0, y1: 10),
                                                  planeWidth: planeW, planeHeight: planeH, coreWidth: 3))
        XCTAssertThrowsError(try StripDifferencer(roi: RoiRect(x: 0, width: 3, y0: 0, y1: 10),
                                                  planeWidth: planeW, planeHeight: planeH, coreWidth: 5))
    }

    func testPerformanceStrip1080x40() throws {
        let h = 1080, w = 40, st = 1280
        let roi = RoiRect(x: 600, width: w, y0: 0, y1: h)
        let d = try StripDifferencer(roi: roi, planeWidth: st, planeHeight: h, coreWidth: 3)
        let p = [UInt8](repeating: 77, count: st * h)
        p.withUnsafeBufferPointer { _ = d.process(plane: $0.baseAddress!, stride: st, tsNs: 0) }
        measure {
            p.withUnsafeBufferPointer { _ = d.process(plane: $0.baseAddress!, stride: st, tsNs: 1) }
        }
    }
}
