package br.com.tportooliveira.fotocelula.core

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.math.abs

/**
 * Varredura física: milhares de cenários sintéticos (velocidade × exposição × ruído × sentido ×
 * fase do cruzamento × contraste × flicker × textura) executando o pipeline inteiro. Cada cenário
 * precisa disparar; o refinamento precisa ficar dentro da tolerância quando declara qualidade 2 e a
 * verdade precisa cair dentro do intervalo quando declara qualidade 1; agregados apertados nas cenas
 * limpas. A textura (pelagem/sela) é o efeito real que mais degrada o estimador: com ela o resultado
 * pode cair para intervalo ou tempo do quadro, mas NUNCA para um número falso.
 */
class PhysicsSweepTest {
    private data class Case(val speed: Double, val expo: Long, val noise: Double, val dir: Int, val frac: Double, val obj: Int, val flicker: Double, val tex: Double)

    private fun cases(): List<Case> {
        val speeds = listOf(8.0, 11.0, 14.0, 18.0)
        val expos = listOf(4_166_666L, 2_083_333L, 500_000L, 250_000L)
        val noises = listOf(0.5, 1.5, 3.0)
        val fracs = listOf(0.05, 0.25, 0.5, 0.75, 0.95)
        val objs = listOf(140, 184)
        val flickers = listOf(0.0, 0.12)
        val textures = listOf(0.0, 30.0)
        val out = ArrayList<Case>()
        for (s in speeds) for (e in expos) for (n in noises) for (d in listOf(1, -1)) for (f in fracs) for (o in objs) for (fl in flickers) for (tx in textures)
            out.add(Case(s, e, n, d, f, o, fl, tx))
        return out
    }

    @Test
    fun sweepAllScenarios() {
        val all = cases()
        val failures = ArrayList<String>()
        var triggered = 0; var q2 = 0; var q1 = 0
        // Cenários favoráveis: sem textura, exposição ≥ P/2 (o bordo é visto dentro da janela) e SNR suficiente
        // para pixels interiores (σ=3 com contraste 44 dá margem 0,39 > 0,25: só limites, por projeto).
        var favorable = 0; var favorableQ2 = 0
        var texQ2 = 0; var texQ1 = 0; var texQ0 = 0
        val errs = ArrayList<Double>()       // |erro| dos q2 sem textura
        val errsTex = ArrayList<Double>()    // |erro| dos q2 com textura
        var seed = 1000L
        for (c in all) {
            seed += 7
            val r = SimulationHarness.runCrossing(c.speed, c.expo, c.noise, c.dir, c.frac, c.obj, c.flicker, seed, texture = c.tex)
            if (!r.triggered) { failures.add("sem gatilho: $c (T=${"%.2f".format(r.threshold)}, estado ${r.finalState})"); continue }
            triggered++
            if (c.tex == 0.0 && c.expo >= 2_083_333L && (c.noise <= 1.5 || c.obj >= 184)) { favorable++; if (r.quality == 2) favorableQ2++ }
            val errMs = r.refinedErrorNs / 1e6
            val uncMs = r.uncertaintyNs / 1e6
            when (r.quality) {
                2 -> {
                    q2++
                    if (c.tex == 0.0) errs.add(abs(errMs)) else { texQ2++; errsTex.add(abs(errMs)) }
                    if (abs(errMs) > maxOf(0.35, uncMs + 0.1) || abs(errMs) > 0.6)
                        failures.add("q2 erro %.3f ms (±%.3f, tex=%d): %s".format(errMs, uncMs, r.texturedColumns, c))
                }
                1 -> {
                    q1++
                    if (c.tex > 0.0) texQ1++
                    if (abs(r.refinedErrorNs) > r.uncertaintyNs + 100_000) failures.add("q1 verdade fora do intervalo (%.3f ± %.3f ms, tex=%d): %s".format(errMs, uncMs, r.texturedColumns, c))
                }
                else -> {
                    if (c.tex > 0.0) texQ0++
                    if (abs(r.refinedErrorNs) > 4_200_000L) failures.add("q0 erro %.3f ms: %s".format(errMs, c))
                }
            }
        }
        val sorted = errs.sorted()
        val mean = if (errs.isEmpty()) 0.0 else errs.average()
        val p95 = if (sorted.isEmpty()) 0.0 else sorted[(sorted.size * 0.95).toInt().coerceAtMost(sorted.size - 1)]
        val meanTex = if (errsTex.isEmpty()) 0.0 else errsTex.average()
        val summary = ("cenários=${all.size} disparos=$triggered q2=$q2 q1=$q1 q2(favoráveis)=$favorableQ2/$favorable " +
            "|erro| médio=%.4f ms p95=%.4f ms max=%.4f ms | textura: q2=$texQ2 (|erro| médio %.4f ms) q1=$texQ1 q0=$texQ0")
            .format(mean, p95, sorted.lastOrNull() ?: 0.0, meanTex)
        println("[PhysicsSweep] $summary")
        assertTrue(failures.isEmpty(), "Falhas (${failures.size}):\n" + failures.take(25).joinToString("\n") + "\n$summary")
        assertTrue(triggered >= all.size * 0.98, "taxa de disparo baixa: $summary")
        assertTrue(favorableQ2 >= favorable * 0.95, "poucos refinamentos completos nos cenários favoráveis: $summary")
        // Sem textura, mais da metade dos cenários (incluindo exposições curtas e ruído alto) fecha em qualidade 2.
        // Com textura o estimador é honesto por projeto: cai para intervalo ou quadro, nunca declara precisão falsa.
        val clean = triggered - texQ2 - texQ1 - texQ0
        assertTrue(errs.size >= clean * 0.55, "poucos refinamentos completos sem textura: $summary")
        assertTrue(mean < 0.10, "erro médio alto: $summary")
        assertTrue(p95 < 0.25, "p95 alto: $summary")
    }

