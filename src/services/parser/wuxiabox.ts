import { NovelParser, ContentError, cleanText, extractTitle, findCoverUrl, normalizeLanguage } from "./base";
import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { isAbort } from "@/services/http";
import { sanitizeToXhtml, assertChapterContent } from "@/services/content";

/**
 * WuxiaBox adapter (wuxiabox.com).
 *
 * Struktura webu:
 *   novela    /novel/<slug>.html           (obsahuje jen PRVNÍ stránku katalogu)
 *   katalog   /e/extend/fy.php?page=<n>&wjm=<slug>   (stránkovaný seznam kapitol)
 *   kapitola  /novel/<slug>_<pořadí>.html
 *
 * Dřívější verze četla pouze stránku novely, a proto našla jen prvních ~100
 * kapitol. Nyní se projdou všechny stránky katalogu.
 *
 * POZOR: adaptér nebylo možné ověřit proti živému webu (vývojové prostředí
 * nemá k wuxiabox.com přístup). Je proto psán defenzivně – nespoléhá na
 * jediný selektor ani na to, zda stránkování začíná od 0 nebo od 1, a všechny
 * nejistoty hlásí jako varování místo tichého selhání.
 */

const MAX_PAGES = 400;
const PAGE_RETRIES = 3;
const PAGE_DELAY_MS = 150;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

interface Entry extends ParserChapter {
  page: number;
  pos: number;
  /** Pořadové číslo z URL (_<n>.html), pokud ho URL obsahuje. */
  seq: number | null;
}

