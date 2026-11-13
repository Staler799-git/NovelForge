import { NovelParser, ContentError, cleanText, extractTitle, findCoverUrl, detectLanguage } from "./base";
import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { cleanChapterElement, stripBoilerplateXhtml } from "@/services/clean";
import { sanitizeToXhtml, assertChapterContent } from "@/services/content";

const CHAPTER_KEYWORDS = [
  "kapitola", "chapter", "díl", "dil", "díly", "dily", "část", "cast",
  "part", "ep", "č.", "c.", "книга", "часть", "책", "화", "prolog", "epilog", "epilóg",
];
const EXCLUDE_HREF = [
  "login", "register", "search", "tag", "tags", "category", "categories",
  "author", "authors", "contact", "about", "privacy", "policy", "download",
  "epub", "pdf", "mobi", "ajax", "wp-admin", "feed", "rss",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".css", ".js", ".ico", ".svg", ".woff",
];

const EXCLUDE_TEXT_RE = /^(domů|home|hlavní|vyhledávání|search|menu|navigace|log ?in|sign ?(in|up)|register|přihlásit|registrace|terms|privacy|dmca|contact|about|discord|changelog|updates?|news|ranking|genres?|next|prev(ious)?|more|read more)$/i;
/** Verze aplikace/webu ("v1.13.17", "2.4.0"), datum, čas – nikdy název kapitoly. */
const TECHNICAL_TEXT_RE = /^(v(er(sion)?)?\.?\s*)?\d+(\.\d+){1,3}([-+][\w.]+)?$|^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d{1,2}:\d{2}$/i;
const NAV_ANCESTORS = "nav, header, footer, aside, form, [role=navigation], [role=contentinfo], [role=banner]";
const NAV_TOKENS = new Set(["menu", "nav", "navbar", "navigation", "footer", "header", "breadcrumb", "breadcrumbs", "pagination", "pager", "social", "login", "sidebar", "widget", "recommend", "recommended", "related", "ranking", "popular", "ads", "ad", "banner", "version"]);

