/**
 * Dados locais do app: prova, inscrições e histórico de passadas.
 *
 * Fica tudo no `localStorage` do próprio navegador — sem conta, sem servidor, sem upload. É o mesmo
 * modelo do app nativo (JSON no armazenamento privado), com as mesmas regras de classificação vindas
 * do núcleo compartilhado.
 */
import { rank, type Placing, type ScoringRun } from "./core/eventScoring.ts";
import { formatElapsed } from "./core/timeFormatter.ts";

export interface Evento {
  id: string;
  nome: string;
  local: string;
  dataMs: number;
}

export interface Inscricao {
  id: string;
  eventoId: string;
  ordem: number;
  competidor: string;
  cavalo: string;
  categoria: string;
}

export interface Passada {
  id: string;
  dataMs: number;
  competidor: string;
  cavalo: string;
  categoria: string;
  ordem: number;
  eventoId: string | null;
  inscricaoId: string | null;
  elapsedRawNs: number;
  elapsedRefinedNs: number;
  tamboresDerrubados: number;
  semTempo: boolean;
  qualidadeLargada: number;
  qualidadeChegada: number;
  incertezaLargadaNs: number;
  incertezaChegadaNs: number;
  degradada: boolean;
  fps: number;
  quadrosPerdidos: number;
  arquivo: string;
}

interface Dados {
  eventos: Evento[];
  inscricoes: Inscricao[];
  passadas: Passada[];
  eventoAtual: string | null;
}

const CHAVE = "fotocelula.dados.v1";

const vazio = (): Dados => ({ eventos: [], inscricoes: [], passadas: [], eventoAtual: null });

