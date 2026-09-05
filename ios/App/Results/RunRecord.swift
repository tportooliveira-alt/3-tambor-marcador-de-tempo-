import Foundation
import PhotocellCore

/// Registro de uma passada (persistido em JSON; exportável em CSV). O vídeo nunca é gravado.
struct RunRecord: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var date: Date = Date()
    var rider: String = ""
    var horse: String = ""
    var elapsedRawNs: Int64
    var elapsedRefinedNs: Int64
    var barrelsKnocked: Int = 0
    var noTime: Bool = false
    /// Vínculo opcional com a prova (nulo em passada avulsa). Opcionais de propósito: o histórico
    /// gravado antes do modo evento continua decodificando (o Codable sintetizado usa
    /// `decodeIfPresent` só para opcionais).
    var eventId: UUID?
    var entryId: UUID?
    /// Copiados da inscrição ao salvar: a classificação sobrevive a apagar a inscrição.
    var category: String?
    var entryOrder: Int?
    var degraded: Bool
    var drops: Int
    var startQuality: Int
    var finishQuality: Int
    var startUncertaintyNs: Int64
    var finishUncertaintyNs: Int64
    var thresholdStart: Double
    var thresholdFinish: Double
    var referenceLag: Int
    var exposureNs: Int64
    var iso: Float
    var formatWidth: Int
    var formatHeight: Int
    var fps: Double
    var notes: String = ""

    static let penaltyPerBarrelNs: Int64 = EventScoring.penaltyPerBarrelNs

    var penaltyNs: Int64 { Int64(barrelsKnocked) * Self.penaltyPerBarrelNs }
    var finalRawNs: Int64 { elapsedRawNs + penaltyNs }
    var finalRefinedNs: Int64 { elapsedRefinedNs + penaltyNs }

    var finalText: String {
        noTime ? "SAT" : TimeFormatter.formatElapsed(finalRefinedNs)
    }

    /// Converte para o mínimo que a regra de classificação precisa (núcleo compartilhado).
    var scoringRun: EventScoring.Run {
        EventScoring.Run(entryOrder: entryOrder ?? 0, elapsedRefinedNs: elapsedRefinedNs,
                         elapsedRawNs: elapsedRawNs, barrelsKnocked: barrelsKnocked,
                         noTime: noTime, category: category ?? "")
    }

    init(result: RunResult, capture: ActiveCaptureInfo, lag: Int) {
        elapsedRawNs = result.elapsedRawNs
        elapsedRefinedNs = result.elapsedRefinedNs
        degraded = result.degraded
        drops = result.drops
        startQuality = result.start.quality
        finishQuality = result.finish.quality
        startUncertaintyNs = result.start.uncertaintyNs
        finishUncertaintyNs = result.finish.uncertaintyNs
        thresholdStart = result.thresholdStart
        thresholdFinish = result.thresholdFinish
        referenceLag = lag
        exposureNs = capture.exposureNs
        iso = capture.iso
        formatWidth = capture.width
        formatHeight = capture.height
        fps = capture.fps
    }
}
