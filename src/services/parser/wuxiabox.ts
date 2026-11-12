import { NovelParser, cleanText, extractTitle } from "./base";
import type { NovelMetadata, ParserChapter } from "@/types";

/**
 * WuxiaBox adapter (wuxiabox.com).
 *
 * POZOR: Živý web nebylo v tomto prostředí možné načíst (sandbox povoluje
 * pouze github.com a npm registry). Selektory vycházejí z běžné struktury
 * web-novelových katalogů a budou vyžadovat odladění proti skutečnému webu.
 * Pokud detekce selže, aplikace použije GenericNovelParser a nabídne ruční
 * výběr odkazů v integrovaném prohlížeči.
 */
export class WuxiaBoxParser extends NovelParser {
  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === "wuxiabox.com" || host.endsWith(".wuxiabox.com");
    } catch {
      return false;
    }
  }

  async fetchMetadata(url: string): Promise<NovelMetadata> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const title = cleanText(
      doc.querySelector(".novel-title, h1.title, .book-title, h1")?.textContent ?? ""
    ) || this.og(doc, "title") || extractTitle(doc) || "Neznámá novela";
    const author =
      cleanText(doc.querySelector(".author, .novel-author, .writer, .book-author")?.textContent ?? "") ||
      this.meta(doc, "author") ||
      "";
    const description =
      this.og(doc, "description") ||
      this.meta(doc, "description") ||
      cleanText(doc.querySelector(".description, .synopsis, .summary, .novel-desc")?.textContent ?? "") ||
      undefined;
    const coverUrl =
      this.og(doc, "image") ||
      doc.querySelector(".cover img, .novel-cover img, .book-cover img")?.getAttribute("src") ||
      undefined;
    return {
      title,
      author,
      description,
      language: doc.documentElement.lang || "cs",
      coverUrl: coverUrl ? this.absoluteUrl(url, coverUrl) : undefined,
      sourceUrl: url,
      sourceDomain: new URL(url).hostname,
    };
  }

  async fetchChapterList(url: string): Promise<ParserChapter[]> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const seen = new Set<string>();
    const chapters: ParserChapter[] = [];

    const containers = doc.querySelectorAll(
      ".chapter-list, #chapter-list, .list-chapter, .chapters, .chapter-table, table, .wp-manga-chapter-list, .chapter-item"
    );

    const addLinks = (els: NodeListOf<Element>) => {
      for (const a of els) {
        if (!(a instanceof Element)) continue;
        const href = a.getAttribute("href");
        if (!href) continue;
        const abs = this.absoluteUrl(url, href);
        if (!this.sameDomain(url, abs) || seen.has(abs)) continue;
        const t = cleanText(a.textContent ?? "");
        const looksChapter = /(kapitola|chapter|díl|dil|část|cast|part|ep|c\.|č\.)/i.test(t) || /\d{1,4}\s*[-:]/.test(t) || /(^|\s)\d{1,4}(\s|$)/.test(t);
        if (!looksChapter) continue;
        seen.add(abs);
        chapters.push({
          title: t || `Kapitola ${chapters.length + 1}`,
          url: abs,
          orderIndex: chapters.length,
        });
      }
    };

    for (const c of containers) addLinks(c.querySelectorAll("a[href]"));

    if (chapters.length === 0) {
      addLinks(doc.querySelectorAll("a[href]"));
    }

    chapters.sort((a, b) => chapterNum(a.title) - chapterNum(b.title));
    chapters.forEach((c, i) => (c.orderIndex = i));
    return chapters;
  }

  async fetchChapter(url: string): Promise<{ title: string; html: string }> {
    const html = await this.fetchHtml(url);
    const doc = this.parseHtml(html);
    const title =
      cleanText(doc.querySelector("h1, .chapter-title, .entry-title")?.textContent ?? "") ||
      extractTitle(doc);
    const contentEl =
      doc.querySelector("#chapter-content, .chapter-content, .entry-content, .reading-content, #content, article") ||
      doc.body;
    return { title: title || "Kapitola", html: this.cleanContent(contentEl) };
  }

  private cleanContent(content: Element): string {
    const clone = content.cloneNode(true) as Element;
    for (const sel of [
      "script", "style", "noscript", "iframe", "nav", "header", "footer", "aside",
      ".ad", ".ads", ".advertisement", "[class*='ad-']", "[id*='ad-']",
      ".social-share", ".share-buttons", ".related-posts", ".comments",
      ".comment-form", "form", "button", ".chapter-nav", ".pagination",
      ".next-chapter", ".prev-chapter",
    ]) {
      for (const el of clone.querySelectorAll(sel)) el.remove();
    }
    return clone.innerHTML.replace(/<!--[\s\S]*?-->/g, "").trim();
  }
}

function chapterNum(title: string): number {
  const m = title.match(/(\d{1,4})/);
  return m ? parseInt(m[1], 10) : 0;
}
