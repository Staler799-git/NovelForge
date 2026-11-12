import { Capacitor, CapacitorHttp } from "@capacitor/core";

export interface HttpResponse {
  url: string;
  status: number;
  ok: boolean;
  data: string;
  headers: Record<string, string>;
}

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 NovelForge/1.0";

/**
 * HTTP klient pro stahování kapitol.
 *
 * Na iOS používá nativní CapacitorHttp (NSURLSession) – žádná CORS omezení,
 * cookies a vlastní hlavičky fungují stejně jako v nativní aplikaci.
 * V prohlížeči / testech padá na standardní fetch.
 */
export class HttpClient {
  private baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };

  async get(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpResponse> {
    const headers = { ...this.baseHeaders, ...(opts.headers ?? {}) };
    const timeout = opts.timeoutMs ?? 30000;

    // Prefer the native Capacitor HTTP core plugin (NSURLSession on iOS, no CORS limits, cookies supported).
    if (Capacitor.isNativePlatform()) {
      try {
        const res = await CapacitorHttp.get({
          url,
          headers,
          connectTimeout: timeout,
          readTimeout: timeout,
        });
        const data = res.data;
        return {
          url: res.url ?? url,
          status: Number(res.status ?? 0),
          ok: Number(res.status ?? 0) >= 200 && Number(res.status ?? 0) < 300,
          data: typeof data === "string" ? data : data == null ? "" : JSON.stringify(data),
          headers: (res.headers as Record<string, string>) ?? {},
        };
      } catch (pluginErr) {
        // Fall through to browser fetch (web / preview mode).
        console.warn("CapacitorHttp failed, falling back to fetch", pluginErr);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers,
        signal: controller.signal,
        referrerPolicy: "no-referrer",
      });
      const text = await res.text();
      return {
        url: res.url,
        status: res.status,
        ok: res.ok,
        data: text,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  setDefaultHeader(name: string, value: string): void {
    this.baseHeaders[name] = value;
  }
}

export const http = new HttpClient();
