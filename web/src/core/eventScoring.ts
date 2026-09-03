import type { Nanos } from "./nanos.ts";

/**
 * Regra de classificação de uma prova (porte de `Tools/event_scoring.py`, conferida pelo vetor
 * compartilhado `event_ranking.json` — a mesma dos núcleos Kotlin e Swift).
 *
 * Tempo final = tempo REFINADO da passada + 5 s por tambor derrubado; "sem tempo" (SAT) fica sempre
 * por último, sem colocação; empate resolve pelo tempo bruto e, persistindo, pela ordem de largada.
 */
export const PENALTY_PER_BARREL_NS = 5_000_000_000;

/** O mínimo de uma passada para classificar. */
export interface ScoringRun {
  entryOrder: number;
  elapsedRefinedNs: Nanos;
  elapsedRawNs: Nanos;
  barrelsKnocked: number;
  noTime: boolean;
  category: string;
}

export interface Placing {
  entryOrder: number;
  /** null para SAT (sem colocação). */
  place: number | null;
  finalNs: Nanos;
  penaltyNs: Nanos;
}

export const penaltyNs = (r: ScoringRun): Nanos => r.barrelsKnocked * PENALTY_PER_BARREL_NS;

export const finalNs = (r: ScoringRun): Nanos => r.elapsedRefinedNs + penaltyNs(r);

/** Classifica uma lista já filtrada por categoria. Ordem determinística nas quatro linguagens. */
export function rank(runs: ScoringRun[]): Placing[] {
  // o índice de entrada entra como último desempate: `Array.sort` do JS é estável, mas explicitar
  // mantém a regra idêntica à do Swift (cuja ordenação não é) e à do Kotlin
  const sorted = runs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const na = a.r.noTime ? 1 : 0;
      const nb = b.r.noTime ? 1 : 0;
      if (na !== nb) return na - nb;
      const fa = finalNs(a.r);
      const fb = finalNs(b.r);
      if (fa !== fb) return fa - fb;
      if (a.r.elapsedRawNs !== b.r.elapsedRawNs) return a.r.elapsedRawNs - b.r.elapsedRawNs;
      if (a.r.entryOrder !== b.r.entryOrder) return a.r.entryOrder - b.r.entryOrder;
      return a.i - b.i;
    })
    .map((x) => x.r);
  const out: Placing[] = [];
  let place = 0;
  for (const r of sorted) {
    if (r.noTime) {
      out.push({ entryOrder: r.entryOrder, place: null, finalNs: 0, penaltyNs: penaltyNs(r) });
    } else {
      place += 1;
      out.push({ entryOrder: r.entryOrder, place, finalNs: finalNs(r), penaltyNs: penaltyNs(r) });
    }
  }
  return out;
}

/** Classifica dentro de cada categoria; a saída sai agrupada por categoria (ordem alfabética). */
export function rankByCategory(runs: ScoringRun[]): Placing[] {
  const cats: string[] = [];
  for (const r of runs) if (!cats.includes(r.category)) cats.push(r.category);
  cats.sort();
  const out: Placing[] = [];
  for (const cat of cats) out.push(...rank(runs.filter((r) => r.category === cat)));
  return out;
}