export const novoId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export class Store {
  private dados: Dados = vazio();

  constructor() {
    this.carregar();
  }

  private carregar(): void {
    try {
      const bruto = localStorage.getItem(CHAVE);
      if (!bruto) return;
      const d = JSON.parse(bruto) as Dados;
      // leitura tolerante: um arquivo estranho abre vazio em vez de derrubar o app na arena
      this.dados = {
        eventos: Array.isArray(d.eventos) ? d.eventos : [],
        inscricoes: Array.isArray(d.inscricoes) ? d.inscricoes : [],
        passadas: Array.isArray(d.passadas) ? d.passadas : [],
        eventoAtual: typeof d.eventoAtual === "string" ? d.eventoAtual : null,
      };
      if (!this.eventos.some((e) => e.id === this.dados.eventoAtual)) this.dados.eventoAtual = null;
    } catch {
      this.dados = vazio();
    }
  }

  private salvar(): void {
    try {
      localStorage.setItem(CHAVE, JSON.stringify(this.dados));
    } catch {
      /* cota cheia ou modo privado: o app segue funcionando na sessão */
    }
  }

  get eventos(): Evento[] {
    return this.dados.eventos;
  }

  get passadas(): Passada[] {
    return this.dados.passadas;
  }

  get eventoAtualId(): string | null {
    return this.dados.eventoAtual;
  }

  get eventoAtual(): Evento | null {
    return this.dados.eventos.find((e) => e.id === this.dados.eventoAtual) ?? null;
  }

  inscricoesDe(eventoId: string): Inscricao[] {
    return this.dados.inscricoes
      .filter((i) => i.eventoId === eventoId)
      .sort((a, b) => a.ordem - b.ordem || a.competidor.localeCompare(b.competidor));
  }

  inscricao(id: string | null): Inscricao | null {
    return id === null ? null : (this.dados.inscricoes.find((i) => i.id === id) ?? null);
  }

  criarEvento(nome: string, local: string): Evento {
    const e: Evento = { id: novoId(), nome: nome.trim() || "Prova", local: local.trim(), dataMs: Date.now() };
    this.dados.eventos.unshift(e);
    this.dados.eventoAtual = e.id;
    this.salvar();
    return e;
  }

  selecionarEvento(id: string | null): void {
    this.dados.eventoAtual = id;
    this.salvar();
  }

  removerEvento(id: string): void {
    this.dados.eventos = this.dados.eventos.filter((e) => e.id !== id);
    this.dados.inscricoes = this.dados.inscricoes.filter((i) => i.eventoId !== id);
    if (this.dados.eventoAtual === id) this.dados.eventoAtual = null;
    this.salvar();
  }

  adicionarInscricao(i: Omit<Inscricao, "id">): Inscricao {
    const nova: Inscricao = { ...i, id: novoId() };
    this.dados.inscricoes.push(nova);
    this.salvar();
    return nova;
  }

  removerInscricao(id: string): void {
    this.dados.inscricoes = this.dados.inscricoes.filter((i) => i.id !== id);
    this.salvar();
  }

  /** Próxima inscrição a largar: a de menor ordem que ainda não tem passada salva. */
  proximaInscricao(): Inscricao | null {
    const ev = this.dados.eventoAtual;
    if (ev === null) return null;
    const feitas = new Set(this.dados.passadas.map((p) => p.inscricaoId).filter(Boolean));
    return this.inscricoesDe(ev).find((i) => !feitas.has(i.id)) ?? null;
  }

  salvarPassada(p: Passada): void {
    const i = this.dados.passadas.findIndex((x) => x.id === p.id);
    if (i >= 0) this.dados.passadas[i] = p;
    else this.dados.passadas.unshift(p);
    this.salvar();
  }

  removerPassada(id: string): void {
    this.dados.passadas = this.dados.passadas.filter((p) => p.id !== id);
    this.salvar();
  }

  limparHistorico(): void {
    this.dados.passadas = [];
    this.salvar();
  }

  /**
   * Classificação da prova, já pareada com a passada de cada colocação. O pareamento é feito DENTRO
   * de cada categoria: a ordem de largada costuma ser numerada por categoria, então um mapa por
   * número sobre a prova inteira mostraria o competidor errado.
   */
  classificacao(eventoId: string): { colocacao: Placing; passada: Passada }[] {
    const minhas = this.dados.passadas.filter((p) => p.eventoId === eventoId);
    const cats: string[] = [];
    for (const p of minhas) if (!cats.includes(p.categoria)) cats.push(p.categoria);
    cats.sort();
    const saida: { colocacao: Placing; passada: Passada }[] = [];
    for (const cat of cats) {
      const naCat = minhas.filter((p) => p.categoria === cat);
      const fila = new Map<number, Passada[]>();
      for (const p of naCat) {
        const l = fila.get(p.ordem) ?? [];
        l.push(p);
        fila.set(p.ordem, l);
      }
      const runs: ScoringRun[] = naCat.map((p) => ({
        entryOrder: p.ordem,
        elapsedRefinedNs: p.elapsedRefinedNs,
        elapsedRawNs: p.elapsedRawNs,
        barrelsKnocked: p.tamboresDerrubados,
        noTime: p.semTempo,
        category: p.categoria,
      }));
      for (const colocacao of rank(runs)) {
        const l = fila.get(colocacao.entryOrder);
        if (!l || l.length === 0) continue;
        saida.push({ colocacao, passada: l.shift()! });
      }
    }
    return saida;
  }
}

const aspas = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const dec = (v: number, casas: number): string => v.toFixed(casas).replace(".", ",");

