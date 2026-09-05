/**
 * Testes da conferência contra a cronometragem oficial.
 *
 * `store.ts` e `app.ts` nunca tiveram teste — e foi numa camada sem teste que nasceu o defeito do
 * empacotamento, que deixou o app inteiro morto. As funções desta parte foram postas em
 * `validacao.ts` justamente para serem puras e caberem aqui.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Passada } from "../src/store.ts";
import { casasDecimais, comparacoes, erroEmMs, parseTempo, resumoValidacao, textoConferencia } from "../src/validacao.ts";

const S = 1_000_000_000;
const MS = 1_000_000;

/** Passada mínima: só o que a conferência olha. */
function passada(over: Partial<Passada>): Passada {
  return {
    id: Math.random().toString(36).slice(2),
    dataMs: 0,
    competidor: "",
    cavalo: "",
    categoria: "",
    ordem: 0,
    eventoId: null,
    inscricaoId: null,
    elapsedRawNs: 14 * S,
    elapsedRefinedNs: 14 * S,
    tamboresDerrubados: 0,
    semTempo: false,
    qualidadeLargada: 2,
    qualidadeChegada: 2,
    incertezaLargadaNs: 0.5 * MS,
    incertezaChegadaNs: 0.5 * MS,
    degradada: false,
    fps: 240,
    quadrosPerdidos: 0,
    arquivo: "",
    ...over,
  };
}

test("parseTempo aceita o que sai de mostrador e de dedo apressado", () => {
  assert.equal(parseTempo("14,325"), 14_325 * MS);
  assert.equal(parseTempo("14.325"), 14_325 * MS);
  assert.equal(parseTempo("14,32"), 14_320 * MS);
  assert.equal(parseTempo("14"), 14 * S);
  assert.equal(parseTempo(" 14,325 "), 14_325 * MS);
  assert.equal(parseTempo("1:02,5"), 62_500 * MS);
  assert.equal(parseTempo("0:14,325"), 14_325 * MS);
  // milhar com ponto e decimal com vírgula
  assert.equal(parseTempo("1.014,325"), 1_014_325 * MS);
});

test("parseTempo devolve null para vazio e para lixo — sem erro na cara do usuário", () => {
  for (const t of ["", "   ", "abc", "14,3,2", "-14", "0", "12,5s", "1:75"]) {
    assert.equal(parseTempo(t), null, `deveria recusar ${JSON.stringify(t)}`);
  }
});

test("casasDecimais diz se a referência trouxe 2 ou 3 casas", () => {
  assert.equal(casasDecimais("14,325"), 3);
  assert.equal(casasDecimais("14,32"), 2);
  assert.equal(casasDecimais("14"), 0);
});

test("o erro é medido contra o refinado e SEM a penalidade dos tambores", () => {
  // 2 tambores derrubados: +10 s no tempo final da prova, mas a fotocélula não vê isso
  const p = passada({ elapsedRefinedNs: 14 * S + 3 * MS, oficialNs: 14 * S, tamboresDerrubados: 2 });
  const [c] = comparacoes([p]);
  assert.equal(c.erroRefinadoNs, 3 * MS);
});

test("passada sem tempo oficial, SAT ou antiga (campos ausentes) fica fora da conferência", () => {
  const antiga = passada({});
  delete (antiga as { oficialNs?: number | null }).oficialNs;
  assert.equal(comparacoes([antiga]).length, 0);
  assert.equal(comparacoes([passada({ oficialNs: null })]).length, 0);
  assert.equal(comparacoes([passada({ oficialNs: 14 * S, semTempo: true })]).length, 0);
  assert.equal(resumoValidacao([antiga]), null);
});

test("dentro/fora da incerteza é decidido pela SOMA das duas incertezas declaradas", () => {
  const base = { incertezaLargadaNs: 0.5 * MS, incertezaChegadaNs: 0.5 * MS, oficialNs: 14 * S };
  // erro de exatamente 1,0 ms com ±1,0 ms declarado: dentro (limite inclusivo)
  assert.equal(comparacoes([passada({ ...base, elapsedRefinedNs: 14 * S + 1 * MS })])[0].dentro, true);
  assert.equal(comparacoes([passada({ ...base, elapsedRefinedNs: 14 * S + 1.1 * MS })])[0].dentro, false);
  // erro negativo do mesmo tamanho decide igual
  assert.equal(comparacoes([passada({ ...base, elapsedRefinedNs: 14 * S - 1.1 * MS })])[0].dentro, false);
});

