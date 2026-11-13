/**
 * Trvalý diagnostický log.
 *
 * Každý záznam se hned připisuje do souboru Documents/NovelForge/logs/diagnostics.log,
 * takže po nečekaném ukončení aplikace zůstane na disku poslední ZAHÁJENÁ operace
 * (např. „render-start“ bez „render-end“) – to je nejlepší dostupná stopa po pádu,
 * který JavaScript nemůže zachytit.
 *
 * Do logu se NIKDY nezapisují hlavičky, cookies, těla požadavků ani tokeny:
 * adresy se ukládají bez hodnot parametrů a dlouhé náhodné řetězce se skrývají.
 */
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

const DIR = "NovelForge/logs";
export const DIAG_FILE = `${DIR}/diagnostics.log`;
export const DIAG_OLD_FILE = `${DIR}/diagnostics.old.log`;
const MAX_BYTES = 400_000;
const SECRET_KEY = /cookie|authorization|token|password|passwd|secret|session|api[-_]?key|baggage|sentry/i;

declare const __APP_VERSION__: string;

/** Adresa bez hodnot parametrů a bez kotvy: https://host/cesta?start&end */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...new Set([...u.searchParams.keys()])].map((k) => (SECRET_KEY.test(k) ? "…" : k));
    const path = u.pathname.replace(/[A-Za-z0-9_-]{32,}/g, "[skryto]");
    return `${u.protocol}//${u.host}${path}${keys.length ? `?${keys.join("&")}` : ""}`;
  } catch {
    return redactText(String(url)).slice(0, 200);
  }
}

