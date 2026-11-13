import { Capacitor } from "@capacitor/core";

/**
 * Vygeneruje HTML stránky včetně obsahu vytvořeného JavaScriptem (WKWebView).
 * Funguje pouze v nativní iOS aplikaci; v prohlížeči/v preview vyhodí chybu.
 */
export interface RenderOptions {
  /** Prodleva (ms) po načtení stránky, než se přečte DOM – pro obsah dotahovaný skriptem. Max 15 s. */
  delayMs?: number;
}

export async function renderHtml(url: string, opts: RenderOptions = {}): Promise<string> {
  const plugins = (Capacitor as any).Plugins as Record<string, any> | undefined;
  const WebRenderer = plugins?.[ "WebRenderer" ];
  if (!WebRenderer) {
    throw new Error("Nativní modul WebRenderer není k dispozici (běžíte v prohlížeči?)");
  }
  const res = await WebRenderer.render({ url, delayMs: Math.max(0, Math.min(opts.delayMs ?? 0, 15000)) });
  return res.html ?? "";
}