test("resumo: viés, erro absoluto, maior erro e contagem de honestidade", () => {
  // erros: +2, −4, +6 ms  → viés +4/3 = 1,333 ; |erro| médio 4 ; maior +6
  const ps = [
    passada({ elapsedRefinedNs: 14 * S + 2 * MS, oficialNs: 14 * S }),
    passada({ elapsedRefinedNs: 14 * S - 4 * MS, oficialNs: 14 * S }),
    passada({ elapsedRefinedNs: 14 * S + 6 * MS, oficialNs: 14 * S }),
  ];
  const r = resumoValidacao(ps)!;
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.viesMs - 4 / 3) < 1e-9, `viés ${r.viesMs}`);
  assert.ok(Math.abs(r.erroAbsMedioMs - 4) < 1e-9, `erro médio ${r.erroAbsMedioMs}`);
  assert.equal(r.maiorErroMs, 6);
  // ±1,0 ms declarado em todas: nenhuma cabe
  assert.equal(r.dentroDaIncerteza, 0);
});

test("maior erro guarda o SINAL do pior caso, não o módulo", () => {
  const ps = [
    passada({ elapsedRefinedNs: 14 * S + 2 * MS, oficialNs: 14 * S }),
    passada({ elapsedRefinedNs: 14 * S - 9 * MS, oficialNs: 14 * S }),
  ];
  assert.equal(resumoValidacao(ps)!.maiorErroMs, -9);
});

test("a quebra por qualidade separa 'o app erra' de 'o app erra quando avisa que a medição foi ruim'", () => {
  const ps = [
    passada({ elapsedRefinedNs: 14 * S + 1 * MS, oficialNs: 14 * S, qualidadeLargada: 2, qualidadeChegada: 2 }),
    passada({ elapsedRefinedNs: 14 * S + 3 * MS, oficialNs: 14 * S, qualidadeLargada: 2, qualidadeChegada: 2 }),
    passada({ elapsedRefinedNs: 14 * S + 40 * MS, oficialNs: 14 * S, qualidadeLargada: 0, qualidadeChegada: 2 }),
  ];
  const r = resumoValidacao(ps)!;
  assert.deepEqual(
    r.porQualidade.map((f) => [f.qualidade, f.n]),
    [[2, 2], [0, 1]],
  );
  assert.equal(r.porQualidade[0].erroAbsMedioMs, 2);
  assert.equal(r.porQualidade[1].erroAbsMedioMs, 40);
});

test("erroEmMs sempre mostra o sinal, porque o sinal é a informação", () => {
  assert.equal(erroEmMs(3_200_000), "+3,2 ms");
  assert.equal(erroEmMs(-400_000), "−0,4 ms");
  assert.equal(erroEmMs(0), "+0,0 ms");
});

test("textoConferencia sai colável, com resumo e uma linha por caso", () => {
  const ps = [passada({ elapsedRefinedNs: 14 * S + 2 * MS, oficialNs: 14 * S, arquivo: "IMG_0001.MOV" })];
  const t = textoConferencia(ps);
  assert.match(t, /1 passada\(s\)/);
  assert.match(t, /viés \+2,0 ms/);
  assert.match(t, /oficial;refinado;bruto;erro_ms/);
  assert.match(t, /IMG_0001\.MOV/);
  assert.equal(textoConferencia([]), "Nenhuma passada com tempo oficial ainda.");
});

test("oficial com 2 casas carrega o arredondamento DA REFERÊNCIA", () => {
  // A fotocélula mostrou 14,32; o app mediu 14,3247. O erro de 4,7 ms é maior que os ±0,84 ms do
  // app, mas MENOR que o arredondamento de ±5 ms da própria referência — marcar isso como "fora"
  // faria o painel do dia dizer que o app mente quando quem arredondou foi o painel da pista.
  const doisDecimais = passada({
    elapsedRefinedNs: 14 * S + 3247 * 100000,
    oficialNs: 14 * S + 320 * MS,
    oficialTexto: "14,32",
    incertezaLargadaNs: 420_000,
    incertezaChegadaNs: 420_000,
  });
  assert.equal(comparacoes([doisDecimais])[0].dentro, true);

  // Com três casas não há folga: o oficial é exato e o app tem de se sustentar sozinho.
  const tresDecimais = passada({
    elapsedRefinedNs: 14 * S + 3247 * 100000,
    oficialNs: 14 * S + 320 * MS,
    oficialTexto: "14,320",
    incertezaLargadaNs: 420_000,
    incertezaChegadaNs: 420_000,
  });
  assert.equal(comparacoes([tresDecimais])[0].dentro, false);

  // E sem o texto digitado não se supõe casa nenhuma — supor zero daria meio segundo de folga.
  const semTexto = passada({
    elapsedRefinedNs: 14 * S + 3247 * 100000,
    oficialNs: 14 * S + 320 * MS,
    incertezaLargadaNs: 420_000,
    incertezaChegadaNs: 420_000,
  });
  assert.equal(comparacoes([semTexto])[0].dentro, false);
});
