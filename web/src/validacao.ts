/**
 * Conferência contra a cronometragem oficial.
 *
 * Até aqui a precisão do app só foi provada em vídeo sintético, onde a verdade é conhecida porque
 * fomos nós que a geramos — isso prova o ALGORITMO, não a cadeia inteira (câmera do iPhone,
 * exposição real, poeira, luz de arena, cavalo em vez de barra). Com uma fotocélula eletrônica ao
 * lado, que erra menos de 1 ms, toda diferença que aparecer é do app: dá para medir o erro de
 * verdade.
 *
 * Tudo aqui é função pura, sem DOM, para poder rodar em `node --test`.
 */
import type { Origem, Passada } from "./store.ts";

const NS_POR_S = 1_000_000_000;

/**
 * Lê o tempo digitado a partir do mostrador da fotocélula e devolve nanossegundos.
 *
 * Aceita o que sai de mostrador e de dedo apressado: `14,325`, `14.325`, `14,32`, `14`, `1:02,5`.
 * Devolve `null` para vazio ou lixo — sem conferência, e sem erro na cara do usuário.
 */
export function parseTempo(texto: string): number | null {
  let t = (texto ?? "").trim();
  if (t === "") return null;
  t = t.replace(/\s/g, "");
  // "1.234,56" (milhar com ponto): o ponto é separador de milhar, a vírgula é decimal
  if (t.includes(".") && t.includes(",")) t = t.replace(/\./g, "");
  t = t.replace(",", ".");
  if (!/^\d{0,3}:?\d*(\.\d+)?$/.test(t)) return null;

  let segundos: number;
  if (t.includes(":")) {
    const [m, s] = t.split(":");
    const min = Number(m);
    const seg = Number(s === "" ? "0" : s);
    if (!Number.isFinite(min) || !Number.isFinite(seg) || seg >= 60) return null;
    segundos = min * 60 + seg;
  } else {
    segundos = Number(t);
  }
  if (!Number.isFinite(segundos) || segundos <= 0) return null;
  return Math.round(segundos * NS_POR_S);
}

/**
 * De onde veio o tempo. Passada antiga não tem o campo e é, por definição, análise de arquivo — era
 * o único caminho que existia quando ela foi salva.
 */
export const origemDe = (p: Passada): Origem =>
  p.origem === "ao-vivo" || p.origem === "ao-vivo-mao" ? p.origem : "video";

/** Nome do caminho para a tela e para o texto colável. */
export const nomeOrigem = (o: Origem): string =>
  o === "ao-vivo" ? "ao vivo" : o === "ao-vivo-mao" ? "ao vivo, na mão" : "vídeo";

/**
 * Separa as passadas pelos dois caminhos, na ordem em que interessa ler.
 *
 * É esta divisão que responde a pergunta prática: o cronômetro ao vivo (30 ou 60 quadros por
 * segundo) erra o suficiente para não servir? Só a comparação de viés e erro médio contra a MESMA
 * fotocélula responde — e ela precisa de vários casos de cada lado, não de um.
 */
export function porOrigem(passadas: Passada[]): { origem: Origem; passadas: Passada[] }[] {
  const saida: { origem: Origem; passadas: Passada[] }[] = [];
  for (const o of ["video", "ao-vivo", "ao-vivo-mao"] as Origem[]) {
    const fatia = passadas.filter((p) => origemDe(p) === o);
    if (fatia.length > 0) saida.push({ origem: o, passadas: fatia });
  }
  return saida;
}

/** Quantas casas decimais o oficial trouxe — 2 casas significam ±5 ms de arredondamento NA REFERÊNCIA. */
export function casasDecimais(texto: string): number {
  const m = /[.,](\d+)$/.exec((texto ?? "").trim());
  return m ? m[1].length : 0;
}

export interface Comparacao {
  passada: Passada;
  /** medido − oficial. Positivo = o app mediu MAIS tempo que a fotocélula. */
  erroRefinadoNs: number;
  erroBrutoNs: number;
  /** A incerteza que o próprio app declarou para esta passada (soma dos dois gatilhos). */
  incertezaNs: number;
  /** O erro coube na incerteza declarada? É o teste de honestidade do app. */
  dentro: boolean;
  /** Menor das duas qualidades — é ela que o cartão mostra. */
  qualidade: number;
}

/**
 * A grandeza comparável é `elapsedRefinedNs`: a fotocélula mede o cruzamento da linha na ida e na
 * volta, SEM penalidade. Os +5 s por tambor são decisão de juiz, não medição — entram no tempo
 * final da prova e não nesta conta.
 */
export function comparacoes(passadas: Passada[]): Comparacao[] {
  const out: Comparacao[] = [];
  for (const p of passadas) {
    const oficial = p.oficialNs ?? null;
    if (oficial === null || oficial <= 0 || p.semTempo) continue;
    const incertezaNs = (p.incertezaLargadaNs ?? 0) + (p.incertezaChegadaNs ?? 0);
    const erroRefinadoNs = p.elapsedRefinedNs - oficial;
    out.push({
      passada: p,
      erroRefinadoNs,
      erroBrutoNs: p.elapsedRawNs - oficial,
      incertezaNs,
      dentro: Math.abs(erroRefinadoNs) <= incertezaNs,
      qualidade: Math.min(p.qualidadeLargada, p.qualidadeChegada),
    });
  }
  return out;
}

