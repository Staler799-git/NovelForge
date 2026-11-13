import { Capacitor } from "@capacitor/core";
import { diag, redactUrl } from "./diag";

export interface RenderOptions {
  /** Prodleva (ms) po načtení stránky, než se přečte DOM – pro obsah dotahovaný skriptem. Max 15 s. */
  delayMs?: number;
}

/** Chyba nativního vykreslování. `critical` = nemá smysl pokračovat (paměť, pád procesu). */
export class RenderError extends Error {
  critical: boolean;
  constructor(message: string, critical = false) {
    super(message);
    this.name = "RenderError";
    this.critical = critical;
  }
}

function plugin(): any | undefined {
  const plugins = (Capacitor as any).Plugins as Record<string, any> | undefined;
  return plugins?.["WebRenderer"];
}

// Vykreslování je drahé (celý WKWebView). I když nativní plugin má vlastní frontu,
// požadavky se řadí už tady: nikdy neběží dva naráz a nic se navzájem neruší.
let tail: Promise<unknown> = Promise.resolve();
let waiting = 0;
const MAX_WAITING = 6;

/**
 * Vygeneruje HTML stránky včetně obsahu vytvořeného JavaScriptem (WKWebView).
 * Funguje pouze v nativní iOS aplikaci; v prohlížeči/v preview vyhodí chybu.
 */
export function renderHtml(url: string, opts: RenderOptions = {}): Promise<string> {
  return renderPage(url, opts).then((p) => p.html);
}

/** Jako renderHtml, navíc vrací skutečnou adresu po přesměrováních (prázdná, když ji modul nesdělí). */
export function renderPage(url: string, opts: RenderOptions = {}): Promise<{ html: string; url: string }> {
  const WebRenderer = plugin();
  if (!WebRenderer) {
    return Promise.reject(new RenderError("Nativní modul WebRenderer není k dispozici (běžíte v prohlížeči?)"));
  }
  if (waiting >= MAX_WAITING) {
    return Promise.reject(new RenderError("Vykreslování je přetížené (příliš mnoho čekajících stránek)"));
  }
  const delayMs = Math.max(0, Math.min(opts.delayMs ?? 0, 15000));
  waiting++;
  const run = async (): Promise<{ html: string; url: string }> => {
    const end = diag.begin("render", { url, delayMs });
    // Než se sáhne do nativního kódu, musí být záznam na disku – kdyby aplikace spadla.
    await diag.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        WebRenderer.render({ url, delayMs }) as Promise<{ html?: string; url?: string }>,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RenderError("Vykreslení stránky neodpovědělo včas")), 50000 + delayMs);
        }),
      ]);
      const html = res?.html ?? "";
      const finalUrl = typeof res?.url === "string" ? res.url : "";
      end({ ok: true, chars: html.length, finalUrl: finalUrl ? redactUrl(finalUrl) : "" });
      return { html, url: finalUrl };
    } catch (err: any) {
      const message = String(err?.message ?? err ?? "neznámá chyba");
      end({ ok: false, error: message });
      if (err instanceof RenderError) throw err;
      throw new RenderError(message, /terminated|out of memory/i.test(message));
    } finally {
      if (timer) clearTimeout(timer);
      waiting--;
    }
  };
  const result = tail.then(run, run);
  tail = result.catch(() => {});
  return result;
}

/** Upozornění systému na nedostatek paměti (jen nativní aplikace). Vrací funkci pro odhlášení. */
export function onMemoryWarning(cb: () => void): () => void {
  const WebRenderer = plugin();
  if (!WebRenderer?.addListener) return () => {};
  let handle: any;
  let cancelled = false;
  Promise.resolve(WebRenderer.addListener("memoryWarning", () => cb()))
    .then((h: any) => {
      handle = h;
      if (cancelled) h?.remove?.();
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    handle?.remove?.();
  };
}