    @Test
    fun dropsNearTriggerAreFlaggedAndDoNotBreakTiming() {
        val r = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 77, dropFrames = setOf(44, 45))
        assertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 200_000, "drop: $r")
    }

    @Test
    fun dropRightAtTriggerUsesMeasuredFrameOffsets() {
        // quadro c+1 perdido: o quadro "seguinte" chega 2 períodos depois; o estimador usa o timestamp medido,
        // não ±lag·P, e continua exato
        val r = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, -1, 0.61, 184, 0.0, 78, dropFrames = setOf(49))
        assertTrue(r.triggered && r.quality == 2 && abs(r.refinedErrorNs) < 300_000, "drop no gatilho: $r")
    }

    @Test
    fun unknownSkewOnlyAddsConstantOffset() {
        val a = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 91, knownSkew = false)
        val b = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, -1, 0.61, 184, 0.0, 92, knownSkew = false)
        assertTrue(a.quality == 2 && b.quality == 2, "$a $b")
        assertTrue(abs(a.refinedErrorNs) < 200_000 && abs(b.refinedErrorNs) < 200_000, "offset não cancelou: $a / $b")
    }

    @Test
    fun gammaCorrectionRemovesToneCurveBias() {
        // cena com curva de tom 2,2: sem correção o viés é ~-0,07 ms (constante, cancela em ΔT); com cfg.gamma = 2,2 some
        val without = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 93, sceneGamma = 2.2, cfgGamma = 1.0)
        val with = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, 1, 0.37, 184, 0.0, 93, sceneGamma = 2.2, cfgGamma = 2.2)
        assertTrue(without.quality == 2 && with.quality == 2, "$without $with")
        assertTrue(abs(with.refinedErrorNs) < abs(without.refinedErrorNs) && abs(with.refinedErrorNs) < 50_000, "gamma: $without → $with")
    }

    @Test
    fun heavyTextureNeverProducesFalsePrecision() {
        // textura ±60 em contraste 88: o estimador tem de cair para intervalo/quadro, nunca declarar qualidade 2 errada
        var bad = 0
        for ((k, dirFrac) in listOf(1 to 0.05, 1 to 0.37, -1 to 0.61, -1 to 0.9, 1 to 0.75, -1 to 0.25).withIndex()) {
            val r = SimulationHarness.runCrossing(14.0, 2_083_333L, 1.5, dirFrac.first, dirFrac.second, 184, 0.0, 200L + k, texture = 60.0)
            assertTrue(r.triggered, "sem gatilho com textura: $r")
            val err = abs(r.refinedErrorNs)
            if (r.quality == 2 && err > r.uncertaintyNs + 100_000) bad++
            if (r.quality == 1 && err > r.uncertaintyNs + 100_000) bad++
        }
        assertTrue(bad == 0, "$bad resultados com precisão falsa sob textura pesada")
    }
}