export class WuxiaBoxParser extends NovelParser {
  /** Prodleva mezi stránkami katalogu (testy ji nastavují na 0). */
  pageDelayMs = PAGE_DELAY_MS;

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === "wuxiabox.com" || host.endsWith(".wuxiabox.com");
    } catch {
      return false;
    }
  }

  /** "/novel/<slug>.html" i "/novel/<slug>_12.html" -> "<slug>" */
  slugOf(url: string): string | null {
    try {
      const u = new URL(url);
      const wjm = u.searchParams.get("wjm");
      if (wjm) return wjm;
      const m = u.pathname.match(/\/novel\/([^/]+?)(?:_\d+)?(?:\.html?)?\/?$/i);
      return m ? decodeURIComponent(m[1]) : null;
    } catch {
      return null;
    }
  }

  catalogPageUrl(novelUrl: string, slug: string, page: number): string {
    return new URL(`/e/extend/fy.php?page=${page}&wjm=${encodeURIComponent(slug)}`, novelUrl).href;
  }

  async fetchMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata> {
    const html = await this.fetchHtml(url, opts);
    const doc = this.parseHtml(html);
    return this.metadataFromDoc(doc, url);
  }

  private metadataFromDoc(doc: Document, url: string): NovelMetadata {
    const title =
      cleanText(doc.querySelector("h1.novel-title, .novel-title, h1.title, .book-title, h1")?.textContent ?? "") ||
      cleanText(this.og(doc, "title") ?? "") ||
      extractTitle(doc) ||
      "Neznámá novela";
    const author =
      cleanText(
        doc.querySelector('.author [itemprop="author"], [itemprop="author"], .author a, .novel-author, .writer, .book-author')
          ?.textContent ?? "",
      ) ||
      cleanText((doc.querySelector(".author")?.textContent ?? "").replace(/^\s*author\s*:?\s*/i, "")) ||
      cleanText(this.meta(doc, "author") ?? "") ||
      cleanText(this.og(doc, "novel:author") ?? "") ||
      "";
    const description =
      cleanText(doc.querySelector(".summary .content, .summary, .description, .synopsis, .novel-desc")?.textContent ?? "") ||
      this.og(doc, "description") ||
      this.meta(doc, "description") ||
      undefined;
    return {
      title,
      author,
      description,
      // WuxiaBox je anglický web; <html lang> má přednost, pokud je vyplněn.
      language: normalizeLanguage(doc.documentElement.getAttribute("lang"), "en"),
      coverUrl: findCoverUrl(doc, url, [".fixed-img img", "figure.cover img", ".cover img"]),
      sourceUrl: url,
      sourceDomain: new URL(url).hostname,
      declaredChapters: this.declaredTotal(doc),
    };
  }

  /** Počet kapitol, který web sám uvádí (např. "3138 Chapters"). */
  private declaredTotal(doc: Document): number | undefined {
    const scopes = doc.querySelectorAll(".header-stats, .novel-info, .novel-stats, .info, .book-info, header");
    const texts = Array.from(scopes).map((el) => cleanText(el.textContent ?? ""));
    texts.push(cleanText(this.meta(doc, "description") ?? ""));
    for (const t of texts) {
      const m = t.match(/(\d[\d,.\s]{0,8}\d|\d)\s*Chapters?\b/i) ?? t.match(/Chapters?\s*:?\s*(\d[\d,.\s]{0,8}\d|\d)/i);
      if (m) {
        const n = parseInt(m[1].replace(/[^\d]/g, ""), 10);
        if (n > 0 && n < 100000) return n;
      }
    }
    return undefined;
  }

  /** Vytáhne položky katalogu z jedné stránky (v pořadí, v jakém je web uvádí). */
  private extractEntries(doc: Document, baseUrl: string, slug: string | null, page: number): Entry[] {
    const containers = Array.from(
      doc.querySelectorAll("ul.chapter-list, .chapter-list, #chapter-list, .list-chapter, #chapters, .chapters"),
    );
    const scope: ParentNode[] = containers.length ? containers : [doc];
    const out: Entry[] = [];
    const seen = new Set<string>();
    const chapterPath = slug
      ? new RegExp(`/novel/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)\\.html?$`, "i")
      : /\/novel\/[^/]+_(\d+)\.html?$/i;

    for (const root of scope) {
      for (const a of Array.from(root.querySelectorAll("a[href]"))) {
        const href = a.getAttribute("href") ?? "";
        if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
        let abs: string;
        try {
          const u = new URL(href, baseUrl);
          u.hash = "";
          abs = u.href;
        } catch {
          continue;
        }
        if (!this.sameDomain(baseUrl, abs)) continue;
        const m = new URL(abs).pathname.match(chapterPath);
        // Mimo kontejner katalogu bereme jen odkazy, které jsou prokazatelně kapitolou této novely.
        if (!m && !containers.length) continue;
        if (!m && /fy\.php|\/novel\/[^/_]+\.html?$/i.test(abs)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);

        const label = cleanText(a.querySelector(".chapter-no, .chapter-num, .num")?.textContent ?? "");
        let title = cleanText(a.querySelector(".chapter-title, strong, .title")?.textContent ?? "");
        if (!title) title = cleanText(a.getAttribute("title") ?? "");
        if (!title) {
          // Text odkazu bez čísla pořadí a bez data aktualizace
          const clone = a.cloneNode(true) as Element;
          for (const el of Array.from(clone.querySelectorAll(".chapter-no, .chapter-num, .num, time, .chapter-update"))) el.remove();
          title = cleanText(clone.textContent ?? "");
        }
        out.push({
          title: title || (label ? `Chapter ${label}` : `Chapter ${out.length + 1}`),
          url: abs,
          orderIndex: 0,
          label: label || undefined,
          page,
          pos: out.length,
          seq: m ? parseInt(m[1], 10) : null,
        });
      }
    }
    return out;
  }

  /** Nejvyšší číslo stránky, na které vede stránkování. */
  private maxPageLink(doc: Document): number {
    let max = -1;
    for (const a of Array.from(doc.querySelectorAll('a[href*="fy.php"]'))) {
      const m = (a.getAttribute("href") ?? "").match(/[?&]page=(\d+)/i);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  }

  async fetchChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]> {
    return (await this.fetchCatalog(url, opts)).chapters;
  }

  /**
   * Načte CELÝ katalog: stránku novely + všechny stránky fy.php.
   *
   * - Identita kapitoly je její URL; duplicitní je jen položka se stejnou URL.
   * - Pořadí = pořadí v katalogu (stránka, pozice). Čísla v názvech se k řazení
   *   nepoužívají; pořadové číslo z URL slouží jen k rozpoznání sestupného výpisu.
   * - Detekci lze kdykoli zastavit přes opts.signal – vrátí se dosud nalezené
   *   kapitoly s příznakem aborted/complete=false.
   */
  async fetchCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
    const signal = opts?.signal;
    const slug = this.slugOf(url);
    const warnings: string[] = [];
    const byUrl = new Map<string, Entry>();
    let duplicates = 0;

    const add = (entries: Entry[]): number => {
      let added = 0;
      for (const e of entries) {
        if (byUrl.has(e.url)) {
          duplicates++;
          continue;
        }
        byUrl.set(e.url, e);
        added++;
      }
      return added;
    };

    // 1) Stránka novely: metadata o počtu, odkazy stránkování, první část katalogu.
    const novelDoc = this.parseHtml(await this.fetchHtml(url, opts));
    const declaredTotal = this.declaredTotal(novelDoc);
    let maxPage = this.maxPageLink(novelDoc);
    const novelEntries = this.extractEntries(novelDoc, url, slug, -1);
    const perPageHint = novelEntries.length;

    if (!slug) {
      add(novelEntries);
      warnings.push("Z adresy se nepodařilo určit identifikátor novely – načtena jen stránka novely.");
      return this.finish(byUrl, 1, declaredTotal, false, warnings, true);
    }

    // 2) Stránky katalogu. Začíná se od 0; pokud web čísluje od 1, stránka 0
    //    buď nic nepřidá, nebo zopakuje stránku 1 – obojí je ošetřeno (duplicity
    //    se podle URL zahodí a prázdná stránka cyklus hned neukončí).
    let pagesLoaded = 0;
    let emptyStreak = 0;
    let failStreak = 0;
    let aborted = false;
    const failedPages: number[] = [];
    let perPage = 0;

    const report = () => {
      const fromLinks = maxPage >= 0 ? maxPage + 1 : undefined;
      const fromTotal = declaredTotal && (perPage || perPageHint) ? Math.ceil(declaredTotal / (perPage || perPageHint)) : undefined;
      const pagesTotal = Math.max(fromLinks ?? 0, fromTotal ?? 0) || undefined;
      opts?.onProgress?.({ pagesLoaded, pagesTotal, chaptersFound: byUrl.size });
    };

    for (let page = 0; page < MAX_PAGES; page++) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      let doc: Document | null = null;
      let lastError = "";
      for (let attempt = 1; attempt <= PAGE_RETRIES && !doc; attempt++) {
        try {
          doc = this.parseHtml(await this.fetchHtml(this.catalogPageUrl(url, slug, page), { signal }));
        } catch (err: any) {
          if (isAbort(err) || signal?.aborted) {
            aborted = true;
            break;
          }
          lastError = err?.message ?? String(err);
          if (err?.retryable === false) break;
          if (attempt < PAGE_RETRIES) await sleep(600 * attempt, signal);
        }
      }
      if (aborted) break;

      if (!doc) {
        // Stránka 0 smí chybět (weby číslované od 1). Ostatní selhání jsou díra v katalogu.
        if (page > 0 || maxPage < 0) {
          failedPages.push(page);
          failStreak++;
          if (page > 0) warnings.push(`Stránku katalogu ${page} se nepodařilo načíst: ${lastError}`);
        }
        const beyondEnd = maxPage >= 0 ? page > maxPage : page >= 1;
        if (failStreak >= 3 || (beyondEnd && byUrl.size > 0) || (page >= 1 && byUrl.size === 0)) break;
        continue;
      }
      failStreak = 0;
      pagesLoaded++;
      maxPage = Math.max(maxPage, this.maxPageLink(doc));
      const entries = this.extractEntries(doc, url, slug, page);
      perPage = Math.max(perPage, entries.length);
      const added = add(entries);
      report();

      if (added === 0) {
        emptyStreak++;
        if (emptyStreak >= 2 || (page >= 2 && page > maxPage)) break;
      } else {
        emptyStreak = 0;
        if (declaredTotal && byUrl.size >= declaredTotal && page >= maxPage) break;
      }
      if (this.pageDelayMs > 0) await sleep(this.pageDelayMs, signal);
    }

    // Stránka 0 selhala a nic se nenašlo jinde => to není "díra", jen číslování od 1.
    const realFailures = failedPages.filter((p) => !(p === 0 && byUrl.size > 0 && pagesLoaded > 0));

    // 3) Záloha: katalog se nepodařilo načíst vůbec -> aspoň to, co je na stránce novely.
    if (byUrl.size === 0) {
      add(novelEntries);
      if (byUrl.size > 0 && !aborted) {
        warnings.push("Stránkovaný katalog se nepodařilo načíst – použit jen seznam ze stránky novely, který bývá neúplný.");
      }
      return this.finish(byUrl, pagesLoaded, declaredTotal, aborted, warnings, true);
    }

    if (duplicates > 0 && pagesLoaded > 1) {
      // jen informace – stejné URL na více stránkách (typicky stránka 0 == stránka 1)
    }
    return this.finish(byUrl, pagesLoaded, declaredTotal, aborted, warnings, realFailures.length > 0);
  }

  private finish(
    byUrl: Map<string, Entry>,
    pagesLoaded: number,
    declaredTotal: number | undefined,
    aborted: boolean,
    warnings: string[],
    hadFailures: boolean,
  ): CatalogResult {
    let list = [...byUrl.values()].sort((a, b) => a.page - b.page || a.pos - b.pos);

    // Sestupný výpis (nejnovější první) poznáme podle pořadových čísel v URL.
    let asc = 0;
    let desc = 0;
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1].seq;
      const c = list[i].seq;
      if (p === null || c === null) continue;
      if (c > p) asc++;
      else if (c < p) desc++;
    }
    if (desc > asc * 2 && desc >= 3) list = list.reverse();

    const chapters: ParserChapter[] = list.map((e, i) => ({
      title: e.title,
      url: e.url,
      orderIndex: i,
      label: e.label,
      page: e.page,
    }));

    let complete = !aborted && !hadFailures;
    if (aborted) warnings.push(`Detekce byla zastavena – načteno ${chapters.length} kapitol z ${pagesLoaded} stránek katalogu.`);
    if (declaredTotal && chapters.length < declaredTotal) {
      complete = false;
      if (!aborted) {
        warnings.push(`Web uvádí ${declaredTotal} kapitol, v katalogu jich bylo nalezeno ${chapters.length}. Katalog není kompletní.`);
      }
    }
    if (chapters.length === 0) complete = false;
    return { chapters, pagesLoaded, declaredTotal, complete, aborted, warnings };
  }

  async fetchChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }> {
    const html = await this.fetchHtml(url, opts);
    const doc = this.parseHtml(html);
    const title =
      cleanText(doc.querySelector(".chapter-title, .titles h2, #chapter-article h2, .entry-title")?.textContent ?? "") ||
      cleanText(doc.querySelector("h2, h1")?.textContent ?? "") ||
      extractTitle(doc);

    // Kontejner s nejdelším textem z typických kandidátů.
    let best: Element | null = null;
    let bestLen = 0;
    for (const el of Array.from(
      doc.querySelectorAll(
        ".chapter-content, #chapter-content, #chapter-article .chapter-content, #chapter-container, .reading-content, .entry-content, #content, .txt, article",
      ),
    )) {
      const len = (el.textContent ?? "").trim().length;
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
    if (!best) {
      throw new ContentError("Na stránce nebyl nalezen text kapitoly (web možná změnil strukturu nebo vrátil chybovou stránku)");
    }
    const cleaned = this.cleanContent(best);
    assertChapterContent(cleaned);
    return { title: title || "Chapter", html: cleaned };
  }

  private cleanContent(content: Element): string {
    const clone = content.cloneNode(true) as Element;
    for (const sel of [
      "script", "style", "noscript", "iframe", "nav", "header", "footer", "aside", "ins",
      ".ad", ".ads", ".adsbygoogle", ".advertisement", "[class*='ad-']", "[id*='ad-']", "[class*='ads-']",
      ".social-share", ".share-buttons", ".related-posts", ".comments",
      ".comment-form", "form", "button", ".chapter-nav", ".chapternav", ".pagination",
      ".next-chapter", ".prev-chapter", ".titles", ".chapter-title", ".report", ".tips",
    ]) {
      for (const el of Array.from(clone.querySelectorAll(sel))) el.remove();
    }
    return sanitizeToXhtml(clone.innerHTML);
  }
}
