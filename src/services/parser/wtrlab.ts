/**
 * WTR-LAB (wtr-lab.com).
 *
 * Web je aplikace v Next.js. Jak data zpřístupňuje (ověřeno ze zdrojových kódů
 * tří udržovaných open-source čteček – WebToEpub, LNReader, QuickNovel –
 * NIKOLI živým požadavkem z vývojového prostředí, odkud web není dostupný):
 *
 *   - stránka novely nese v <script id="__NEXT_DATA__"> objekt
 *     props.pageProps.serie.serie_data { raw_id, slug, chapter_count,
 *     data: { title, author, description, image } }; v HTML je vidět jen
 *     několik posledních kapitol,
 *   - úplný seznam kapitol si stránka dotahuje z vlastního rozhraní
 *     GET /api/chapters/{id}?start=A&end=B  ->  { chapters: [{ order, title }] },
 *   - text kapitoly si stránka dotahuje z POST /api/reader/get.
 *
 * Parser proto:
 *   1) metadata čte ze stránky (statické HTML, případně vykreslení ve WKWebView),
 *   2) katalog načítá po dávkách z /api/chapters a PŘED označením za kompletní
 *      kontroluje pokrytí rozsahu 1…N, počet unikátních kapitol a mezery,
 *   3) adresy kapitol nikdy neodhaduje – co web v seznamu nevrátil, v katalogu není,
 *   4) formát každé odpovědi přísně ověřuje; neznámý tvar = chyba, ne odhad.
 *
 * Přihlášení, CAPTCHA/Turnstile, zamčené kapitoly ani šifrovaný obsah se neobcházejí.
 */
import { NovelParser, ContentError, cleanText, findCoverUrl, normalizeLanguage, absoluteUrl } from "./base";
import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { cleanChapterElement, stripBoilerplateXhtml } from "@/services/clean";
import { sanitizeToXhtml, assertChapterContent, escapeXml, htmlToText } from "@/services/content";
import { http, isAbort } from "@/services/http";
import { numberCoverage, formatRanges } from "@/services/catalog";

const SITE_NAMES = ["wtr-lab.com", "wtr-lab", "wtr lab"];
const SITE_TITLE_RE = /^\s*(wtr[-\s]?lab)\s*$/i;

export interface WtrUrl {
  origin: string;
  lang: string;
  id: string;
  slug: string;
  /** Číslo kapitoly, pokud adresa míří na kapitolu. */
  chapter: number | null;
  novelUrl: string;
}

/** Rozloží adresu novely nebo kapitoly: /{lang}/novel/{id}/{slug}[/chapter-N] */
export function parseWtrUrl(url: string): WtrUrl | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)wtr-lab\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let i = 0;
  let lang = "en";
  if (parts[0] && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]) && parts[0].toLowerCase() !== "novel") {
    lang = parts[0].toLowerCase();
    i = 1;
  }
  let id = "";
  let slug = "";
  if (parts[i] === "novel" && /^\d+$/.test(parts[i + 1] ?? "")) {
    id = parts[i + 1];
    slug = parts[i + 2] ?? "";
    i += 3;
  } else {
    const m = (parts[i] ?? "").match(/^serie-(\d+)$/i); // starší tvar adres
    if (!m) return null;
    id = m[1];
    slug = parts[i + 1] ?? "";
    i += 2;
  }
  if (!slug || /^chapter-\d+$/i.test(slug)) return null;
  const ch = (parts[i] ?? "").match(/^chapter-(\d+)$/i);
  const prefix = parts.slice(0, i).join("/");
  return { origin: u.origin, lang, id, slug, chapter: ch ? parseInt(ch[1], 10) : null, novelUrl: `${u.origin}/${prefix}` };
}

/** Vytáhne JSON z <script id="__NEXT_DATA__">. */
export function extractNextData(html: string): unknown | null {
  const m = html.match(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Projde strom dat do šířky (s omezením velikosti). */
function* walk(root: unknown): Generator<Obj | unknown[]> {
  const queue: unknown[] = [root];
  let budget = 60000;
  while (queue.length && budget-- > 0) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      yield v;
      for (const x of v.slice(0, 20000)) if (x && typeof x === "object") queue.push(x);
    } else if (isObj(v)) {
      yield v;
      for (const x of Object.values(v)) if (x && typeof x === "object") queue.push(x);
    }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? cleanText(v) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? parseInt(v, 10) : null);
const COUNT_KEYS = ["chapter_count", "chapters_count", "chapterCount", "total_chapters", "totalChapters", "raw_chapter_count"];
const AUTHOR_KEYS = ["author", "author_name", "authorName", "writer"];
const COVER_KEYS = ["image", "cover", "cover_url", "coverUrl", "thumbnail", "poster"];
const DESC_KEYS = ["description", "synopsis", "summary", "desc"];

interface SerieData {
  title: string;
  author: string;
  description: string;
  cover: string;
  count: number | null;
}

function pick(o: Obj, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return str(v);
    if (isObj(v)) {
      const inner = str(v.name) || str(v.title) || str(v.url);
      if (inner) return inner;
    }
  }
  return "";
}