/** Zkrátí text a skryje vše, co vypadá jako token, cookie nebo přihlašovací údaj. */
export function redactText(text: string): string {
  return String(text)
    .replace(/https?:\/\/[^\s"'<>)]+/g, (m) => redactUrl(m))
    .replace(/\b(set-cookie|cookie)\b\s*[:=][^\n]*/gi, "$1=[skryto]")
    .replace(/\bBearer\s+\S+/gi, "[skryto]")
    .replace(/\b(authorization|token|password|secret|session(?:id)?|api[-_]?key)\b\s*[:=]\s*("[^"]*"|\S+)/gi, "$1=[skryto]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[skryto]")
    .replace(/\s+/g, " ")
    .slice(0, 400);
}

function formatValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (SECRET_KEY.test(key)) return "[skryto]";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (key === "url") return redactUrl(String(value));
  return JSON.stringify(redactText(typeof value === "string" ? value : JSON.stringify(value)));
}

export function formatLine(time: Date, event: string, data?: Record<string, unknown>): string {
  const parts = [time.toISOString(), event];
  for (const [k, v] of Object.entries(data ?? {})) {
    const f = formatValue(k, v);
    if (f !== "") parts.push(`${k}=${f}`);
  }
  return parts.join(" ");
}

export interface PreviousSession {
  /** Minulé spuštění skončilo uprostřed stahování, aniž aplikace přešla na pozadí. */
  interrupted: boolean;
  /** Operace, které začaly a nedoběhly (nejnovější poslední). */
  openOperations: string[];
  lastCompleted: string | null;
  lastLine: string | null;
}

/** Vyhodnotí log minulého spuštění (řádky od posledního „session-start“). */
export function analyzeSession(lines: string[]): PreviousSession {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ session-start( |$)/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const session = (start >= 0 ? lines.slice(start) : lines).filter(Boolean);
  const open = new Map<string, string>();
  let running = false;
  let backgrounded = false;
  let lastCompleted: string | null = null;
  for (const line of session) {
    const m = line.match(/^\S+ (\S+)(.*)$/);
    if (!m) continue;
    const [, event, rest] = m;
    const op = rest.match(/ op=(\d+)/)?.[1];
    if (event === "run-start") running = true;
    if (event === "run-end") running = false;
    if (event === "app-background") backgrounded = true;
    else if (event !== "session-start") backgrounded = backgrounded && !/-start$/.test(event);
    if (/-start$/.test(event) && op) open.set(op, line);
    if (/-end$/.test(event)) {
      if (op) open.delete(op);
      lastCompleted = line;
    }
  }
  return {
    interrupted: running && !backgrounded,
    openOperations: [...open.values()],
    lastCompleted,
    lastLine: session.length ? session[session.length - 1] : null,
  };
}

class Diagnostics {
  private chain: Promise<void> = Promise.resolve();
  private bytes = -1;
  private opCounter = 0;
  private ready = false;
  private previous: PreviousSession | null = null;
  /** Poslední řádky v paměti (pro zobrazení bez čtení souboru). */
  readonly recent: string[] = [];

  /** Zapíše záznam. Nikdy nevyhodí chybu – diagnostika nesmí shodit aplikaci. */
  log(event: string, data?: Record<string, unknown>): void {
    let line: string;
    try {
      line = formatLine(new Date(), event, data);
    } catch {
      line = `${new Date().toISOString()} ${event}`;
    }
    this.recent.push(line);
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200);
    this.chain = this.chain.then(() => this.append(line)).catch(() => {});
  }

  /** Zahájí operaci; vrácená funkce zapíše její konec včetně doby trvání. */
  begin(name: string, data?: Record<string, unknown>): (result?: Record<string, unknown>) => void {
    const op = ++this.opCounter;
    const t0 = Date.now();
    this.log(`${name}-start`, { op, ...data });
    let done = false;
    return (result) => {
      if (done) return;
      done = true;
      this.log(`${name}-end`, { op, ms: Date.now() - t0, ...result });
    };
  }

  /** Počká, až budou všechny dosavadní záznamy na disku. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    if (!this.ready) {
      this.ready = true;
      try {
        await Filesystem.mkdir({ path: DIR, directory: Directory.Documents, recursive: true });
      } catch {
        /* složka už existuje */
      }
    }
    if (this.bytes < 0) {
      try {
        this.bytes = (await Filesystem.stat({ path: DIAG_FILE, directory: Directory.Documents })).size ?? 0;
      } catch {
        this.bytes = 0;
      }
    }
    if (this.bytes > MAX_BYTES) {
      try {
        await Filesystem.deleteFile({ path: DIAG_OLD_FILE, directory: Directory.Documents }).catch(() => {});
        await Filesystem.rename({ from: DIAG_FILE, to: DIAG_OLD_FILE, directory: Directory.Documents, toDirectory: Directory.Documents });
      } catch {
        await Filesystem.deleteFile({ path: DIAG_FILE, directory: Directory.Documents }).catch(() => {});
      }
      this.bytes = 0;
    }
    const data = line + "\n";
    await Filesystem.appendFile({ path: DIAG_FILE, data, directory: Directory.Documents, encoding: Encoding.UTF8 });
    this.bytes += data.length;
  }

  private async readFile(path: string): Promise<string> {
    try {
      const res = await Filesystem.readFile({ path, directory: Directory.Documents, encoding: Encoding.UTF8 });
      return typeof res.data === "string" ? res.data : "";
    } catch {
      return "";
    }
  }

  /** Celý log (starší část + aktuální). */
  async read(): Promise<string> {
    await this.flush();
    return (await this.readFile(DIAG_OLD_FILE)) + (await this.readFile(DIAG_FILE));
  }

  /**
   * Při startu aplikace: vyhodnotí minulé spuštění a zapíše začátek nového.
   * Volá se jednou, před prvním stahováním.
   */
  async startSession(info: Record<string, unknown> = {}): Promise<PreviousSession> {
    await this.flush();
    const text = await this.readFile(DIAG_FILE);
    const lines = text.split("\n").filter(Boolean);
    this.previous = lines.length ? analyzeSession(lines.slice(-600)) : { interrupted: false, openOperations: [], lastCompleted: null, lastLine: null };
    const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
    this.log("session-start", { version, ...info });
    if (this.previous.interrupted) {
      this.log("previous-session-interrupted", {
        open: this.previous.openOperations.length,
        last: this.previous.openOperations[this.previous.openOperations.length - 1] ?? this.previous.lastLine ?? "",
      });
    }
    await this.flush();
    return this.previous;
  }

  previousSession(): PreviousSession | null {
    return this.previous;
  }

  /** Smaže log (jen na výslovnou žádost uživatele). */
  async clear(): Promise<void> {
    await this.flush();
    await Filesystem.deleteFile({ path: DIAG_FILE, directory: Directory.Documents }).catch(() => {});
    await Filesystem.deleteFile({ path: DIAG_OLD_FILE, directory: Directory.Documents }).catch(() => {});
    this.bytes = -1; // velikost se při dalším zápisu zjistí znovu
    this.recent.length = 0;
    this.previous = null;
  }

  /** Sloučí log do jednoho souboru k odeslání a vrátí jeho cestu. */
  async exportFile(): Promise<string> {
    const body = await this.read();
    const prev = this.previous;
    const header = [
      `NovelForge – diagnostika (${new Date().toISOString()})`,
      `Verze: ${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev"}`,
      prev?.interrupted ? `Minulé spuštění skončilo nečekaně. Nedokončené operace: ${prev.openOperations.length}` : "Minulé spuštění: bez známek nečekaného ukončení",
      ...(prev?.openOperations ?? []).map((l) => `  nedokončeno: ${l}`),
      prev?.lastCompleted ? `Poslední dokončená operace: ${prev.lastCompleted}` : "",
      "Log neobsahuje hlavičky, cookies, tokeny ani text kapitol.",
      "",
    ].filter((l, i) => l !== "" || i === 6);
    const path = `${DIR}/NovelForge-diagnostika.txt`;
    await Filesystem.writeFile({ path, data: header.join("\n") + "\n" + body, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
    return path;
  }
}

export const diag = new Diagnostics();

/** Zachytí chyby, které by jinak zmizely beze stopy (neobsloužené Promise, chyby skriptu). */
export function installGlobalErrorLogging(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("unhandledrejection", (e: any) => {
    diag.log("unhandled-rejection", { error: e?.reason?.message ?? String(e?.reason ?? "") });
    e?.preventDefault?.();
  });
  target.addEventListener("error", (e: any) => {
    diag.log("script-error", { error: e?.message ?? String(e?.error ?? ""), where: e?.filename ? `${String(e.filename).split("/").pop()}:${e.lineno ?? 0}` : "" });
  });
}
