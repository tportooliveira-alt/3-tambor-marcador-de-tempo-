package br.com.tportooliveira.fotocelula.results

import br.com.tportooliveira.fotocelula.core.RunResult
import br.com.tportooliveira.fotocelula.core.TimeFormatter
import org.json.JSONObject
import java.util.UUID

/** Registro de uma passada (JSON em arquivo interno; exportável em CSV). O vídeo nunca é gravado. */
data class RunRecord(
    val id: String = UUID.randomUUID().toString(),
    val dateMillis: Long = System.currentTimeMillis(),
    val rider: String = "",
    val horse: String = "",
    val elapsedRawNs: Long,
    val elapsedRefinedNs: Long,
    val barrelsKnocked: Int = 0,
    val noTime: Boolean = false,
    val degraded: Boolean,
    val drops: Int,
    val startQuality: Int,
    val finishQuality: Int,
    val startUncertaintyNs: Long,
    val finishUncertaintyNs: Long,
    val thresholdStart: Double,
    val thresholdFinish: Double,
    val referenceLag: Int,
    val exposureNs: Long,
    val iso: Int,
    val mode: String,
    val notes: String = "",
) {
    val penaltyNs: Long get() = barrelsKnocked * 5_000_000_000L
    val finalRefinedNs: Long get() = elapsedRefinedNs + penaltyNs
    val finalText: String get() = if (noTime) "SAT" else TimeFormatter.formatElapsed(finalRefinedNs)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("dateMillis", dateMillis); put("rider", rider); put("horse", horse)
        put("elapsedRawNs", elapsedRawNs); put("elapsedRefinedNs", elapsedRefinedNs)
        put("barrelsKnocked", barrelsKnocked); put("noTime", noTime); put("degraded", degraded); put("drops", drops)
        put("startQuality", startQuality); put("finishQuality", finishQuality)
        put("startUncertaintyNs", startUncertaintyNs); put("finishUncertaintyNs", finishUncertaintyNs)
        put("thresholdStart", thresholdStart); put("thresholdFinish", thresholdFinish)
        put("referenceLag", referenceLag); put("exposureNs", exposureNs); put("iso", iso); put("mode", mode); put("notes", notes)
    }

    companion object {
        fun from(r: RunResult, lag: Int, exposureNs: Long, iso: Int, mode: String) = RunRecord(
            elapsedRawNs = r.elapsedRawNs, elapsedRefinedNs = r.elapsedRefinedNs, degraded = r.degraded, drops = r.drops,
            startQuality = r.start.quality, finishQuality = r.finish.quality,
            startUncertaintyNs = r.start.uncertaintyNs, finishUncertaintyNs = r.finish.uncertaintyNs,
            thresholdStart = r.thresholdStart, thresholdFinish = r.thresholdFinish, referenceLag = lag,
            exposureNs = exposureNs, iso = iso, mode = mode,
        )

        fun fromJson(j: JSONObject) = RunRecord(
            id = j.getString("id"), dateMillis = j.getLong("dateMillis"), rider = j.optString("rider"), horse = j.optString("horse"),
            elapsedRawNs = j.getLong("elapsedRawNs"), elapsedRefinedNs = j.getLong("elapsedRefinedNs"),
            barrelsKnocked = j.optInt("barrelsKnocked"), noTime = j.optBoolean("noTime"), degraded = j.optBoolean("degraded"),
            drops = j.optInt("drops"), startQuality = j.optInt("startQuality"), finishQuality = j.optInt("finishQuality"),
            startUncertaintyNs = j.optLong("startUncertaintyNs"), finishUncertaintyNs = j.optLong("finishUncertaintyNs"),
            thresholdStart = j.optDouble("thresholdStart"), thresholdFinish = j.optDouble("thresholdFinish"),
            referenceLag = j.optInt("referenceLag", 1), exposureNs = j.optLong("exposureNs"), iso = j.optInt("iso"),
            mode = j.optString("mode"), notes = j.optString("notes"),
        )
    }
}
