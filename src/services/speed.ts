/**
 * Rychlostní režimy a adaptivní řízení tempa stahování.
 *
 * Tempo nikdy nepřekročí to, co snese zdroj (parser udává nejvyšší souběžnost,
 * nejkratší odstup a zda je povolen rychlý režim). Při omezení ze strany webu
 * (HTTP 429) se tempo sníží a respektuje se Retry-After; po delší řadě úspěchů
 * se pomalu vrací k výchozímu. Vyšší rychlost se nikdy nepoužívá k překonávání
 * přístupových ochran.
 */
import type { SpeedMode } from "@/types";

export interface SourceLimits {
  maxConcurrency: number;
  allowFast: boolean;
  minIntervalMs: number;
}

export interface Pace {
  /** Režim, který se skutečně použije (rychlý se u některých webů nepovoluje). */
  mode: SpeedMode;
  concurrency: number;
  /** Odstup mezi začátky kapitol jednoho pracovníka (ms). */
  delayMs: number;
}

export const SPEED_LABELS: Record<SpeedMode, string> = { eco: "Úsporný", balanced: "Vyvážený", fast: "Rychlý" };
/** Nejvyšší souběžnost, kterou aplikace vůbec použije. */
export const MAX_CONCURRENCY = 4;

export function normalizeSpeedMode(mode: unknown): SpeedMode {
  return mode === "eco" || mode === "fast" ? mode : "balanced";
}

/** Výchozí tempo pro daný režim, nastavení projektu a limity zdroje. */
export function basePace(requestedMode: SpeedMode | undefined, settings: { concurrentRequests?: number; delayMs?: number }, limits: SourceLimits): Pace {
  let mode = normalizeSpeedMode(requestedMode);
  if (mode === "fast" && !limits.allowFast) mode = "balanced";
  const wanted = Math.max(1, Math.floor(settings.concurrentRequests ?? 1));
  const delay = Math.max(0, settings.delayMs ?? 0);
  const cap = Math.max(1, Math.min(limits.maxConcurrency, MAX_CONCURRENCY));
  const floor = Math.max(0, limits.minIntervalMs);
  if (mode === "eco") {
    return { mode, concurrency: 1, delayMs: delay === 0 && floor === 0 ? 0 : Math.max(delay * 2, floor * 2, 2500) };
  }
  if (mode === "fast") {
    return { mode, concurrency: Math.min(Math.max(wanted, MAX_CONCURRENCY), cap), delayMs: delay === 0 ? floor : Math.max(Math.round(delay * 0.4), floor, 300) };
  }
  return { mode, concurrency: Math.min(wanted, cap), delayMs: Math.max(delay, floor) };
}

/** Kolik omezení požadavků po sobě se ještě čeká, než se stahování zastaví. */
export const MAX_RATE_LIMIT_WAITS = 4;
const MAX_DELAY_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const RECOVER_AFTER = 15;

export class AdaptivePace {
  concurrency: number;
  delayMs: number;
  private successes = 0;
  private rateLimits = 0;
  /** Kolikrát se během běhu tempo snížilo. */
  slowdowns = 0;

  constructor(readonly base: Pace, private readonly backoffBaseMs = 5000) {
    this.concurrency = base.concurrency;
    this.delayMs = base.delayMs;
  }

  /** Kapitola se stáhla: po řadě úspěchů se tempo o krok vrátí k výchozímu. */
  onSuccess(): void {
    this.rateLimits = 0;
    this.successes++;
    if (this.successes % RECOVER_AFTER !== 0) return;
    if (this.delayMs > this.base.delayMs) this.delayMs = Math.max(this.base.delayMs, Math.round(this.delayMs * 0.8));
    else if (this.concurrency < this.base.concurrency) this.concurrency++;
  }

  /**
   * Web omezil požadavky. Vrací, jak dlouho počkat (ms), nebo null, když už
   * omezení přišlo tolikrát po sobě, že se má stahování zastavit.
   */
  onRateLimit(retryAfterMs?: number): number | null {
    this.rateLimits++;
    this.successes = 0;
    this.slowdowns++;
    this.concurrency = 1;
    this.delayMs = Math.min(MAX_DELAY_MS, Math.max(this.delayMs * 2, this.base.delayMs, Math.min(2000, this.backoffBaseMs)));
    if (this.rateLimits > MAX_RATE_LIMIT_WAITS) return null;
    const backoff = Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** (this.rateLimits - 1));
    return Math.min(3_600_000, Math.max(retryAfterMs ?? 0, backoff));
  }
}

/** Plovoucí statistika rychlosti jednoho běhu. */
export class RunStats {
  private readonly startedAt: number;
  private readonly done: number[] = [];
  private workMs = 0;
  private count = 0;
  readonly steps = { fetch: 0, clean: 0, write: 0, db: 0 };

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  record(workMs: number, steps: { fetch: number; clean: number; write: number; db: number }, now = Date.now()): void {
    this.count++;
    this.workMs += workMs;
    this.done.push(now);
    if (this.done.length > 30) this.done.shift();
    this.steps.fetch += steps.fetch;
    this.steps.clean += steps.clean;
    this.steps.write += steps.write;
    this.steps.db += steps.db;
  }

  get completed(): number {
    return this.count;
  }

  /** Průměrná doba zpracování jedné kapitoly (bez čekání mezi kapitolami). */
  get avgChapterMs(): number {
    return this.count ? this.workMs / this.count : 0;
  }

  /** Kapitoly za minutu podle posledních dokončených kapitol (včetně čekání). */
  perMinute(now = Date.now()): number {
    if (this.count === 0) return 0;
    const from = this.done.length >= 2 && this.count > this.done.length - 1 ? this.done[0] : this.startedAt;
    const n = from === this.startedAt ? this.count : this.done.length - 1;
    const span = Math.max(1, now - from);
    return (n / span) * 60_000;
  }

  etaMs(remaining: number, now = Date.now()): number | null {
    const rate = this.perMinute(now);
    return rate > 0 && remaining > 0 ? (remaining / rate) * 60_000 : null;
  }
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.round(h / 24)} dní`;
}