/** CSV do histórico (separador ";" e vírgula decimal, formato Excel pt-BR — igual ao app nativo). */
export function csvHistorico(passadas: Passada[]): string {
  const cab = [
    "data", "competidor", "cavalo", "categoria", "ordem", "tempo_final", "tempo_bruto_s",
    "tempo_refinado_s", "tambores_derrubados", "penalidade_s", "sem_tempo", "degradada",
    "qualidade_largada", "qualidade_chegada", "incerteza_largada_ms", "incerteza_chegada_ms",
    "fps", "quadros_perdidos", "arquivo",
  ];
  const linhas = [cab.join(";")];
  for (const p of passadas) {
    const final = p.semTempo ? "SAT" : formatElapsed(p.elapsedRefinedNs + p.tamboresDerrubados * 5_000_000_000).replace(".", ",");
    linhas.push(
      [
        new Date(p.dataMs).toISOString().slice(0, 19),
        aspas(p.competidor), aspas(p.cavalo), aspas(p.categoria), String(p.ordem || ""),
        final, dec(p.elapsedRawNs / 1e9, 3), dec(p.elapsedRefinedNs / 1e9, 4),
        String(p.tamboresDerrubados), String(p.tamboresDerrubados * 5), p.semTempo ? "sim" : "não",
        p.degradada ? "sim" : "não", String(p.qualidadeLargada), String(p.qualidadeChegada),
        dec(p.incertezaLargadaNs / 1e6, 3), dec(p.incertezaChegadaNs / 1e6, 3),
        dec(p.fps, 1), String(p.quadrosPerdidos), aspas(p.arquivo),
      ].join(";"),
    );
  }
  return linhas.join("\n") + "\n";
}

/** CSV da classificação da prova. */
export function csvClassificacao(linhas: { colocacao: Placing; passada: Passada }[]): string {
  const cab = ["categoria", "colocacao", "ordem", "competidor", "cavalo", "tempo_final", "tempo_bruto_s", "tambores", "penalidade_s", "sem_tempo"];
  const out = [cab.join(";")];
  for (const { colocacao: c, passada: p } of linhas) {
    out.push(
      [
        aspas(p.categoria), c.place === null ? "SAT" : String(c.place), String(p.ordem),
        aspas(p.competidor), aspas(p.cavalo),
        p.semTempo ? "SAT" : formatElapsed(c.finalNs).replace(".", ","),
        dec(p.elapsedRawNs / 1e9, 3), String(p.tamboresDerrubados),
        String(c.penaltyNs / 1_000_000_000), p.semTempo ? "sim" : "não",
      ].join(";"),
    );
  }
  return out.join("\n") + "\n";
}

/**
 * Importa a lista de largada de um CSV `ordem;competidor;cavalo;categoria` (separador ";" ou ",",
 * cabeçalho opcional, aspas duplas respeitadas). Linhas inválidas são ignoradas — a planilha vem de
 * terceiros e não pode derrubar o app na hora da prova.
 */
export function lerCsvInscricoes(texto: string): Omit<Inscricao, "id" | "eventoId">[] {
  const saida: Omit<Inscricao, "id" | "eventoId">[] = [];
  let proximaOrdem = 1;
  for (const cru of texto.split(/\r?\n/)) {
    const linha = cru.trim().replace(/^﻿/, "");
    if (!linha) continue;
    const pv = (linha.match(/;/g) ?? []).length;
    const vg = (linha.match(/,/g) ?? []).length;
    const sep = pv >= vg ? ";" : ",";
    const cols = dividirCsv(linha, sep);
    if (cols.length === 0) continue;
    const ordem = /^\d+$/.test(cols[0]) ? Number(cols[0]) : null;
    const competidor = ordem !== null ? (cols[1] ?? "") : cols[0];
    if (!competidor.trim()) continue;
    if (ordem === null && ["competidor", "nome", "ordem"].includes(competidor.toLowerCase())) continue;
    const cavalo = ordem !== null ? (cols[2] ?? "") : (cols[1] ?? "");
    const categoria = ordem !== null ? (cols[3] ?? "") : (cols[2] ?? "");
    saida.push({ ordem: ordem ?? proximaOrdem, competidor, cavalo, categoria });
    proximaOrdem = ordem !== null ? Math.max(proximaOrdem, ordem + 1) : proximaOrdem + 1;
  }
  return saida;
}

function dividirCsv(linha: string, sep: string): string[] {
  const out: string[] = [];
  let atual = "";
  let aspasAbertas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (aspasAbertas && c === '"' && linha[i + 1] === '"') {
      atual += '"';
      i++;
    } else if (c === '"') {
      aspasAbertas = !aspasAbertas;
    } else if (c === sep && !aspasAbertas) {
      out.push(atual.trim());
      atual = "";
    } else {
      atual += c;
    }
  }
  out.push(atual.trim());
  return out;
}
