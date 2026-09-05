import type { Nanos } from "./nanos.ts";

/** nanos -> "S.mmm" (arredondamento half-up para milésimos). Negativo vira "0.000". */
export function formatElapsed(ns: Nanos): string {
  const v = ns < 0 ? 0 : ns;
  const ms = Math.floor((v + 500_000) / 1_000_000);
  const s = Math.floor(ms / 1000);
  const rem = ms % 1000;
  return `${s}.${String(rem).padStart(3, "0")}`;
}

/** "M:SS.mmm" para mostradores grandes. */
export function formatClock(ns: Nanos): string {
  const v = ns < 0 ? 0 : ns;
  const ms = Math.floor((v + 500_000) / 1_000_000);
  const totalS = Math.floor(ms / 1000);
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  const rem = ms % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(rem).padStart(3, "0")}`;
}
