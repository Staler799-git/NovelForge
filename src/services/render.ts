import { Capacitor } from "@capacitor/core";

/**
 * Vygeneruje HTML stránky včetně obsahu vytvořeného JavaScriptem (WKWebView).
 * Funguje pouze v nativní iOS aplikaci; v prohlížeči/v preview vyhodí chybu.
 */
export async function renderHtml(url: string): Promise<string> {
  const plugins = (Capacitor as any).Plugins as Record<string, any> | undefined;
  const WebRenderer = plugins?.[ "WebRenderer" ];
  if (!WebRenderer) {
    throw new Error("Nativní modul WebRenderer není k dispozici (běžíte v prohlížeči?)");
  }
  const res = await WebRenderer.render({ url });
  return res.html ?? "";
}
