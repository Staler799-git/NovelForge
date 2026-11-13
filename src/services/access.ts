/**
 * Přístupová omezení zdrojových webů.
 *
 * Aplikace omezení NEOBCHÁZÍ – jen je rozpozná, srozumitelně ohlásí a zastaví
 * další požadavky. Ověření (CAPTCHA, Turnstile) i přihlášení dělá vždy uživatel
 * sám ve webovém rozhraní.
 */
import type { ProjectStatus } from "@/types";

export type AccessKind =
  | "rate-limited" // HTTP 429 / web hlásí příliš mnoho požadavků
  | "forbidden" // HTTP 403 bez ověřovací stránky
  | "challenge" // Cloudflare / Turnstile / CAPTCHA
  | "login-required" // obsah je jen pro přihlášené
  | "translation-locked" // překlad kapitoly je zamčený (i po přihlášení)
  | "mode-unsupported" // web vydal obsah v podobě, kterou aplikace nečte
  | "unavailable" // kapitola neexistuje (404/410)
  | "network"
  | "parser"
  | "storage";

/** Druhy, po kterých nemá smysl posílat na zdroj další požadavky. */
const STOP_SOURCE: ReadonlySet<AccessKind> = new Set(["challenge", "login-required", "translation-locked", "mode-unsupported"]);

export class AccessError extends Error {
  readonly kind: AccessKind;
  /** true = zastavit všechny další požadavky na tento zdroj. */
  readonly stopSource: boolean;
  /** Opakovat tutéž kapitolu má smysl jen u dočasných chyb. */
  readonly retryable: boolean;
  /** Doba, po kterou web žádá počkat (Retry-After), v ms. */
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(kind: AccessKind, message: string, extra: { retryAfterMs?: number; status?: number } = {}) {
    super(message);
    this.name = "AccessError";
    this.kind = kind;
    this.stopSource = STOP_SOURCE.has(kind);
    this.retryable = kind === "rate-limited" || kind === "network";
    this.retryAfterMs = extra.retryAfterMs;
    this.status = extra.status;
  }
}

export function accessKindOf(err: unknown): AccessKind | null {
  const k = (err as { kind?: unknown })?.kind;
  return typeof k === "string" ? (k as AccessKind) : null;
}

/** Retry-After: počet sekund nebo datum. Vrací ms (0–1 h), nebo undefined. */
export function parseRetryAfter(value: string | undefined | null, now = Date.now()): number | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return undefined;
    ms = t - now;
  }
  return Math.max(0, Math.min(ms, 3_600_000));
}

export function headerOf(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? "") : "";
}

const CHALLENGE_HTML = /just a moment\.\.\.|checking your browser|cf-browser-verification|cf-chl-|challenge-platform|cf-turnstile|security check required|unusual (reading )?activity/i;
const CAPTCHA_HTML = /g-recaptcha|h-captcha|hcaptcha\.com|verify you are (a )?human|are you a robot/i;
const LOGIN_TEXT = /requires? registration|sign[\s-]?in|log[\s-]?in|register(ed)? (to|user)|unauthori[sz]ed|not authenticated|authentication required|must be logged|please login/i;

/**
 * Zařadí HTTP odpověď (stav, hlavičky, začátek těla). Vrací null, když odpověď
 * nevypadá jako přístupové omezení.
 */
export function classifyHttp(status: number, headers: Record<string, string> | undefined, body: string | null | undefined, site = "Web"): AccessError | null {
  const text = (body ?? "").slice(0, 6000);
  const short = text.length < 6000;
  if (/challenge/i.test(headerOf(headers, "cf-mitigated")) || (short && CHALLENGE_HTML.test(text) && !/^\s*[{[]/.test(text))) {
    return new AccessError("challenge", `${site} vyžaduje bezpečnostní ověření (Cloudflare). Ověření musíte provést sami ve webovém rozhraní; aplikace ho neobchází.`, { status });
  }
  if (short && CAPTCHA_HTML.test(text) && !/^\s*[{[]/.test(text)) {
    return new AccessError("challenge", `${site} vyžaduje CAPTCHA. Ověření musíte provést sami; aplikace ho neobchází.`, { status });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headerOf(headers, "retry-after"));
    return new AccessError("rate-limited", `${site} omezil počet požadavků (HTTP 429)${retryAfterMs ? ` – žádá počkat ${Math.ceil(retryAfterMs / 1000)} s` : ""}.`, { status, retryAfterMs });
  }
  if (status === 401) return new AccessError("login-required", `${site} vyžaduje přihlášení (HTTP 401).`, { status });
  if (status === 403) return new AccessError("forbidden", `${site} odmítl přístup (HTTP 403).`, { status });
  if (status === 404 || status === 410) return new AccessError("unavailable", `Stránka neexistuje (HTTP ${status}).`, { status });
  return null;
}

export function looksLikeLoginMessage(text: string): boolean {
  return LOGIN_TEXT.test(text);
}

/** Stav projektu, do kterého se stahování po dané překážce přepne. */
export function statusForAccess(kind: AccessKind): ProjectStatus {
  switch (kind) {
    case "challenge":
      return "verification-required";
    case "login-required":
    case "translation-locked":
      return "waiting-auth";
    case "rate-limited":
      return "rate-limited";
    default:
      return "paused";
  }
}

/** Krátký popis druhu chyby pro uživatele. */
export function accessLabel(kind: AccessKind | null | undefined): string {
  switch (kind) {
    case "rate-limited":
      return "Omezení počtu požadavků";
    case "forbidden":
      return "Přístup odmítnut";
    case "challenge":
      return "Bezpečnostní ověření";
    case "login-required":
      return "Vyžadováno přihlášení";
    case "translation-locked":
      return "Zamčený překlad";
    case "mode-unsupported":
      return "Nepodporovaná podoba překladu";
    case "unavailable":
      return "Kapitola není dostupná";
    case "network":
      return "Chyba sítě";
    case "parser":
      return "Chyba zpracování stránky";
    case "storage":
      return "Chyba ukládání";
    default:
      return "";
  }
}

/** Zpráva po zastavení stahování kvůli přístupové překážce. */
export function pauseMessage(site: string, kind: AccessKind, detail: string): string {
  const kept = "Stahování bylo pozastaveno a hotové kapitoly zůstaly uložené.";
  switch (kind) {
    case "challenge":
      return `${site} vyžaduje bezpečnostní ověření. ${kept} Otevřete zdrojovou stránku, ověření proveďte sami a pak zvolte Pokračovat. (${detail})`;
    case "login-required":
      return `${site} vyžaduje přihlášení. ${kept} Přihlaste se ve webovém rozhraní, nebo zvolte jiný překlad, a pak zvolte Pokračovat. (${detail})`;
    case "translation-locked":
      return `Zvolený překlad je u této kapitoly na ${site} zamčený. ${kept} Aplikace zamčený obsah nezískává; odemkněte ho na webu, nebo zvolte jiný překlad. (${detail})`;
    case "mode-unsupported":
      return `${site} vydává zvolený překlad v podobě, kterou aplikace nečte. ${kept} Zvolte jiný překlad. (${detail})`;
    case "rate-limited":
      return `${site} opakovaně omezuje počet požadavků. ${kept} Zkuste to později nebo zvolte úspornější rychlost. (${detail})`;
    case "forbidden":
      return `${site} opakovaně odmítá přístup. ${kept} (${detail})`;
    default:
      return `${kept} (${detail})`;
  }
}
