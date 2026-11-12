import { NovelParser, cleanText, extractTitle } from "./base";
import type { NovelMetadata, ParserChapter } from "@/types";

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
const EXCLUDE_TEXT = ["domů", "home", "hlavní", "vyhledávání", "search", "menu", "navigace"];

function looksLikeChapterLink(text: string, href: string): boolean {
  const t = cleanText(text).toLowerCase();
  const h = href.toLowerCase();
  if (EXCLUDE_TEXT.includes(t) || t.length < 2) return false;
  if (EXCLUDE_HREF.some((k) => h.includes(k))) return false;
  const kw = CHAPTER_KEYWORDS.some((k) => t.includes(k.toLowerCase()) || h.includes(k.toLowerCase()));
  return kw || /\d/.test(t);
}

export class GenericNovelParser extends NovelParser {
  canHandle(_url: string): boolean {
    return true;
  }

  async fetchMetadata(url: string): Promise<NovelMetadata> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const title = cleanText(this.og(doc, "title") || extractTitle(doc) || "Neznámá novela");
    const author = cleanText(this.meta(doc, "author") ?? this.findAuthor(doc) ?? "");
    const description = this.og(doc, "description") || this.meta(doc, "description") || undefined;
    const coverUrl = this.og(doc, "image") || this.og(doc, "image:url") || undefined;
    const language = doc.documentElement.lang || "cs";
    return {
      title,
      author,
      description,
      language,
      coverUrl: coverUrl ? this.absoluteUrl(url, coverUrl) : undefined,
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

  async fetchChapterList(url: string): Promise<ParserChapter[]> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const links = Array.from(doc.querySelectorAll("a[href]"));
    const seen = new Set<string>();
    const chapters: ParserChapter[] = [];

    for (const a of links) {
      const href = a.getAttribute("href");
      if (!href) continue;
      const abs = this.absoluteUrl(url, href);
      if (!this.sameDomain(url, abs)) continue;
      if (seen.has(abs)) continue;
      if (!looksLikeChapterLink(a.textContent ?? "", abs)) continue;
      seen.add(abs);
      chapters.push({
        title: cleanText(a.textContent ?? "") || `Kapitola ${chapters.length + 1}`,
        url: abs,
        orderIndex: chapters.length,
      });
    }

    if (chapters.length === 0) {
      for (const a of links) {
        const href = a.getAttribute("href");
        if (!href) continue;
        const abs = this.absoluteUrl(url, href);
        if (!this.sameDomain(url, abs) || seen.has(abs)) continue;
        seen.add(abs);
        chapters.push({
          title: cleanText(a.textContent ?? "") || `Odkaz ${chapters.length + 1}`,
          url: abs,
          orderIndex: chapters.length,
        });
      }
    }

    chapters.sort((a, b) => {
      const na = chapterNumber(a.title);
      const nb = chapterNumber(b.title);
      if (na !== null && nb !== null) return na - nb;
      return 0;
    });
    chapters.forEach((c, i) => (c.orderIndex = i));
    return chapters;
  }

  async fetchChapter(url: string): Promise<{ title: string; html: string }> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const title = cleanText(extractTitle(doc) || "Kapitola");
    const content = this.selectContent(doc);
    return { title, html: this.cleanContent(content) };
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
    let html = clone.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
    return html.trim();
  }
}

function chapterNumber(title: string): number | null {
  const m = title.match(/(?:kapitola|chapter|díl|dil|část|cast|part|ep|c\.|č\.)\s*(\d{1,4})/i);
  if (m) return parseInt(m[1], 10);
  const m2 = title.match(/^\s*(\d{1,4})\s*$/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}