/**
 * Najde v datech objekt popisující novelu: má název a aspoň dva další znaky
 * novely (autor, popis, obálka, počet kapitol). Když adresa nese ID nebo slug,
 * dostane přednost objekt, v jehož okolí se tyto hodnoty vyskytují.
 */
export function findSerie(data: unknown, target?: Pick<WtrUrl, "id" | "slug">): SerieData | null {
  let best: { score: number; s: SerieData } | null = null;
  for (const node of walk(data)) {
    if (!isObj(node)) continue;
    const title = str(node.title) || str(node.name);
    if (!title || SITE_TITLE_RE.test(title)) continue;
    const author = pick(node, AUTHOR_KEYS);
    const description = pick(node, DESC_KEYS);
    const cover = pick(node, COVER_KEYS);
    let count: number | null = null;
    for (const k of COUNT_KEYS) count ??= num(node[k]);
    let score = (author ? 1 : 0) + (description ? 1 : 0) + (cover ? 1 : 0) + (count !== null ? 1 : 0);
    if (score < 2) continue;
    if (target) {
      const flat = JSON.stringify(node).slice(0, 4000);
      if (target.slug && flat.includes(target.slug)) score += 3;
      if (target.id && (num(node.id) === Number(target.id) || num(node.serie_id) === Number(target.id) || num(node.raw_id) === Number(target.id))) score += 3;
    }
    if (!best || score > best.score) best = { score, s: { title, author, description, cover, count } };
  }
  if (!best) return null;
  // Počet kapitol a další údaje mohou být o úroveň výš než název (obal { data: {...}, chapter_count }).
  if (best.s.count === null || !best.s.author) {
    for (const node of walk(data)) {
      if (!isObj(node)) continue;
      const inner = Object.values(node).find((v) => isObj(v) && (str(v.title) || str(v.name)) === best!.s.title);
      if (!inner) continue;
      for (const k of COUNT_KEYS) best.s.count ??= num(node[k]);
      best.s.author ||= pick(node, AUTHOR_KEYS);
      best.s.cover ||= pick(node, COVER_KEYS);
      best.s.description ||= pick(node, DESC_KEYS);
    }
  }
  return best.s;
}

interface ListedChapter {
  order: number;
  title: string;
}

/** Najde pole kapitol: objekty s pořadovým číslem a (volitelně) názvem. */
export function findChapterList(data: unknown): ListedChapter[] {
  let best: ListedChapter[] = [];
  for (const node of walk(data)) {
    if (!Array.isArray(node) || node.length < 2 || node.length <= best.length) continue;
    const out: ListedChapter[] = [];
    for (const x of node) {
      if (!isObj(x)) break;
      const order = num(x.order) ?? num(x.chapter_no) ?? num(x.chapterNo) ?? num(x.number) ?? num(x.index);
      if (order === null || order < 0) break;
      out.push({ order, title: str(x.title) || str(x.name) });
    }
    if (out.length !== node.length) continue;
    if (new Set(out.map((c) => c.order)).size !== out.length) continue;
    best = out;
  }
  return best.sort((a, b) => a.order - b.order);
}

/** Najde text kapitoly v datech stránky: pole odstavců nebo dlouhý řetězec pod klíčem těla. */
export function findChapterBody(data: unknown): { title: string; paragraphs: string[]; node: Record<string, unknown>; parent: Record<string, unknown> | null } | null {
  const BODY_KEYS = ["body", "content", "text", "paragraphs"];
  let best: { title: string; paragraphs: string[]; len: number; node: Obj } | null = null;
  for (const node of walk(data)) {
    if (!isObj(node)) continue;
    for (const k of BODY_KEYS) {
      const v = node[k];
      let paragraphs: string[] = [];
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) paragraphs = (v as string[]).map((x) => x.trim()).filter(Boolean);
      else if (typeof v === "string" && v.length >= 200) paragraphs = [v];
      const len = paragraphs.reduce((s, p) => s + p.length, 0);
      if (len < 200 || (best && len <= best.len)) continue;
      best = { title: str(node.title) || str(node.name), paragraphs, len, node };
    }
  }
  // Název může být o úroveň výš ({ title, data: { body } }).
  let parent: Obj | null = null;
  if (best) {
    for (const node of walk(data)) {
      if (!isObj(node) || !Object.values(node).includes(best.node)) continue;
      parent = node;
      if (!best.title) best.title = str(node.title) || str(node.name);
      break;
    }
  }
  return best ? { title: best.title, paragraphs: best.paragraphs, node: best.node, parent } : null;
}

