import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { http, HttpError, isAbort } from "@/services/http";

/** Chyba obsahu: stránka se načetla, ale neobsahuje to, co má (blokace, CAPTCHA, prázdno). */
export class ContentError extends Error {
  constructor(
    message: string,
    /** false = opakování nemá smysl (např. 404). */
    public retryable = true,
  ) {
    super(message);
    this.name = "ContentError";
  }
}

const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/just a moment\.\.\.|checking your browser|cf-browser-verification|cf-chl-|challenge-platform/i, "Web vyžaduje ověření prohlížeče (Cloudflare)"],
  [/g-recaptcha|h-captcha|hcaptcha\.com|verify you are (a )?human|are you a robot|captcha/i, "Web vyžaduje CAPTCHA"],
  [/access denied|error 1020|you have been blocked|403 forbidden/i, "Web odmítl přístup (blokace)"],
  [/too many requests|rate limit(ed)? exceeded|error 1015/i, "Web omezil počet požadavků (rate limit)"],
];

/**
 * Rozpozná stránku, která NENÍ skutečným obsahem (blokace, CAPTCHA…).
 * Vrací důvod, nebo null. Kontroluje se jen u krátkých stránek – dlouhá
 * kapitola může slovo "captcha" obsahovat legitimně.
 */
export function detectBlockPage(html: string, textLength: number): string | null {
  if (textLength > 1500) return null;
  for (const [re, reason] of BLOCK_PATTERNS) {
    if (re.test(html)) return reason;
  }
  return null;
}

export function httpStatusMessage(status: number): string {
  if (status === 404 || status === 410) return `Stránka neexistuje (HTTP ${status})`;
  if (status === 403) return "Web odmítl přístup (HTTP 403)";
  if (status === 429) return "Příliš mnoho požadavků (HTTP 429)";
  if (status >= 500) return `Chyba serveru (HTTP ${status})`;
  if (status === 0) return "Server neodpověděl";
  return `Neočekávaná odpověď serveru (HTTP ${status})`;
}

export abstract class NovelParser {
  abstract canHandle(url: string): boolean;
  abstract fetchMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata>;
  abstract fetchChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]>;
  abstract fetchChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }>;

  /**
   * Načte celý katalog kapitol včetně informací o úplnosti.
   * Výchozí implementace obalí fetchChapterList (jednostránkové weby).
   */
  async fetchCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
    const chapters = await this.fetchChapterList(url, opts);
    opts?.onProgress?.({ pagesLoaded: 1, pagesTotal: 1, chaptersFound: chapters.length });
    return { chapters, pagesLoaded: 1, complete: true, aborted: false, warnings: [] };
  }

  /**
   * Načte HTML a OVĚŘÍ odpověď:
   *  - stavový kód mimo 2xx => chyba s konkrétním důvodem,
   *  - blokační / CAPTCHA stránka => chyba,
   *  - prázdné tělo se skripty => zkusí nativní WKWebView (JS rendering).
   *
   * Nikdy nevrátí chybovou stránku jako platný obsah.
   */
  protected async fetchHtml(url: string, opts?: FetchOptions): Promise<string> {
    const res = await http.get(url, { timeoutMs: 30000, signal: opts?.signal });
    let html = res.data ?? "";

    const textLen = (h: string) => {
      const doc = this.parseHtml(h);
      return (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().length;
    };

    let len = html ? textLen(html) : 0;
    let problem: string | null = null;
    let retryable = true;

    if (!res.ok) {
      problem = detectBlockPage(html, len) ?? httpStatusMessage(res.status);
      retryable = !(res.status === 404 || res.status === 410);
    } else if (!html.trim()) {
      problem = "Server vrátil prázdnou odpověď";
    } else {
      problem = detectBlockPage(html, len);
    }

    const looksJsRendered = res.ok && len < 50 && /<script/i.test(html);

    // Blokace nebo JS rendering: skutečný prohlížeč (WKWebView) často projde.
    if ((problem && retryable && res.status !== 429 && res.status < 500) || looksJsRendered) {
      try {
        const { renderHtml } = await import("@/services/render");
        const rendered = await renderHtml(url);
        if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
        const rLen = rendered ? textLen(rendered) : 0;
        if (rendered && rLen > len && !detectBlockPage(rendered, rLen)) {
          html = rendered;
          len = rLen;
          problem = null;
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        // Nativní modul není k dispozici (prohlížeč/testy) nebo rendering selhal.
      }
    }

    if (problem) {
      if (!res.ok && !detectBlockPage(res.data ?? "", len)) {
        const e = new HttpError(problem, res.status, url);
        (e as any).retryable = retryable;
        throw e;
      }
      throw new ContentError(problem, retryable);
    }
    return html;
  }

  protected parseHtml(html: string): Document {
    return new DOMParser().parseFromString(html, "text/html");
  }

  protected meta(doc: Document, name: string): string | null {
    const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.getAttribute("content") ?? null;
  }

  protected og(doc: Document, prop: string): string | null {
    const el = doc.querySelector(`meta[property="og:${prop}"], meta[name="og:${prop}"]`);
    return el?.getAttribute("content") ?? null;
  }

  protected absoluteUrl(base: string, href: string): string {
    return absoluteUrl(base, href);
  }

  protected sameDomain(a: string, b: string): boolean {
    try {
      return new URL(a).hostname === new URL(b).hostname;
    } catch {
      return false;
    }
  }
}

export function absoluteUrl(base: string, href: string): string {
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return href;
  }
}

