import Foundation

/// Faixa vertical (Região de Interesse) em coordenadas de pixel do plano Y (não rotacionado).
/// `y1` é exclusivo. Endereço(x, y) = base + y*stride + x.
public struct RoiRect: Equatable, Codable, Sendable {
    public var x: Int
    public var width: Int
    public var y0: Int
    public var y1: Int

    public init(x: Int, width: Int, y0: Int, y1: Int) {
        self.x = x; self.width = width; self.y0 = y0; self.y1 = y1
    }

    public var height: Int { y1 - y0 }

    public func coreX0(coreWidth: Int) -> Int { x + (width - coreWidth) / 2 }

    public enum ValidationError: Error, Equatable {
        case empty, outsideX, outsideY, invalidCoreWidth
    }

    public func validate(planeWidth: Int, planeHeight: Int, coreWidth: Int) throws {
        if width < 1 || height < 1 { throw ValidationError.empty }
        if x < 0 || x + width > planeWidth { throw ValidationError.outsideX }
        if y0 < 0 || y1 > planeHeight { throw ValidationError.outsideY }
        if coreWidth < 1 || coreWidth > width { throw ValidationError.invalidCoreWidth }
    }
}
