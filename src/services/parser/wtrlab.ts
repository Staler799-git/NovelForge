/**
 * WTR-LAB (wtr-lab.com).
 *
 * Web je aplikace v Next.js: stránka nese data v <script id="__NEXT_DATA__">
 * a část obsahu vykresluje až JavaScript. Parser proto:
 *   1) čte data ze stránky (__NEXT_DATA__, JSON-LD, Open Graph),
 *   2) když ve statickém HTML nejsou, nechá stránku vykreslit nativním
 *      WKWebView a čte výsledný DOM,
 *   3) nikdy nevolá žádné interní API webu – jeho adresy ani formát nejsou
 *      ověřené a mohou být chráněné.
 *
 * DŮLEŽITÉ: struktura dat byla navržena bez přístupu k živému webu. Klíče se
 * proto nehledají na pevných cestách, ale podle tvaru dat, a každý krok má
 * kontrolu: když se novela nebo katalog nedají spolehlivě rozpoznat, parser
 * vyhodí chybu, místo aby vrátil název webu nebo jednu falešnou kapitolu.
 *
 * Přihlášení, CAPTCHA ani placený obsah se neobcházejí.
 */
import { NovelParser, ContentError, cleanText, findCoverUrl, normalizeLanguage, absoluteUrl } from "./base";
import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { cleanChapterElement, stripBoilerplateXhtml } from "@/services/clean";
import { sanitizeToXhtml, assertChapterContent, escapeXml, htmlToText } from "@/services/content";
import { isAbort } from "@/services/http";

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
export function findChapterBody(data: unknown): { title: string; paragraphs: string[] } | null {
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
  if (best && !best.title) {
    for (const node of walk(data)) {
      if (!isObj(node) || !Object.values(node).includes(best.node)) continue;
      best.title = str(node.title) || str(node.name);
      break;
    }
  }
  return best ? { title: best.title, paragraphs: best.paragraphs } : null;
}

function stripSiteSuffix(title: string): string {
  return cleanText(title.replace(/\s*[-|–—·:]\s*wtr[-\s]?lab.*$/i, "").replace(/^wtr[-\s]?lab\s*[-|–—·:]\s*/i, ""));
}

export class WtrLabParser extends NovelParser {
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
  private async load(url: string, usable: (html: string) => boolean, opts?: FetchOptions): Promise<string> {
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
      const { renderHtml } = await import("@/services/render");
      const rendered = await renderHtml(url);
      if (opts?.signal?.aborted) throw new DOMException("Přerušeno", "AbortError");
      if (rendered && usable(rendered)) return rendered;
      if (rendered && !html) html = rendered;
    } catch (err) {
      if (isAbort(err)) throw err;
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
      title: serie.title,
      author: serie.author,
      description: serie.description ? htmlToText(serie.description) : undefined,
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

  async fetchCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
    const t = this.target(url);
    const chapterUrl = (n: number) => `${t.novelUrl}/chapter-${n}`;
    const read = (html: string) => {
      const data = extractNextData(html);
      const listed = data ? findChapterList(data) : [];
      const doc = this.parseHtml(html);
      const linked = new Map<number, string>();
      for (const a of Array.from(doc.querySelectorAll('a[href*="/chapter-"]'))) {
        const target = parseWtrUrl(absoluteUrl(t.novelUrl, a.getAttribute("href") ?? ""));
        if (!target || target.id !== t.id || target.chapter === null) continue;
        const text = cleanText(a.textContent ?? "");
        if (!linked.has(target.chapter) || (text.length > (linked.get(target.chapter) ?? "").length && text.length < 200)) linked.set(target.chapter, text);
      }
      return { listed, linked, count: this.readSerie(html, t)?.count ?? null };
    };

    const html = await this.load(
      t.novelUrl,
      (h) => {
        const r = read(h);
        return r.listed.length > 0 || r.count !== null || r.linked.size >= 2;
      },
      opts,
    );
    const { listed, linked, count } = read(html);
    const warnings: string[] = [];
    let chapters: ParserChapter[] = [];
    let complete = false;

    if (listed.length > 0) {
      chapters = listed.map((c, i) => ({ title: c.title || `Chapter ${c.order}`, url: chapterUrl(c.order), orderIndex: i, label: String(c.order) }));
      complete = count === null || listed.length >= count;
      if (!complete) warnings.push(`Web uvádí ${count} kapitol, seznam na stránce jich obsahuje ${listed.length}. Katalog není kompletní.`);
    } else if (count !== null && count > 0) {
      // Adresy kapitol jsou na WTR-LAB číslované souvisle (…/chapter-1 až …/chapter-N).
      chapters = Array.from({ length: count }, (_, i) => ({
        title: linked.get(i + 1) || `Chapter ${i + 1}`,
        url: chapterUrl(i + 1),
        orderIndex: i,
        label: String(i + 1),
      }));
      complete = false;
      warnings.push(
        `Stránka neobsahuje seznam kapitol, jen jejich počet (${count}). Adresy kapitol 1–${count} byly odvozeny z číslování webu a nejsou jednotlivě ověřené; názvy se doplní při stahování.`,
      );
    } else if (linked.size >= 2) {
      const nums = [...linked.keys()].sort((a, b) => a - b);
      chapters = nums.map((n, i) => ({ title: linked.get(n) || `Chapter ${n}`, url: chapterUrl(n), orderIndex: i, label: String(n) }));
      complete = false;
      warnings.push(`Na stránce bylo nalezeno jen ${nums.length} odkazů na kapitoly a web neuvádí jejich celkový počet. Katalog je pravděpodobně neúplný.`);
    } else {
      throw new ContentError("Katalog kapitol nebyl spolehlivě rozpoznán. WTR-LAB nevrátil seznam ani počet kapitol (web možná vyžaduje přihlášení nebo změnil strukturu).", false);
    }
    opts?.onProgress?.({ pagesLoaded: 1, pagesTotal: 1, chaptersFound: chapters.length });
    return { chapters, pagesLoaded: 1, declaredTotal: count ?? undefined, complete, aborted: false, warnings };
  }

  /** Text kapitoly z HTML (data stránky, nebo vykreslený DOM). Vrací null, když v něm není. */
  private readChapter(html: string): { title: string; html: string } | null {
    const data = extractNextData(html);
    const body = data ? findChapterBody(data) : null;
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
    const html = await this.load(url, (h) => !!this.readChapter(h), opts);
    const ch = this.readChapter(html);
    if (!ch) {
      throw new ContentError(
        "Text kapitoly se na WTR-LAB nepodařilo načíst – stránka ho nevrátila ani po vykreslení. Web možná vyžaduje přihlášení nebo ověření; to aplikace neobchází.",
      );
    }
    assertChapterContent(ch.html);
    const title = stripSiteSuffix(ch.title);
    return { title: title && !SITE_TITLE_RE.test(title) ? title : `Chapter ${t.chapter}`, html: ch.html };
  }
}