export function cleanText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function extractTitle(doc: Document): string {
  return (
    doc.querySelector("h1")?.textContent?.trim() ||
    doc.querySelector("title")?.textContent?.trim() ||
    ""
  );
}

const PLACEHOLDER_IMG = /(placeholder|loading|lazy|blank|spacer|default|nocover|no-cover|no_cover|pixel|1x1)\.(gif|png|svg|jpg|jpeg|webp)|^data:|^about:/i;

function firstSrcsetUrl(srcset: string | null): string | null {
  if (!srcset) return null;
  const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
  return first || null;
}

function jsonLdImage(doc: Document): string | null {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const pick = (v: any): string | null => {
        if (!v) return null;
        if (typeof v === "string") return v;
        if (Array.isArray(v)) {
          for (const x of v) {
            const r = pick(x);
            if (r) return r;
          }
          return null;
        }
        if (typeof v === "object") return pick(v.url ?? v.contentUrl ?? v["@id"]);
        return null;
      };
      const walk = (node: any): string | null => {
        if (!node || typeof node !== "object") return null;
        if (Array.isArray(node)) {
          for (const n of node) {
            const r = walk(n);
            if (r) return r;
          }
          return null;
        }
        return pick(node.image ?? node.thumbnailUrl) ?? walk(node["@graph"]) ?? walk(node.mainEntity);
      };
      const found = walk(JSON.parse(s.textContent ?? ""));
      if (found) return found;
    } catch {
      /* neplatný JSON-LD ignorujeme */
    }
  }
  return null;
}

/**
 * Najde URL obálky. Pořadí zdrojů:
 *  1. Open Graph / Twitter / link rel=image_src / itemprop=image
 *  2. JSON-LD (schema.org Book.image)
 *  3. <img> v typických kontejnerech obálky – včetně LAZY-LOAD atributů
 *     (data-src, data-original, data-lazy-src, srcset). Mnoho webů dává do
 *     `src` jen zástupný obrázek a skutečnou adresu do `data-src`.
 *
 * Vrací vždy ABSOLUTNÍ http(s) URL, nebo undefined.
 */