function stripSiteSuffix(title: string): string {
  return cleanText(title.replace(/\s*[-|–—·:]\s*wtr[-\s]?lab.*$/i, "").replace(/^wtr[-\s]?lab\s*[-|–—·:]\s*/i, ""));
}

const READER_MODES = ["ai", "web"];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tryJson(text: string | null | undefined): unknown | null {
  const s = (text ?? "").trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Web v názvech a textu používá značky %{viditelný text|base64} (případně
 * %{"viditelný text":"base64"}). Nahradí je čitelným textem.
 */
export function resolveTokens(text: string): string {
  if (!text || text.indexOf("%{") < 0) return text;
  // eslint-disable-next-line no-control-regex
  return text.replace(/%\{(?:"([^"]*)":\s*"?([A-Za-z0-9+/=_-]+)"?|([^|{}%\u0000-\u001f]+?)\s*\|\s*([A-Za-z0-9+/=_-]+))\}/g, (match, s1, b1, s2, b2) => {
    const safe = String(s1 ?? s2 ?? "").trim();
    const b64 = String(b1 ?? b2 ?? "").trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    let decoded = "";
    try {
      if (/^[A-Za-z0-9+/]+$/.test(b64) && b64.length % 4 !== 1) {
        const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      }
    } catch {
      decoded = "";
    }
    return decoded || safe || match;
  });
}

/** Odpověď /api/chapters: { chapters: [{ order, title }] } (případně pod `data`). Cokoli jiného => null. */
export function readChapterBatch(json: unknown): Array<{ order: number; title: string }> | null {
  const list = isObj(json) ? (Array.isArray(json.chapters) ? json.chapters : isObj(json.data) && Array.isArray(json.data.chapters) ? json.data.chapters : null) : null;
  if (!list) return null;
  const out: Array<{ order: number; title: string }> = [];
  for (const x of list) {
    if (!isObj(x)) return null;
    const order = num(x.order);
    if (order === null || !Number.isInteger(order)) return null;
    out.push({ order, title: str(x.title) || str(x.name) });
  }
  return out;
}