function inNavigation(a: Element): boolean {
  if (a.closest(NAV_ANCESTORS)) return true;
  let el: Element | null = a;
  for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
    const raw = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`.toLowerCase();
    if (raw.trim() && raw.split(/[^a-z0-9]+/).some((t) => NAV_TOKENS.has(t))) return true;
  }
  return false;
}

interface Candidate {
  title: string;
  url: string;
  /** Odkaz výslovně jmenuje kapitolu ("Chapter 12", "Kapitola 3"). */
  keyword: boolean;
  /** Tvar adresy s čísly nahrazenými znakem #. */
  shape: string;
}

function chapterCandidate(text: string, href: string): Candidate | null {
  const t = cleanText(text);
  const low = t.toLowerCase();
  const h = href.toLowerCase();
  if (t.length < 1 || t.length > 200) return null;
  if (EXCLUDE_TEXT_RE.test(t) || TECHNICAL_TEXT_RE.test(t)) return null;
  if (EXCLUDE_HREF.some((k) => h.includes(k))) return null;
  let path = h;
  try {
    path = new URL(href).pathname.toLowerCase();
  } catch {
    /* ponechat */
  }
  const kwText = CHAPTER_KEYWORDS.some((k) => k.length >= 3 && low.includes(k.toLowerCase())) && /\d/.test(low) || /^(prolog|epilog|epilóg|prologue|epilogue)\b/i.test(low);
  const kwPath = /(chapter|chap|kapitola|episode|dil|cast|part)[-_/]?\d+/.test(path);
  const numeric = /^\d{1,5}$/.test(t) || /\d/.test(path.split("/").pop() ?? "");
  if (!kwText && !kwPath && !numeric) return null;
  return { title: t, url: href, keyword: kwText || kwPath, shape: path.replace(/\d+/g, "#") };
}

export const UNRELIABLE_CATALOG = "Katalog kapitol nebyl spolehlivě rozpoznán.";

/**
 * Vybere ze stránky odkazy na kapitoly a ohodnotí důvěryhodnost detekce.
 *
 * Kapitoly tvoří SKUPINU odkazů se stejným tvarem adresy. Jediný odkaz
 * obsahující číslo (verze webu v patičce, datum aktualizace…) katalogem není –
 * v takovém případě se vyhodí chyba, místo aby vznikl falešný projekt.
 */
export function detectChapterLinks(doc: Document, baseUrl: string): ParserChapter[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  let baseHost = "";
  try {
    baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    /* neplatná adresa */
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs: string;
    try {
      const u = new URL(href, baseUrl);
      u.hash = "";
      abs = u.href;
      if (u.hostname.replace(/^www\./, "") !== baseHost) continue;
    } catch {
      continue;
    }
    if (abs === baseUrl || seen.has(abs)) continue;
    if (inNavigation(a)) continue;
    const c = chapterCandidate(a.textContent ?? "", abs);
    if (!c) continue;
    seen.add(abs);
    candidates.push(c);
  }

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) groups.set(c.shape, [...(groups.get(c.shape) ?? []), c]);
  let best: Candidate[] = [];
  let bestScore = 0;
  for (const g of groups.values()) {
    const kw = g.filter((c) => c.keyword).length;
    const score = g.length + kw; // skupina výslovně pojmenovaných kapitol má přednost
    if (score > bestScore) {
      best = g;
      bestScore = score;
    }
  }
  const keywords = best.filter((c) => c.keyword).length;
  const confident = best.length >= 3 || (best.length === 2 && keywords === 2);
  if (!confident) throw new ContentError(UNRELIABLE_CATALOG, false);

  return best.map((c, i) => ({ title: c.title, url: c.url, orderIndex: i }));
}

export class GenericNovelParser extends NovelParser {
  canHandle(_url: string): boolean {
    return true;
  }

  async fetchMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata> {
    const html = await this.fetchHtml(url, opts);
    const doc = this.parseHtml(html);
    const title = cleanText(this.og(doc, "title") || extractTitle(doc) || "Neznámá novela");
    // Název shodný s názvem webu znamená, že stránka není stránkou novely.
    const siteName = cleanText(this.og(doc, "site_name") ?? "");
    const titleIsSite = !!siteName && title.toLowerCase() === siteName.toLowerCase();
    const author = cleanText(this.meta(doc, "author") ?? this.findAuthor(doc) ?? "");
    const description = this.og(doc, "description") || this.meta(doc, "description") || undefined;
    const coverUrl = findCoverUrl(doc, url);
    const language = detectLanguage(doc, `${title} ${description ?? ""}`);
    return {
      title: titleIsSite ? "" : title,
      author,
      description,
      language,
      coverUrl,
      sourceUrl: url,
      sourceDomain: new URL(url).hostname,
    };
  }

  private findAuthor(doc: Document): string | null {
    const candidates = doc.querySelectorAll(
      ".author, .novel-author, .writer, [itemprop=author], .book-author, .post-author"
    );
    for (const el of candidates) {
      const text = cleanText(el.textContent ?? "");
      if (text && text.length < 120) return text;
    }
    for (const el of doc.querySelectorAll("p, div, span, td, li")) {
      const t = cleanText(el.textContent ?? "");
      const m = t.match(/^(autor|author|původce|přeložil|překlad):\s*(.+)$/i);
      if (m?.[2] && m[2].length < 120) return m[2];
    }
    return null;
  }

  async fetchChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]> {
    return (await this.readList(url, opts)).chapters;
  }

  /**
   * Obecný parser čte seznam kapitol z jediné stránky. Když stránka seznam
   * stránkuje, katalog se NEOZNAČÍ jako kompletní.
   */
  async fetchCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
    const { chapters, paginated } = await this.readList(url, opts);
    opts?.onProgress?.({ pagesLoaded: 1, pagesTotal: 1, chaptersFound: chapters.length });
    const warnings = paginated
      ? ["Seznam kapitol je na webu rozdělen na více stránek. Obecný parser načetl jen první z nich – katalog není kompletní."]
      : ["Tento web nemá vlastní parser: seznam kapitol byl načten z jedné stránky a jeho úplnost nelze ověřit. Zkontrolujte počet kapitol."];
    return { chapters, pagesLoaded: 1, complete: !paginated, aborted: false, warnings };
  }

  private async readList(url: string, opts?: FetchOptions): Promise<{ chapters: ParserChapter[]; paginated: boolean }> {
    const html = await this.fetchHtml(url, opts);
    const doc = this.parseHtml(html);
    const chapters = detectChapterLinks(doc, url);
    const paginated =
      !!doc.querySelector("a[rel=next], link[rel=next], .pagination a[href], .pager a[href], .page-numbers[href]") ||
      Array.from(doc.querySelectorAll("a[href]")).some((a) => /[?&](page|p)=\d+|\/page\/\d+/i.test(a.getAttribute("href") ?? ""));

    // Řazení podle čísel jen když je mají všechny položky; jinak pořadí na stránce.
    const nums = chapters.map((c) => chapterNumber(c.title));
    if (nums.every((n) => n !== null)) {
      chapters.sort((a, b) => chapterNumber(a.title)! - chapterNumber(b.title)!);
    }
    chapters.forEach((c, i) => (c.orderIndex = i));
    return { chapters, paginated };
  }

  async fetchChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }> {
    const html = await this.fetchHtml(url, opts);
    const doc = this.parseHtml(html);
    const title = cleanText(extractTitle(doc) || "Kapitola");
    const content = this.selectContent(doc);
    if (!content) throw new ContentError("Na stránce nebyl nalezen text kapitoly");
    const cleaned = this.cleanContent(content);
    assertChapterContent(cleaned);
    return { title, html: cleaned };
  }

  private selectContent(doc: Document): Element {
    const candidates = [
      "article", "#content", ".content", ".chapter-content", ".entry-content",
      ".post-content", ".reading-content", "#chapter-content", ".chapter-text",
      ".text-content", "main",
    ];
    let best: Element | null = null;
    let bestScore = -1;
    for (const sel of candidates) {
      for (const el of doc.querySelectorAll(sel)) {
        const score = el.textContent?.length ?? 0;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    return best ?? doc.body;
  }

  private cleanContent(content: Element): string {
    const clone = content.cloneNode(true) as Element;
    for (const sel of [
      "script", "style", "noscript", "iframe", "nav", "header", "footer", "aside",
      ".ad", ".ads", ".advertisement", "[class*='ad-']", "[id*='ad-']",
      ".social-share", ".share-buttons", ".related-posts", ".comments",
      ".comment-form", "form", "button", "input", "select",
      ".chapter-nav", ".pagination", ".nav-next", ".nav-prev",
      ".next-chapter", ".prev-chapter", "[id*='comment']",
    ]) {
      for (const el of clone.querySelectorAll(sel)) el.remove();
    }
    for (const el of clone.querySelectorAll("p, div")) {
      if (!el.textContent?.trim() && !el.querySelector("img, br")) el.remove();
    }
    cleanChapterElement(clone);
    return stripBoilerplateXhtml(sanitizeToXhtml(clone.innerHTML)).html;
  }
}

function chapterNumber(title: string): number | null {
  const m = title.match(/(?:kapitola|chapter|díl|dil|část|cast|part|ep|c\.|č\.)\s*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  const m2 = title.match(/^\s*(\d{1,4})\s*$/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}
