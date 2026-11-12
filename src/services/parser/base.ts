import type { NovelMetadata, ParserChapter, FetchOptions } from "@/types";

export interface ParsedNovel {
  metadata: NovelMetadata;
  chapters: ParserChapter;
}

export abstract class NovelParser {
  abstract canHandle(url: string): boolean;
  abstract fetchMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata>;
  abstract fetchChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]>;
  abstract fetchChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }>;

  /**
   * Načte HTML. Pro stránky vykreslované JavaScriptem (prázdné tělo) zkusí nativní WKWebView.
   */
  protected async fetchHtml(url: string, opts?: FetchOptions): Promise<string> {
    const { http } = await import("@/services/http");
    let html = (await http.get(url, { timeoutMs: 30000, ...(opts as any) })).data;

    const doc = this.parseHtml(html);
    const bodyText = doc.body.innerText?.trim().length ?? 0;
    const hasScripts = doc.querySelectorAll("script").length > 0;

    // Stránka vypadá prázdně a má skripty → pravděpodobně rendering až po JS.
    // Nativní WKWebView je k dispozici jen v iOS aplikaci.
    if (bodyText < 50 && hasScripts) {
      try {
        const { renderHtml } = await import("@/services/render");
        const rendered = await renderHtml(url);
        if (rendered.length > html.length) {
          html = rendered;
        }
      } catch {
        // Nativní modul není k dispozici (preview/prohlížeč) — ponecháme surové HTML.
      }
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
    try {
      return new URL(href, base).href;
    } catch {
      return href;
    }
  }

  protected sameDomain(a: string, b: string): boolean {
    try {
      return new URL(a).hostname === new URL(b).hostname;
    } catch {
      return false;
    }
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