/** Souvislé rozsahy z čísel: [3134,3135,3138] -> [[3134,3135],[3138,3138]] */
function rangesOf(numbers: number[]): Array<[number, number]> {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/**
 * Ověří, že data patří k požadované novele a kapitole. Kontrolují se jen pole,
 * která web skutečně vrátil (raw_id = číslo novely z adresy, order/chapter_no =
 * číslo kapitoly); chybějící pole nejsou chyba. Vrací popis neshody, nebo null.
 */
export function identityMismatch(node: unknown, t: Pick<WtrUrl, "id" | "chapter">): string | null {
  if (!isObj(node)) return null;
  const raw = num(node.raw_id);
  if (raw !== null && raw !== Number(t.id)) return `odpověď patří jiné novele (číslo ${raw}, čekám ${t.id})`;
  if (t.chapter !== null) {
    for (const k of ["chapter_no", "order"]) {
      const n = num(node[k]);
      if (n !== null && n !== t.chapter) return `odpověď patří jiné kapitole (číslo ${n}, čekám ${t.chapter})`;
    }
  }
  return null;
}

/** Chyba „cizí obsah“: nikdy se neopakuje a kapitola se neuloží. */
function wrongContent(reason: string): ContentError {
  return new ContentError(`WTR-LAB vrátil obsah, který nepatří k této kapitole – ${reason}. Kapitola se neuložila.`, false);
}

export class WtrLabParser extends NovelParser {
  override readonly name: string = "wtrlab";
  /** Dokud není bezpečná souběžnost ověřená na zařízení, jede WTR-LAB vždy po jedné kapitole. */
  override readonly maxConcurrency: number = 1;
  canHandle(url: string): boolean {
    try {
      return /(^|\.)wtr-lab\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  private target(url: string): WtrUrl {
    const t = parseWtrUrl(url);
    if (!t) {
      throw new ContentError("Adresa není stránkou novely ani kapitoly na WTR-LAB (čekám …/novel/ČÍSLO/nazev).", false);
    }
    return t;
  }

  /** Statické HTML; když neobsahuje použitelná data, zkusí vykreslení ve WKWebView. */
  private async load(url: string, usable: (html: string) => boolean, opts?: FetchOptions, renderDelayMs = 0): Promise<string> {
    let html = "";
    let firstError: unknown = null;
    try {
      html = await this.fetchHtml(url, opts);
    } catch (err) {
      if (isAbort(err)) throw err;
      firstError = err;
    }
    if (html && usable(html)) return html;
    try {
      const { renderPage } = await import("@/services/render");
      const page = await renderPage(url, { delayMs: renderDelayMs });
      if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
      // Web mohl přesměrovat jinam (úvodní stránka, jiná novela, jiná kapitola).
      const want = parseWtrUrl(url);
      const got = page.url ? parseWtrUrl(page.url) : null;
      if (page.url && want && (!got || got.id !== want.id || (want.chapter !== null && got.chapter !== want.chapter))) {
        throw wrongContent("stránka byla přesměrována na jinou adresu");
      }
      const rendered = page.html;
      if (rendered && usable(rendered)) return rendered;
      if (rendered && !html) html = rendered;
    } catch (err) {
      if (isAbort(err)) throw err;
      // Cizí obsah a kritická chyba vykreslení (pád procesu, paměť) se nesmí zamlčet.
      if (err instanceof ContentError || (err as { critical?: boolean })?.critical === true) throw err;
      // WKWebView není k dispozici (prohlížeč, testy) nebo vykreslení selhalo.
    }
    if (!html && firstError) throw firstError;
    return html;
  }

  private readSerie(html: string, t: WtrUrl): SerieData | null {
    const data = extractNextData(html);
    const fromData = data ? findSerie(data, t) : null;
    const doc = this.parseHtml(html);

    // JSON-LD (Book) a viditelná stránka jako doplněk / záloha
    let ld: SerieData | null = null;
    for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        ld = findSerie(JSON.parse(s.textContent ?? ""), t) ?? ld;
      } catch {
        /* neplatný JSON-LD */
      }
    }
    const h1 = stripSiteSuffix(cleanText(doc.querySelector("h1")?.textContent ?? ""));
    const og = stripSiteSuffix(this.og(doc, "title") ?? "");
    const title = fromData?.title || ld?.title || (h1 && !SITE_TITLE_RE.test(h1) ? h1 : "") || (og && !SITE_TITLE_RE.test(og) ? og : "");
    if (!title) return null;

    let count = fromData?.count ?? ld?.count ?? null;
    if (count === null) {
      const m = cleanText(doc.body?.textContent ?? "").match(/\b(\d{1,5})\s+chapters?\b/i);
      if (m) count = parseInt(m[1], 10);
    }
    const authorEl = doc.querySelector('a[href*="/author/"], [itemprop=author], .author');
    return {
      title,
      author: fromData?.author || ld?.author || cleanText(authorEl?.textContent ?? "").replace(/^author:?\s*/i, ""),
      description: fromData?.description || ld?.description || this.og(doc, "description") || this.meta(doc, "description") || "",
      cover: fromData?.cover || ld?.cover || findCoverUrl(doc, t.novelUrl) || "",
      count,
    };
  }

  async fetchMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata> {
    const t = this.target(url);
    const html = await this.load(t.novelUrl, (h) => !!this.readSerie(h, t), opts);
    const serie = this.readSerie(html, t);
    if (!serie) {
      throw new ContentError(
        "Údaje o novele se na WTR-LAB nepodařilo spolehlivě přečíst (stránka vrátila jen obecné informace o webu). Web možná vyžaduje přihlášení nebo změnil strukturu.",
        false,
      );
    }
    return {
      title: resolveTokens(serie.title),
      author: resolveTokens(serie.author),
      description: serie.description ? htmlToText(resolveTokens(serie.description)) : undefined,
      language: normalizeLanguage(t.lang, "en"),
      coverUrl: serie.cover ? absoluteUrl(t.novelUrl, serie.cover) : undefined,
      sourceUrl: t.novelUrl,
      sourceDomain: new URL(t.novelUrl).hostname,
      declaredChapters: serie.count ?? undefined,
    };
  }

  async fetchChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]> {
    return (await this.fetchCatalog(url, opts)).chapters;
  }

  /** Prodleva mezi dávkami katalogu (ms). */
  catalogDelayMs = 400;
  /** Nejkratší odstup mezi požadavky na text kapitol (ms) – web omezuje rychlost. */
  chapterIntervalMs = 3000;
  /** Prodleva po načtení stránky ve WKWebView, než se čte text dotahovaný skriptem. */
  renderDelayMs = 4000;
  private lastChapterAt = 0;
  private preferredMode: string | null = null;

  /**
   * Načte JSON z datového rozhraní webu – stejného, které používá stránka sama.
   * Nejdřív běžným požadavkem; když odpověď není JSON (web vrátil ověření
   * prohlížeče), otevře tutéž adresu ve WKWebView a přečte zobrazený dokument.
   * Vrací i důvod neúspěchu, aby ho šlo ukázat uživateli.
   */
  private async fetchJson(url: string, referer: string, opts?: FetchOptions): Promise<{ json: unknown | null; reason: string }> {
    let reason = "";
    try {
      const res = await http.get(url, { timeoutMs: 30000, signal: opts?.signal, headers: { Accept: "application/json", Referer: referer } });
      const parsed = tryJson(res.data);
      if (res.ok && parsed !== null) return { json: parsed, reason: "" };
      reason = !res.ok ? `HTTP ${res.status}` : "odpověď není JSON";
      if (/just a moment|challenge-platform|cf-chl/i.test(res.data ?? "")) reason += " (web vyžaduje ověření prohlížeče)";
      if (res.status === 404 || res.status === 410) return { json: null, reason };
    } catch (err) {
      if (isAbort(err)) throw err;
      reason = (err as Error)?.message || "chyba sítě";
    }
    try {
      const { renderHtml } = await import("@/services/render");
      const rendered = await renderHtml(url);
      if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
      const parsed = tryJson(this.parseHtml(rendered).body?.textContent ?? "");
      if (parsed !== null) return { json: parsed, reason: "" };
      reason += "; ani ve WKWebView adresa nevrátila data";
    } catch (err) {
      if (isAbort(err)) throw err;
      reason += `; WKWebView: ${(err as Error)?.message ?? "není k dispozici"}`;
    }
    return { json: null, reason };
  }

  /**
   * Úplný seznam kapitol z rozhraní webu /api/chapters/{id}?start=&end=
   * (po dávkách). Formát odpovědi se přísně kontroluje; cokoli jiného než
   * pole objektů s číslem kapitoly se zahodí.
   */
  private async fetchChapterIndex(
    t: WtrUrl,
    declared: number | null,
    opts?: FetchOptions,
  ): Promise<{ titles: Map<number, string>; failed: Array<[number, number]>; reason: string; batches: number }> {
    const titles = new Map<number, string>();
    const failed: Array<[number, number]> = [];
    let reason = "";
    let batches = 0;
    const BATCH = 500;
    const planned = declared ? Math.ceil(declared / BATCH) : undefined;
    for (let start = 1, guard = 0; guard < 400; start += BATCH, guard++) {
      if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
      const end = start + BATCH - 1;
      const withinDeclared = declared !== null && start <= declared;
      if (guard > 0 && this.catalogDelayMs > 0) await sleep(this.catalogDelayMs);
      const { json, reason: why } = await this.fetchJson(`${t.origin}/api/chapters/${t.id}?start=${start}&end=${end}`, t.novelUrl, opts);
      const list = json === null ? null : readChapterBatch(json);
      if (list === null) {
        reason = reason || why || "neočekávaný formát odpovědi";
        failed.push([start, declared !== null ? Math.min(end, Math.max(declared, start)) : end]);
        // První dávka selhala => rozhraní není dostupné. Jinak zkusit ještě další dávky v uváděném rozsahu.
        if (titles.size === 0 || failed.length >= 3 || !(declared !== null && end < declared)) break;
        continue;
      }
      batches++;
      let added = 0;
      for (const c of list) {
        if (c.order < 1 || titles.has(c.order)) continue;
        titles.set(c.order, c.title);
        added++;
      }
      opts?.onProgress?.({ pagesLoaded: batches, pagesTotal: planned, chaptersFound: titles.size });
      if (list.length === 0 && !withinDeclared) break; // za koncem katalogu
      if (added === 0 && list.length > 0) break; // server rozsah ignoruje a vrací stále totéž
      if (declared === null && list.length < BATCH) break;
      if (declared !== null && end >= declared && list.length < BATCH) break;
    }
    return { titles, failed, reason, batches };
  }

  async fetchCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
    const t = this.target(url);
    const chapterUrl = (n: number) => `${t.novelUrl}/chapter-${n}`;

    // 1) stránka novely: počet kapitol uváděný webem + to, co je na stránce vidět
    const readPage = (html: string) => {
      const data = extractNextData(html);
      const onPage = new Map<number, string>();
      for (const c of data ? findChapterList(data) : []) if (c.order >= 1) onPage.set(c.order, c.title);
      const doc = this.parseHtml(html);
      for (const a of Array.from(doc.querySelectorAll('a[href*="/chapter-"]'))) {
        const target = parseWtrUrl(absoluteUrl(t.novelUrl, a.getAttribute("href") ?? ""));
        if (!target || target.id !== t.id || target.chapter === null || target.chapter < 1) continue;
        const text = cleanText(a.textContent ?? "");
        if (!onPage.get(target.chapter) && text.length < 200) onPage.set(target.chapter, text);
      }
      return { onPage, count: this.readSerie(html, t)?.count ?? null };
    };
    let page = { onPage: new Map<number, string>(), count: null as number | null };
    let pageError = "";
    try {
      page = readPage(await this.load(t.novelUrl, (h) => readPage(h).count !== null, opts));
    } catch (err) {
      if (isAbort(err)) throw err;
      pageError = (err as Error)?.message ?? "";
    }
    const declared = page.count;

    // 2) úplný seznam z rozhraní webu
    const index = await this.fetchChapterIndex(t, declared, opts);
    let source = index.titles;
    let fromPageOnly = false;
    if (source.size === 0) {
      // 3) rozhraní není dostupné: seznam ze stránky se použije JEN když pokrývá celý rozsah
      const pageCov = numberCoverage([...page.onPage.keys()], declared);
      if (!pageCov.complete) {
        const seen = page.onPage.size > 0 ? ` Na stránce novely ${page.onPage.size === 1 ? "je vidět jen 1 kapitola" : `je vidět jen ${page.onPage.size} kapitol`} (${formatRanges(rangesOf([...page.onPage.keys()]))}) – to není katalog.` : "";
        throw new ContentError(
          `Katalog kapitol nebyl spolehlivě rozpoznán. ${declared !== null ? `WTR-LAB uvádí ${declared} kapitol, ale ` : ""}úplný seznam se nepodařilo načíst (${index.reason || pageError || "rozhraní webu neodpovědělo"}).${seen} Projekt nebyl vytvořen; adresy kapitol se neodhadují.`,
          false,
        );
      }
      source = page.onPage;
      fromPageOnly = true;
    }

    // 4) kontrola pokrytí: počet unikátních kapitol, rozsah, skutečné mezery
    const orders = [...source.keys()].sort((a, b) => a - b);
    const cov = numberCoverage(orders, declared);
    const warnings: string[] = [];
    if (!cov.complete) {
      warnings.push(
        `Katalog NENÍ kompletní: ověřeno ${cov.unique} kapitol${cov.expectedLast ? ` z ${cov.expectedLast}` : ""}, chybí ${cov.missingCount} (${formatRanges(cov.missing)}). Chybějící kapitoly se nestáhnou.`,
      );
      if (index.failed.length > 0) warnings.push(`Část seznamu se nepodařilo načíst (${index.reason || "chyba webu"}): rozsahy ${formatRanges(index.failed)}. Zkuste detekci později znovu.`);
    }
    if (declared !== null && cov.max !== null && cov.max > declared) {
      warnings.push(`Seznam obsahuje kapitoly až do čísla ${cov.max}; stránka novely uvádí ${declared}.`);
    }
    if (declared === null) warnings.push("Stránka novely neuvádí počet kapitol; úplnost se ověřila jen podle souvislosti číslování.");
    if (fromPageOnly) warnings.push("Seznam kapitol pochází přímo ze stránky novely (datové rozhraní webu nebylo dostupné).");

    const chapters: ParserChapter[] = orders.map((n, i) => ({
      title: resolveTokens(source.get(n) ?? "") || `Chapter ${n}`,
      url: chapterUrl(n),
      orderIndex: i,
      label: String(n),
    }));
    opts?.onProgress?.({ pagesLoaded: Math.max(1, index.batches), pagesTotal: Math.max(1, index.batches), chaptersFound: chapters.length });
    return { chapters, pagesLoaded: Math.max(1, index.batches), declaredTotal: declared ?? undefined, complete: cov.complete, aborted: false, warnings };
  }

  /**
   * Text kapitoly z rozhraní čtečky webu (/api/reader/get) – stejný požadavek,
   * jaký posílá stránka kapitoly. Vrací null + důvod, když rozhraní text
   * nevydá v čitelné podobě (ověření, šifrovaný obsah); pak se použije
   * vykreslení stránky. Nic se nedešifruje a žádné ověření se neobchází.
   */
  private async readerApi(t: WtrUrl, pageUrl: string, opts?: FetchOptions): Promise<{ chapter: { title: string; html: string } | null; reason: string }> {
    const modes = this.preferredMode ? [this.preferredMode, ...READER_MODES.filter((m) => m !== this.preferredMode)] : READER_MODES;
    const reasons: string[] = [];
    for (const mode of modes) {
      let res;
      try {
        res = await http.postJson(
          `${t.origin}/api/reader/get`,
          { translate: mode, language: t.lang, raw_id: Number(t.id), chapter_no: t.chapter, retry: false, force_retry: false },
          { signal: opts?.signal, timeoutMs: 30000, headers: { Referer: pageUrl } },
        );
      } catch (err) {
        if (isAbort(err)) throw err;
        reasons.push(`${mode}: ${(err as Error)?.message ?? "chyba sítě"}`);
        continue;
      }
      const json = tryJson(res.data);
      if (!isObj(json)) {
        reasons.push(`${mode}: HTTP ${res.status}, odpověď není JSON${/just a moment|challenge-platform/i.test(res.data ?? "") ? " (ověření prohlížeče)" : ""}`);
        continue;
      }
      if (json.code === "CHAPTER_LOCKED" || (isObj(json.chapter) && json.chapter.locked === true)) {
        reasons.push(`${mode}: kapitola je v tomto překladu zamčená`);
        continue;
      }
      if (json.requireTurnstile || json.code === 1401) {
        reasons.push(`${mode}: web vyžaduje ověření (Turnstile)`);
        break; // ověření se týká celé čtečky, další režim nemá smysl zkoušet
      }
      if (!res.ok || json.success === false || json.error) {
        reasons.push(`${mode}: HTTP ${res.status}${typeof json.error === "string" ? ` – ${json.error}` : ""}${typeof json.message === "string" ? ` – ${json.message}` : ""}`);
        continue;
      }
      let content: unknown = isObj(json.data) ? json.data.data : undefined;
      if (!(isObj(content) && content.body !== undefined) && typeof json.content_url === "string" && json.content_url) {
        const target = absoluteUrl(t.origin, json.content_url);
        let host = "";
        try {
          host = new URL(target).hostname;
        } catch {
          /* neplatná adresa */
        }
        if (!/(^|\.)wtr-lab\.com$/i.test(host)) {
          reasons.push(`${mode}: obsah odkazuje mimo web`);
          continue;
        }
        const { json: payload, reason } = await this.fetchJson(target, pageUrl, opts);
        content = isObj(payload) && isObj(payload.data) ? payload.data.data : undefined;
        if (!isObj(content)) {
          reasons.push(`${mode}: obsah kapitoly se nepodařilo načíst (${reason || "neočekávaný formát"})`);
          continue;
        }
      }
      if (!isObj(content) || content.body === undefined) {
        reasons.push(`${mode}: odpověď neobsahuje text`);
        continue;
      }
      // Nikdy neuložit kapitolu jiné knihy: odpověď musí odpovídat tomu, co bylo vyžádáno.
      const mismatch = identityMismatch(json.chapter, t) ?? identityMismatch(json.data, t) ?? identityMismatch(content, t);
      if (mismatch) throw wrongContent(mismatch);
      if (!Array.isArray(content.body) || !content.body.every((x) => typeof x === "string")) {
        reasons.push(`${mode}: text je v podobě, kterou aplikace nečte (chráněný obsah)`);
        continue;
      }
      const terms = isObj(content.glossary_data) && Array.isArray(content.glossary_data.terms) ? (content.glossary_data.terms as unknown[]) : [];
      const patch = Array.isArray(content.patch) ? (content.patch as unknown[]) : [];
      const fix = (text: string) => {
        let out = text.replace(/※(\d+)[⛬〓]/g, (m, i) => {
          const term = terms[Number(i)];
          const value = Array.isArray(term) ? term[0] : undefined;
          return typeof value === "string" && value ? value : m;
        });
        for (const p of patch) if (isObj(p) && typeof p.zh === "string" && p.zh && typeof p.en === "string") out = out.split(p.zh).join(` ${p.en}`);
        return resolveTokens(out);
      };
      const paragraphs = (content.body as string[]).filter((x) => x.trim() && x.trim() !== "[image]").map(fix);
      if (paragraphs.some((p) => /※\d+[⛬〓]/.test(p))) {
        reasons.push(`${mode}: v textu zůstaly nevyplněné zástupné značky`);
        continue;
      }
      const xhtml = paragraphs.flatMap((p) => p.split(/\n+/)).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeXml(p)}</p>`).join("\n");
      const cleaned = stripBoilerplateXhtml(xhtml, { siteNames: SITE_NAMES }).html;
      if (htmlToText(cleaned).length < 120) {
        reasons.push(`${mode}: text je příliš krátký`);
        continue;
      }
      this.preferredMode = mode;
      const rawTitle = (isObj(json.chapter) && typeof json.chapter.title === "string" && json.chapter.title) || (typeof content.title === "string" ? content.title : "");
      return { chapter: { title: fix(rawTitle), html: cleaned }, reason: "" };
    }
    return { chapter: null, reason: reasons.join("; ") };
  }

  /** Text kapitoly z HTML (data stránky, nebo vykreslený DOM). Vrací null, když v něm není. */
  private readChapter(html: string, t?: WtrUrl): { title: string; html: string } | null {
    const data = extractNextData(html);
    const body = data ? findChapterBody(data) : null;
    if (body && t) {
      const mismatch = identityMismatch(body.node, t) ?? identityMismatch(body.parent, t);
      if (mismatch) throw wrongContent(mismatch);
    }
    const doc = this.parseHtml(html);
    const heading = cleanText(doc.querySelector(".chapter-title, h1, h2")?.textContent ?? "");
    if (body) {
      const xhtml = body.paragraphs.length === 1 && /<\w+[^>]*>/.test(body.paragraphs[0])
        ? sanitizeToXhtml(body.paragraphs[0])
        : body.paragraphs.flatMap((p) => p.split(/\n+/)).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeXml(p)}</p>`).join("\n");
      const cleaned = stripBoilerplateXhtml(xhtml, { siteNames: SITE_NAMES }).html;
      if (htmlToText(cleaned).length >= 120) return { title: body.title || heading, html: cleaned };
    }
    for (const sel of [".chapter-body", "[class*='chapter-body']", ".chapter-content", "[data-chapter-body]", "article", "main"]) {
      let best: Element | null = null;
      let bestLen = 0;
      for (const el of Array.from(doc.querySelectorAll(sel))) {
        const paragraphs = Array.from(el.querySelectorAll("p")).reduce((s, p) => s + cleanText(p.textContent ?? "").length, 0);
        if (paragraphs > bestLen) {
          best = el;
          bestLen = paragraphs;
        }
      }
      if (!best || bestLen < 120) continue;
      const clone = best.cloneNode(true) as Element;
      for (const el of Array.from(clone.querySelectorAll("h1, .chapter-title"))) el.remove();
      cleanChapterElement(clone, { siteNames: SITE_NAMES });
      const cleaned = stripBoilerplateXhtml(sanitizeToXhtml(clone.innerHTML), { siteNames: SITE_NAMES }).html;
      if (htmlToText(cleaned).length >= 120) return { title: heading, html: cleaned };
    }
    return null;
  }

  async fetchChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }> {
    const t = this.target(url);
    if (t.chapter === null) throw new ContentError("Adresa neodkazuje na kapitolu.", false);

    // odstup mezi kapitolami – web omezuje rychlost požadavků
    const now = Date.now();
    const slot = Math.max(now, this.lastChapterAt + this.chapterIntervalMs); // i souběžná stahování jdou za sebou
    this.lastChapterAt = slot;
    if (slot > now) await sleep(slot - now);
    if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");

    // 1) rozhraní čtečky, 2) stránka kapitoly (statická data, pak vykreslení ve WKWebView)
    const api = await this.readerApi(t, url, opts);
    let ch = api.chapter;
    if (!ch) {
      const html = await this.load(url, (h) => !!this.readChapter(h, t), opts, this.renderDelayMs);
      ch = this.readChapter(html, t);
    }
    if (!ch) {
      throw new ContentError(
        `Text kapitoly ${t.chapter} se na WTR-LAB nepodařilo načíst – stránka ho nevrátila ani po vykreslení.${api.reason ? ` Rozhraní čtečky: ${api.reason}.` : ""} Web možná vyžaduje přihlášení nebo ověření; to aplikace neobchází.`,
      );
    }
    assertChapterContent(ch.html);
    const title = stripSiteSuffix(ch.title);
    return { title: title && !SITE_TITLE_RE.test(title) ? title : `Chapter ${t.chapter}`, html: ch.html };
  }
}
