#!/usr/bin/env python3
"""
Regra de classificação de uma prova (referência; Kotlin e Swift portam isto).

É a única parte do produto que não vem da física da medição, mas ainda assim precisa ser idêntica nas
duas plataformas — daí morar aqui e ser conferida por um vetor compartilhado (`event_ranking.json`).

Regra:
  tempo final = tempo REFINADO da passada + 5 s por tambor derrubado;
  "sem tempo" (SAT) fica sempre por último, sem colocação;
  empate resolve pelo tempo bruto e, persistindo, pela ordem de largada.

O tempo refinado é sempre o usado (mesmo em qualidade 0, onde ele é o centro do intervalo físico do
gatilho): é o mesmo número que o app mostra na tela, e classificar por outro seria mentir para o
competidor.
"""
from dataclasses import dataclass, field
from typing import List, Optional

PENALTY_PER_BARREL_NS = 5_000_000_000


@dataclass
class Run:
    """O mínimo de uma passada para classificar (espelha RunRecord nas duas plataformas)."""
    entry_order: int                 # número de largada
    elapsed_refined_ns: int
    elapsed_raw_ns: int
    barrels_knocked: int = 0
    no_time: bool = False
    category: str = ""
    rider: str = ""


@dataclass
class Placing:
    entry_order: int
    place: Optional[int]             # None para SAT
    final_ns: int
    penalty_ns: int


def penalty_ns(run: Run) -> int:
    return run.barrels_knocked * PENALTY_PER_BARREL_NS


def final_ns(run: Run) -> int:
    """Tempo que vale para a classificação (refinado + penalidade). SAT não tem tempo válido."""
    return run.elapsed_refined_ns + penalty_ns(run)


def rank(runs: List[Run]) -> List[Placing]:
    """
    Classifica uma lista de passadas (já filtrada por categoria, se for o caso). Ordem estável e
    determinística nas três linguagens: SAT por último; depois tempo final, tempo bruto, ordem de
    largada.
    """
    def key(r: Run):
        return (1 if r.no_time else 0, final_ns(r), r.elapsed_raw_ns, r.entry_order)

    out: List[Placing] = []
    place = 0
    for r in sorted(runs, key=key):
        if r.no_time:
            out.append(Placing(r.entry_order, None, 0, penalty_ns(r)))
        else:
            place += 1
            out.append(Placing(r.entry_order, place, final_ns(r), penalty_ns(r)))
    return out


def rank_by_category(runs: List[Run]) -> List[Placing]:
    """Classifica dentro de cada categoria; a saída sai agrupada por categoria (ordem alfabética)."""
    out: List[Placing] = []
    for cat in sorted({r.category for r in runs}):
        out.extend(rank([r for r in runs if r.category == cat]))
    return out
