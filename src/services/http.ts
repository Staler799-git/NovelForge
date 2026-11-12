import { Http } from "@capacitor-community/http";

export interface HttpResponse {
  url: string;
  status: number;
  ok: boolean;
  data: string;
  headers: Record<string, string>;
}

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 NovelForge/1.0";

export class HttpClient {
  private baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
  };

  async get(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<HttpResponse> {
    const headers = { ...this.baseHeaders, ...(opts.headers ?? {}) };

    // Prefer Capacitor HTTP plugin (native NSURLSession on iOS, no CORS limitations, cookie support).
    try {
      const res = await Http.get({
        url,
        headers,
        connectTimeout: opts.timeoutMs ?? 30000,
        readTimeout: opts.timeoutMs ?? 30000,
      });
      return {
        url: res.url ?? url,
        status: Number(res.status ?? 0),
        ok: Number(res.status ?? 0) >= 200 && Number(res.status ?? 0) < 300,
        data: typeof res.data === "string" ? res.data : String(res.data ?? ""),
        headers: (res.headers as Record<string, string>) ?? {},
      };
    } catch (pluginErr) {
      // Fallback to browser fetch (web / preview mode).
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
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
      clearTimeout(timeout);
    }
  }

  setDefaultHeader(name: string, value: string): void {
    this.baseHeaders[name] = value;
  }
}

export const http = new HttpClient();