export function findCoverUrl(doc: Document, baseUrl: string, extraSelectors: string[] = []): string | undefined {
  const candidates: Array<string | null | undefined> = [];
  const metaContent = (sel: string) => doc.querySelector(sel)?.getAttribute("content");

  candidates.push(
    metaContent('meta[property="og:image:secure_url"]'),
    metaContent('meta[property="og:image"], meta[name="og:image"]'),
    metaContent('meta[property="og:image:url"]'),
    metaContent('meta[name="twitter:image"], meta[property="twitter:image"], meta[name="twitter:image:src"]'),
    doc.querySelector('link[rel="image_src"]')?.getAttribute("href"),
    metaContent('meta[itemprop="image"]'),
    jsonLdImage(doc),
  );

  const imgSelectors = [
    ...extraSelectors,
    ".cover img", "figure.cover img", ".novel-cover img", ".book-cover img", ".fixed-img img",
    ".book img", ".bookimg img", ".thumb img", ".thumbnail img", "img.cover", "img.novel-cover",
    "img.book-cover", 'img[itemprop="image"]', ".summary_image img", ".info-holder img",
  ];
  for (const sel of imgSelectors) {
    let imgs: Element[] = [];
    try {
      imgs = Array.from(doc.querySelectorAll(sel));
    } catch {
      continue;
    }
    for (const img of imgs) {
      candidates.push(
        img.getAttribute("data-src"),
        img.getAttribute("data-original"),
        img.getAttribute("data-lazy-src"),
        img.getAttribute("data-lazy"),
        img.getAttribute("data-cfsrc"),
        firstSrcsetUrl(img.getAttribute("data-srcset")),
        firstSrcsetUrl(img.getAttribute("srcset")),
        img.getAttribute("src"),
      );
    }
  }

  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  const base = baseHref ? absoluteUrl(baseUrl, baseHref) : baseUrl;

  for (const c of candidates) {
    const raw = (c ?? "").trim();
    if (!raw || PLACEHOLDER_IMG.test(raw)) continue;
    const abs = absoluteUrl(base, raw); // řeší i "//cdn…" a relativní cesty
    if (/^https?:\/\//i.test(abs)) return abs;
  }
  return undefined;
}

/**
 * Jazyk knihy pro metadata (BCP 47). Bere <html lang>, og:locale a
 * content-language; když chybí, odhadne z textu (čeština vs. angličtina).
 * Dřívější kód vracel natvrdo "cs", takže anglické novely měly v EPUB lang="cs".
 */
export function detectLanguage(doc: Document, sampleText = "", fallback = "en"): string {
  const raw =
    doc.documentElement?.getAttribute("lang") ||
    doc.querySelector('meta[property="og:locale"]')?.getAttribute("content") ||
    doc.querySelector('meta[http-equiv="content-language" i]')?.getAttribute("content") ||
    doc.querySelector('meta[name="language"]')?.getAttribute("content") ||
    "";
  const norm = normalizeLanguage(raw, "");
  if (norm) return norm;
  const text = sampleText || doc.body?.textContent || "";
  const sample = text.slice(0, 4000);
  if (sample.length > 40) {
    const czech = (sample.match(/[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ]/g) ?? []).length;
    if (czech / sample.length > 0.02) return "cs";
    if (/[\u4e00-\u9fff]/.test(sample)) return "zh";
    return "en";
  }
  return fallback;
}

/** "en_US" -> "en-US", "EN" -> "en"; neplatné hodnoty nahradí `fallback`. */
export function normalizeLanguage(raw: string | undefined | null, fallback = "en"): string {
  const v = (raw ?? "").trim().replace(/_/g, "-");
  const m = v.match(/^([a-zA-Z]{2,3})(?:-([a-zA-Z]{4}))?(?:-([a-zA-Z]{2}|\d{3}))?$/);
  if (!m) return fallback;
  let out = m[1].toLowerCase();
  if (m[2]) out += "-" + m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  if (m[3]) out += "-" + m[3].toUpperCase();
  return out;
}