export interface FatiaQualidade {
  qualidade: number;
  n: number;
  viesMs: number;
  erroAbsMedioMs: number;
}

export interface Resumo {
  n: number;
  /** Média COM SINAL: revela erro sistemático, que é o que dá para corrigir. */
  viesMs: number;
  erroAbsMedioMs: number;
  /** O pior caso, com sinal. */
  maiorErroMs: number;
  dentroDaIncerteza: number;
  /**
   * Quebra por qualidade declarada. Separa "o app erra" de "o app erra quando ele mesmo avisou que
   * a medição foi ruim" — diagnósticos opostos, correções opostas.
   */
  porQualidade: FatiaQualidade[];
}

const media = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

export function resumoValidacao(passadas: Passada[]): Resumo | null {
  const c = comparacoes(passadas);
  if (c.length === 0) return null;
  const errosMs = c.map((x) => x.erroRefinadoNs / 1e6);
  let maior = errosMs[0];
  for (const e of errosMs) if (Math.abs(e) > Math.abs(maior)) maior = e;

  const porQualidade: FatiaQualidade[] = [];
  for (const q of [2, 1, 0]) {
    const fatia = c.filter((x) => x.qualidade === q);
    if (fatia.length === 0) continue;
    const e = fatia.map((x) => x.erroRefinadoNs / 1e6);
    porQualidade.push({
      qualidade: q,
      n: fatia.length,
      viesMs: media(e),
      erroAbsMedioMs: media(e.map(Math.abs)),
    });
  }
  return {
    n: c.length,
    viesMs: media(errosMs),
    erroAbsMedioMs: media(errosMs.map(Math.abs)),
    maiorErroMs: maior,
    dentroDaIncerteza: c.filter((x) => x.dentro).length,
    porQualidade,
  };
}

/** "+3,2 ms" / "−0,4 ms" — sinal explícito, porque o sinal é a informação. */
export function erroEmMs(ns: number): string {
  const ms = ns / 1e6;
  const sinal = ms >= 0 ? "+" : "−";
  return `${sinal}${Math.abs(ms).toFixed(1).replace(".", ",")} ms`;
}

/** Texto curto para o usuário colar numa conversa — é assim que os casos chegam para análise. */
export function textoConferencia(passadas: Passada[]): string {
  const r = resumoValidacao(passadas);
  if (!r) return "Nenhuma passada com tempo oficial ainda.";
  const l: string[] = [];
  l.push(`CONFERÊNCIA CONTRA A CRONOMETRAGEM OFICIAL — ${r.n} passada(s)`);
  l.push(`viés ${erroEmMs(r.viesMs * 1e6)} · erro absoluto médio ${r.erroAbsMedioMs.toFixed(1).replace(".", ",")} ms`);
  l.push(`maior erro ${erroEmMs(r.maiorErroMs * 1e6)} · dentro da incerteza declarada: ${r.dentroDaIncerteza} de ${r.n}`);
  for (const f of r.porQualidade) {
    l.push(`  qualidade ${f.qualidade}: ${f.n} caso(s) · viés ${erroEmMs(f.viesMs * 1e6)} · |erro| médio ${f.erroAbsMedioMs.toFixed(1).replace(".", ",")} ms`);
  }
  // A quebra por caminho é o que decide se o cronômetro ao vivo serve para treino. Só aparece
  // quando há os dois — com um só, a comparação não existe e a linha seria ruído.
  const fatias = porOrigem(passadas).filter((f) => resumoValidacao(f.passadas) !== null);
  if (fatias.length > 1) {
    l.push("");
    l.push("POR CAMINHO:");
    for (const f of fatias) {
      const rf = resumoValidacao(f.passadas)!;
      l.push(
        `  ${nomeOrigem(f.origem)}: ${rf.n} caso(s) · viés ${erroEmMs(rf.viesMs * 1e6)} · |erro| médio ${rf.erroAbsMedioMs.toFixed(1).replace(".", ",")} ms · ${rf.dentroDaIncerteza} de ${rf.n} dentro da incerteza`,
      );
    }
  }
  l.push("");
  l.push("oficial;refinado;bruto;erro_ms;incerteza_ms;qualidade;fps;origem;arquivo");
  for (const c of comparacoes(passadas)) {
    const p = c.passada;
    l.push(
      [
        (p.oficialNs! / 1e9).toFixed(3),
        (p.elapsedRefinedNs / 1e9).toFixed(4),
        (p.elapsedRawNs / 1e9).toFixed(3),
        (c.erroRefinadoNs / 1e6).toFixed(2),
        (c.incertezaNs / 1e6).toFixed(2),
        `q${p.qualidadeLargada}/${p.qualidadeChegada}${p.degradada ? " degradada" : ""}`,
        p.fps.toFixed(0),
        origemDe(p),
        p.arquivo,
      ].join(";"),
    );
  }
  return l.join("\n") + "\n";
}
