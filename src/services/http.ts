import { Capacitor, CapacitorHttp } from "@capacitor/core";

export interface HttpResponse {
  url: string;
  status: number;
  ok: boolean;
  data: string;
  headers: Record<string, string>;
}

export interface BinaryResponse {
  url: string;
  status: number;
  ok: boolean;
  /** Obsah zakódovaný do base64 (bez prefixu data:). */
  base64: string;
  contentType: string;
}

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Chyba HTTP vrstvy s čitelným důvodem a (pokud je znám) stavovým kódem. */
export class HttpError extends Error {
  constructor(
    message: string,
    public status?: number,
    public url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class AbortedError extends Error {
  constructor(message = "Přerušeno") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbort(err: unknown): boolean {
  return (err as any)?.name === "AbortError";
}

const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] ?? "") : "";
}

/** Uint8Array -> base64 po blocích (String.fromCharCode(...velkéPole) přeteče zásobník). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Promise, která skončí chybou AbortError, jakmile je signál zrušen. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function describeNetworkError(err: unknown): string {
  const msg = (err as any)?.message ?? String(err);
  if (/timed? ?out/i.test(msg)) return "Vypršel časový limit požadavku";
  if (/offline|internet|network|connection/i.test(msg)) return `Chyba sítě: ${msg}`;
  return msg || "Neznámá chyba sítě";
}

/**
 * HTTP klient.
 *
 * Na iOS používá nativní CapacitorHttp (NSURLSession) – žádná CORS omezení.
 * V prohlížeči / testech používá fetch.
 *
 * Metody NEVYHAZUJÍ chybu kvůli stavovému kódu – vrací `status`/`ok`, aby
 * volající mohl rozhodnout (viz NovelParser.fetchHtml). Chybu vyhodí jen při
 * selhání sítě, vypršení limitu nebo přerušení.
 */
export class HttpClient {
  private baseHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,cs;q=0.8",
    "Cache-Control": "no-cache",
  };

  async get(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
    const headers = { ...this.baseHeaders, ...(opts.headers ?? {}) };
    const timeout = opts.timeoutMs ?? 30000;
    if (opts.signal?.aborted) throw new AbortedError();

    if (Capacitor.isNativePlatform()) {
      let res;
      try {
        res = await raceAbort(
          CapacitorHttp.get({ url, headers, connectTimeout: timeout, readTimeout: timeout, responseType: "text" }),
          opts.signal,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new HttpError(describeNetworkError(err), undefined, url);
      }
      const status = Number(res.status ?? 0);
      const data = res.data;
      return {
        url: res.url ?? url,
        status,
        ok: status >= 200 && status < 300,
        data: typeof data === "string" ? data : data == null ? "" : JSON.stringify(data),
        headers: (res.headers as Record<string, string>) ?? {},
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { headers, signal: controller.signal, referrerPolicy: "no-referrer" });
      const text = await res.text();
      return {
        url: res.url || url,
        status: res.status,
        ok: res.ok,
        data: text,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortedError();
      if ((err as any)?.name === "AbortError") throw new HttpError("Vypršel časový limit požadavku", undefined, url);
      throw new HttpError(describeNetworkError(err), undefined, url);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Odešle JSON metodou POST. Stejně jako `get` nevyhazuje chybu kvůli stavovému kódu. */
  async postJson(url: string, body: unknown, opts: HttpOptions = {}): Promise<HttpResponse> {
    const headers = { ...this.baseHeaders, Accept: "application/json", "Content-Type": "application/json", ...(opts.headers ?? {}) };
    const timeout = opts.timeoutMs ?? 30000;
    if (opts.signal?.aborted) throw new AbortedError();

    if (Capacitor.isNativePlatform()) {
      let res;
      try {
        res = await raceAbort(
          CapacitorHttp.post({ url, headers, data: body, connectTimeout: timeout, readTimeout: timeout, responseType: "text" }),
          opts.signal,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new HttpError(describeNetworkError(err), undefined, url);
      }
      const status = Number(res.status ?? 0);
      const data = res.data;
      return {
        url: res.url ?? url,
        status,
        ok: status >= 200 && status < 300,
        data: typeof data === "string" ? data : data == null ? "" : JSON.stringify(data),
        headers: (res.headers as Record<string, string>) ?? {},
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      return { url: res.url || url, status: res.status, ok: res.ok, data: text, headers: Object.fromEntries(res.headers.entries()) };
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortedError();
      if ((err as any)?.name === "AbortError") throw new HttpError("Vypršel časový limit požadavku", undefined, url);
      throw new HttpError(describeNetworkError(err), undefined, url);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Stáhne binární soubor (obrázek) a vrátí ho jako base64.
   *
   * Na iOS vrací CapacitorHttp pro responseType "blob" přímo base64 řetězec –
   * žádný převod přes text, který by binární data poškodil.
   */
  async getBinary(url: string, opts: HttpOptions = {}): Promise<BinaryResponse> {
    const headers = {
      ...this.baseHeaders,
      // JPEG/PNG mají přednost (jsou to základní formáty EPUB); AVIF a WebP se přijmou a převedou.
      Accept: "image/jpeg,image/png,image/webp;q=0.9,image/avif;q=0.8,image/*;q=0.7,*/*;q=0.5",
      ...(opts.headers ?? {}),
    };
    const timeout = opts.timeoutMs ?? 30000;
    if (opts.signal?.aborted) throw new AbortedError();

    if (Capacitor.isNativePlatform()) {
      let res;
      try {
        res = await raceAbort(
          CapacitorHttp.get({ url, headers, connectTimeout: timeout, readTimeout: timeout, responseType: "blob" }),
          opts.signal,
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new HttpError(describeNetworkError(err), undefined, url);
      }
      const status = Number(res.status ?? 0);
      return {
        url: res.url ?? url,
        status,
        ok: status >= 200 && status < 300,
        base64: typeof res.data === "string" ? res.data.replace(/\s+/g, "") : "",
        contentType: headerValue(res.headers as Record<string, string>, "content-type"),
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url, { headers, signal: controller.signal, referrerPolicy: "no-referrer" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return {
        url: res.url || url,
        status: res.status,
        ok: res.ok,
        base64: bytesToBase64(bytes),
        contentType: res.headers.get("content-type") ?? "",
      };
    } catch (err) {
      if (opts.signal?.aborted) throw new AbortedError();
      throw new HttpError(describeNetworkError(err), undefined, url);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  setDefaultHeader(name: string, value: string): void {
    this.baseHeaders[name] = value;
  }
}

export const http = new HttpClient();
