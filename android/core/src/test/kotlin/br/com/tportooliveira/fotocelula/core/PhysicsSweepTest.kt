package br.com.tportooliveira.fotocelula.core

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

/**
 * Varredura física: centenas de cenários sintéticos (velocidade × exposição × ruído × sentido ×
 * fase do cruzamento × contraste × flicker) executando o pipeline inteiro. Cada cenário precisa
 * disparar e o refinamento sub-quadro precisa ficar dentro da tolerância; agregados apertados.
 */
class PhysicsSweepTest {
    private data class Case(val speed: Double, val expo: Long, val noise: Double, val dir: Int, val frac: Double, val obj: Int, val flicker: Double)

    private fun cases(): List<Case> {
        val speeds = listOf(8.0, 11.0, 14.0, 18.0)
        val expos = listOf(4_166_666L, 2_083_333L, 500_000L, 250_000L)
        val noises = listOf(0.5, 1.5, 3.0)
        val fracs = listOf(0.05, 0.25, 0.5, 0.75, 0.95)
        val objs = listOf(140, 184)
        val flickers = listOf(0.0, 0.12)
        val out = ArrayList<Case>()
        for (s in speeds) for (e in expos) for (n in noises) for (d in listOf(1, -1)) for (f in fracs) for (o in objs) for (fl in flickers)
            out.add(Case(s, e, n, d, f, o, fl))
        return out
    }

    @Test
    fun sweepAllScenarios() {
        val all = cases()
        val failures = ArrayList<String>()
        var triggered = 0; var q2 = 0; var q1 = 0
        // Cenários favoráveis: exposição ≥ P/2 (o bordo é visto dentro da janela) e SNR suficiente para pixels
        // interiores (σ=3 com contraste 44 dá margem 0,39 > 0,25: só limites, por projeto).
        var favorable = 0; var favorableQ2 = 0
        val errs = ArrayList<Double>()
        var seed = 1000L
        for (c in all) {
            seed += 7
            val r = SimulationHarness.runCrossing(c.speed, c.expo, c.noise, c.dir, c.frac, c.obj, c.flicker, seed)
            if (!r.triggered) { failures.add("sem gatilho: $c (T=${"%.2f".format(r.threshold)}, estado ${r.finalState})"); continue }
            triggered++
            if (c.expo >= 2_083_333L && (c.noise <= 1.5 || c.obj >= 184)) { favorable++; if (r.quality == 2) favorableQ2++ }
            val errMs = r.refinedErrorNs / 1e6
            when (r.quality) {
                2 -> { q2++; errs.add(abs(errMs)); if (abs(errMs) > maxOf(0.35, r.uncertaintyNs / 1e6 + 0.1)) failures.add("q2 erro %.3f ms (±%.3f): %s".format(errMs, r.uncertaintyNs / 1e6, c)) }
                1 -> { q1++; if (abs(r.refinedErrorNs) > r.uncertaintyNs + 100_000) failures.add("q1 verdade fora do intervalo (%.3f ± %.3f ms): %s".format(errMs, r.uncertaintyNs / 1e6, c)) }
                else -> if (abs(r.refinedErrorNs) > 4_200_000L) failures.add("q0 erro %.3f ms: %s".format(errMs, c))
            }
        }
        val sorted = errs.sorted()
        val mean = if (errs.isEmpty()) 0.0 else errs.average()
        val p95 = if (sorted.isEmpty()) 0.0 else sorted[(sorted.size * 0.95).toInt().coerceAtMost(sorted.size - 1)]
        val summary = "cenários=${all.size} disparos=$triggered q2=$q2 q1=$q1 q2(favoráveis)=$favorableQ2/$favorable |erro| médio=%.4f ms p95=%.4f ms max=%.4f ms".format(mean, p95, sorted.lastOrNull() ?: 0.0)
        println("[PhysicsSweep] $summary")
        assertTrue(failures.isEmpty(), "Falhas (${failures.size}):\n" + failures.take(25).joinToString("\n") + "\n$summary")
        assertTrue(triggered >= all.size * 0.98, "taxa de disparo baixa: $summary")
        // Com exposição curta (1/2000, 1/4000 s) o cruzamento cai fora da janela na maioria dos quadros:
        // só limites/intervalo (qualidade 1) ou tempo do quadro (qualidade 0) — é física, não defeito.
        assertTrue(favorableQ2 >= favorable * 0.95, "poucos refinamentos completos nos cenários favoráveis: $summary")
        assertTrue(q2 >= triggered * 0.55, "poucos refinamentos completos: $summary")
        assertTrue(mean < 0.10, "erro médio alto: $summary")
        assertTrue(p95 < 0.25, "p95 alto: $summary")
    }

    @Test
    fun dropsNearTriggerAreFlaggedAndDoNotBreakTiming() {
        val r = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 77, dropFrames = setOf(44, 45))
        assertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "drop: $r")
    }

    @Test
    fun unknownSkewOnlyAddsConstantOffset() {
        val a = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 91, knownSkew = false)
        val b = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, -1, 0.61, 184, 0.0, 92, knownSkew = false)
        assertTrue(a.quality == 2 && b.quality == 2, "$a $b")
        assertTrue(abs(a.refinedErrorNs) < 200_000 && abs(b.refinedErrorNs) < 200_000, "offset não cancelou: $a / $b")
    }

    @Test
    fun flickerSelectsLagTwo() {
        val r = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.12, 14)
        assertTrue(r.lag == 2, "flicker deveria escolher lag 2: $r")
        assertTrue(r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "flicker: $r")
    }
}
