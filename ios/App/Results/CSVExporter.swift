import Foundation
import PhotocellCore

/// Exporta o histórico em CSV (separador ";" e vírgula decimal, formato Excel pt-BR).
enum CSVExporter {
    static func makeCSV(_ records: [RunRecord]) -> String {
        let header = ["data", "competidor", "cavalo", "tempo_final", "tempo_bruto_s", "tempo_refinado_s",
                      "tambores_derrubados", "penalidade_s", "sem_tempo", "degradada", "drops",
                      "qualidade_largada", "qualidade_chegada", "incerteza_largada_ms", "incerteza_chegada_ms",
                      "limiar_largada", "limiar_chegada", "lag_referencia", "exposicao_us", "iso",
                      "formato", "fps", "observacoes"]
        let df = ISO8601DateFormatter()
        var lines = [header.joined(separator: ";")]
        for r in records {
            let fields: [String] = [
                df.string(from: r.date),
                quote(r.rider), quote(r.horse),
                r.finalText.replacingOccurrences(of: ".", with: ","),
                dec(Double(r.elapsedRawNs) / 1e9, 3), dec(Double(r.elapsedRefinedNs) / 1e9, 4),
                "\(r.barrelsKnocked)", "\(r.barrelsKnocked * 5)", r.noTime ? "sim" : "não",
                r.degraded ? "sim" : "não", "\(r.drops)",
                "\(r.startQuality)", "\(r.finishQuality)",
                dec(Double(r.startUncertaintyNs) / 1e6, 3), dec(Double(r.finishUncertaintyNs) / 1e6, 3),
                dec(r.thresholdStart, 2), dec(r.thresholdFinish, 2), "\(r.referenceLag)",
                "\(r.exposureNs / 1000)", dec(Double(r.iso), 0),
                "\(r.formatWidth)x\(r.formatHeight)", dec(r.fps, 1), quote(r.notes),
            ]
            lines.append(fields.joined(separator: ";"))
        }
        return lines.joined(separator: "\n") + "\n"
    }

    static func writeTemporaryFile(_ records: [RunRecord]) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("fotocelula-tambor.csv")
        try makeCSV(records).data(using: .utf8)!.write(to: url, options: .atomic)
        return url
    }

    private static func dec(_ v: Double, _ places: Int) -> String {
        String(format: "%.\(places)f", v).replacingOccurrences(of: ".", with: ",")
    }

    private static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}
