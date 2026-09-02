import Foundation

public enum TimeFormatter {
    /// nanos → "S.mmm" (arredondamento half-up para milésimos). Negativo vira "0.000".
    public static func formatElapsed(_ ns: Nanos) -> String {
        let v = ns < 0 ? 0 : ns
        let ms = (v + 500_000) / 1_000_000
        let s = ms / 1000
        let rem = Int(ms % 1000)
        return "\(s)." + String(format: "%03d", rem)
    }

    /// "M:SS.mmm" para mostradores grandes.
    public static func formatClock(_ ns: Nanos) -> String {
        let v = ns < 0 ? 0 : ns
        let ms = (v + 500_000) / 1_000_000
        let totalS = ms / 1000
        let m = totalS / 60
        let s = Int(totalS % 60)
        let rem = Int(ms % 1000)
        return "\(m):" + String(format: "%02d", s) + "." + String(format: "%03d", rem)
    }
}
