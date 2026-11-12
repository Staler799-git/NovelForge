/**
 * WuxiaBox: stránkovaný katalog, pořadí, duplicity, dvě číslovací řady,
 * obálka, jazyk a ověření obsahu kapitol.
 *
 * Testy běží proti SIMULACI webu (helpers/wuxiaboxSite.ts) – živý web není
 * z vývojového prostředí dostupný.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSite, singleSeries, twoSeries, fillerText, NOVEL_URL, ORIGIN, SLUG, type SiteOptions } from "./helpers/wuxiaboxSite";

let site: ReturnType<typeof createSite>;

vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: { get: vi.fn((url: string, o?: any) => site.get(url, o)) },
}));

import { WuxiaBoxParser } from "@/services/parser/wuxiabox";
import { analyzeCatalog, compareSeries, findGaps, chapterNumbering } from "@/services/catalog";
import type { CatalogProgress } from "@/types";

function parserFor(opts: SiteOptions): WuxiaBoxParser {
  site = createSite(opts);
  const p = new WuxiaBoxParser();
  p.pageDelayMs = 0;
  return p;
}

const seqOf = (url: string) => Number(url.match(/_(\d+)\.html$/)![1]);

beforeEach(() => vi.clearAllMocks());

describe("WuxiaBox – celý stránkovaný katalog", () => {
  it("načte všech 3 138 kapitol z 32 stránek (ne jen prvních 100)", async () => {
    const parser = parserFor({ entries: singleSeries(3138) });
    const progress: CatalogProgress[] = [];
    const result = await parser.fetchCatalog(NOVEL_URL, { onProgress: (p) => progress.push({ ...p }) });

    expect(result.chapters).toHaveLength(3138);
    expect(result.declaredTotal).toBe(3138);
    expect(result.complete).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.pagesLoaded).toBe(32);

    // první stránka katalogu se načítá také (page=0)
    expect(site.requests).toContain(`${ORIGIN}/e/extend/fy.php?page=0&wjm=${SLUG}`);
    expect(site.requests).toContain(`${ORIGIN}/e/extend/fy.php?page=31&wjm=${SLUG}`);

    // průběžné hlášení počtu nalezených kapitol
    expect(progress.length).toBe(32);
    expect(progress[0]).toMatchObject({ pagesLoaded: 1, chaptersFound: 100, pagesTotal: 32 });
    expect(progress.at(-1)).toMatchObject({ pagesLoaded: 32, chaptersFound: 3138 });
    expect(progress.map((p) => p.chaptersFound)).toEqual([...progress.map((p) => p.chaptersFound)].sort((a, b) => a - b));
  });

  it("zachová pořadí katalogu a souvislé orderIndex", async () => {
    const parser = parserFor({ entries: singleSeries(3138) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    expect(chapters.map((c) => seqOf(c.url))).toEqual(Array.from({ length: 3138 }, (_, i) => i + 1));
    expect(chapters.map((c) => c.orderIndex)).toEqual(Array.from({ length: 3138 }, (_, i) => i));
    expect(chapters[0].title).toBe("Chapter 1 Placeholder Heading 1");
    expect(chapters[0].label).toBe("1");
    expect(chapters[9].url).toBe(`${ORIGIN}/novel/${SLUG}_10.html`);
    expect(new Set(chapters.map((c) => c.url)).size).toBe(3138);
  });

  it("neřadí podle čísla v názvu – rozhoduje pořadí katalogu", async () => {
    // názvy záměrně nesou zavádějící čísla
    const entries = singleSeries(250).map((e) => ({ ...e, title: `Chapter ${1000 - e.seq} Misleading` }));
    const parser = parserFor({ entries });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    expect(chapters.map((c) => seqOf(c.url))).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });

  it("funguje i pro stránkování od 1 (stránka 0 neexistuje)", async () => {
    const parser = parserFor({ entries: singleSeries(730), firstPage: 1 });
    const result = await parser.fetchCatalog(NOVEL_URL);
    expect(result.chapters).toHaveLength(730);
    expect(result.complete).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.chapters.map((c) => seqOf(c.url))).toEqual(Array.from({ length: 730 }, (_, i) => i + 1));
  });

  it("odstraní skutečné duplicity (stejná URL na více stránkách)", async () => {
    const parser = parserFor({ entries: singleSeries(450), firstPage: 1, page0Mirrors1: true });
    const result = await parser.fetchCatalog(NOVEL_URL);
    expect(result.chapters).toHaveLength(450);
    expect(new Set(result.chapters.map((c) => c.url)).size).toBe(450);
    expect(result.complete).toBe(true);
  });

  it("sestupný výpis (nejnovější první) otočí do správného pořadí", async () => {
    const parser = parserFor({ entries: singleSeries(320), descending: true });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    expect(chapters.map((c) => seqOf(c.url))).toEqual(Array.from({ length: 320 }, (_, i) => i + 1));
  });

  it("upozorní, když stránka katalogu selže – katalog není kompletní", async () => {
    const parser = parserFor({ entries: singleSeries(1000), failPages: [4] });
    const result = await parser.fetchCatalog(NOVEL_URL);
    expect(result.chapters).toHaveLength(900);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/Stránku katalogu 4 se nepodařilo načíst.*HTTP 500/);
    expect(result.warnings.join(" ")).toMatch(/Web uvádí 1000 kapitol.*nalezeno 900/);
    // chybějící úsek odhalí i kontrola číslování
    const gaps = findGaps(result.chapters);
    expect(gaps.reliable).toBe(true);
    expect(gaps.missingCount).toBe(100);
    expect(gaps.missing[0]).toBe(401);
  });

  it("upozorní, když web uvádí víc kapitol, než katalog obsahuje", async () => {
    const parser = parserFor({ entries: singleSeries(240), declaredTotal: 3138 });
    const result = await parser.fetchCatalog(NOVEL_URL);
    expect(result.chapters).toHaveLength(240);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/Web uvádí 3138 kapitol/);
  });

  it("detekci lze zastavit – vrátí dosud nalezené kapitoly", async () => {
    const parser = parserFor({ entries: singleSeries(3138) });
    const ctrl = new AbortController();
    const result = await parser.fetchCatalog(NOVEL_URL, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.pagesLoaded === 3) ctrl.abort();
      },
    });
    expect(result.aborted).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.chapters).toHaveLength(300);
    expect(result.warnings.join(" ")).toMatch(/Detekce byla zastavena/);
    // po zastavení už se další stránky nenačítají
    expect(site.requests.filter((u) => u.includes("fy.php")).length).toBe(3);
  });
});

describe("WuxiaBox – dvě číslovací řady", () => {
  it("položky se stejným číslem, ale jinou URL NEJSOU duplicity", async () => {
    const parser = parserFor({ entries: twoSeries(160) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    expect(chapters).toHaveLength(320);
    expect(chapters.slice(0, 4).map((c) => `${c.label} ${c.title}`)).toEqual([
      "001 Chapter 001",
      "1 Chapter 1 Placeholder Heading 1",
      "002 Chapter 002",
      "2 Chapter 2 Placeholder Heading 2",
    ]);
  });

  it("rozpozná obě řady a nabídne je zvlášť, v pořadí katalogu", async () => {
    const parser = parserFor({ entries: twoSeries(160) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const analysis = analyzeCatalog(chapters);

    expect(analysis.series).toHaveLength(2);
    expect(analysis.duplicateNumbers).toBe(160);
    const [bare, titled] = analysis.series;
    expect(bare.count).toBe(160);
    expect(titled.count).toBe(160);
    expect(bare.label).toMatch(/bez názvů/);
    expect(titled.label).toMatch(/s názvy/);

    const titledSet = new Set(titled.urls);
    const picked = chapters.filter((c) => titledSet.has(c.url));
    expect(picked.every((c) => /Placeholder Heading/.test(c.title))).toBe(true);
    // žádné promíchání: čísla jedné řady jdou souvisle 1..160
    expect(picked.map((c) => chapterNumbering(c).num)).toEqual(Array.from({ length: 160 }, (_, i) => i + 1));
    expect(findGaps(picked)).toMatchObject({ reliable: true, missingCount: 0, first: 1, last: 160 });
  });

  it("jedna řada se jako dvě nehlásí", async () => {
    const parser = parserFor({ entries: singleSeries(400) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    expect(analyzeCatalog(chapters).series).toHaveLength(0);
  });

  it("porovnání obsahu: shodný text => duplicitní obsah", async () => {
    // obě položky téhož čísla vrací stejný text (liší se jen HTML obalem)
    const parser = parserFor({ entries: twoSeries(40), chapterText: (seq) => fillerText(Math.ceil(seq / 2)) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const { series } = analyzeCatalog(chapters);
    const cmp = await compareSeries(chapters, series[0], series[1], (u) => parser.fetchChapter(u));
    expect(cmp.verdict).toBe("identical");
    expect(cmp.pairs.length).toBeGreaterThan(0);
    // (simulovaná stránka přidává ke každé kapitole jednu větu s číslem položky)
    expect(cmp.pairs.every((p) => p.similarity >= 0.9)).toBe(true);
  });

  it("porovnání obsahu: odlišný text => řady se nemají míchat", async () => {
    const parser = parserFor({ entries: twoSeries(40), chapterText: (seq) => fillerText(seq * 13 + (seq % 2) * 101, 16) + ` unique-${seq}` });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const { series } = analyzeCatalog(chapters);
    const cmp = await compareSeries(chapters, series[0], series[1], (u) => parser.fetchChapter(u));
    expect(cmp.verdict).not.toBe("identical");
    expect(cmp.message).toMatch(/Vyberte jednu řadu|nemíchejte/);
  });
});

describe("WuxiaBox – metadata, obálka, jazyk", () => {
  it("obálku bere z lazy-load atributu a převede ji na absolutní URL", async () => {
    const parser = parserFor({ entries: singleSeries(5) });
    const meta = await parser.fetchMetadata(NOVEL_URL);
    expect(meta.coverUrl).toBe(`${ORIGIN}/files/article/image/12/${SLUG}.jpg`);
    expect(meta.title).toBe("Sample Longevity Club Novel");
    expect(meta.author).toBe("Test Author");
    expect(meta.declaredChapters).toBe(5);
    expect(meta.sourceDomain).toBe("www.wuxiabox.com");
  });

  it("zvládne i protokolově relativní adresu obálky", async () => {
    const parser = parserFor({ entries: singleSeries(5), coverAttr: 'src="//cdn.example.net/covers/a.webp"' });
    expect((await parser.fetchMetadata(NOVEL_URL)).coverUrl).toBe("https://cdn.example.net/covers/a.webp");
  });

  it("jazyk anglické novely je en, nikoli cs", async () => {
    const parser = parserFor({ entries: singleSeries(5) });
    expect((await parser.fetchMetadata(NOVEL_URL)).language).toBe("en");
  });
});

describe("WuxiaBox – obsah kapitoly", () => {
  it("vrátí vyčištěný well-formed text bez reklam, skriptů a navigace", async () => {
    const parser = parserFor({ entries: singleSeries(5) });
    const ch = await parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_3.html`);
    expect(ch.title).toBe("Chapter 3 Placeholder Heading 3");
    expect(ch.html).toContain("sample line 3-0");
    expect(ch.html).toContain("<br/>");
    expect(ch.html).toContain("<em>emphasis</em>");
    expect(ch.html).not.toMatch(/ADVERT|not content|Next|Footer|&nbsp;|<script/);
  });

  it("HTTP 404 je chyba s konkrétním důvodem, kterou nemá smysl opakovat", async () => {
    const parser = parserFor({ entries: singleSeries(5) });
    await expect(parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_999.html`)).rejects.toMatchObject({
      message: expect.stringMatching(/HTTP 404/),
      retryable: false,
    });
  });

  it("blokační stránku (Cloudflare) neuzná jako kapitolu", async () => {
    const parser = parserFor({
      entries: singleSeries(5),
      chapterOverride: (seq) =>
        seq === 2
          ? { status: 403, data: "<html><head><title>Just a moment...</title></head><body><div id='cf-chl-widget'>Checking your browser</div><script>1</script></body></html>" }
          : undefined,
    });
    await expect(parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_2.html`)).rejects.toThrow(/Cloudflare/);
  });

  it("CAPTCHA se stavem 200 neuzná jako kapitolu", async () => {
    const parser = parserFor({
      entries: singleSeries(5),
      chapterOverride: () => ({ status: 200, data: "<html><body><div class='chapter-content'><div class='g-recaptcha'></div>Please verify you are human.</div></body></html>" }),
    });
    await expect(parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_1.html`)).rejects.toThrow(/CAPTCHA/);
  });

  it("prázdnou / příliš krátkou kapitolu neuzná", async () => {
    const parser = parserFor({
      entries: singleSeries(5),
      chapterOverride: () => ({ status: 200, data: "<html><body><div class='chapter-content'><p>Coming soon.</p></div><p>Lots of unrelated page chrome text so the page itself is not considered empty by the loader, only the chapter body is too short to be real.</p></body></html>" }),
    });
    await expect(parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_1.html`)).rejects.toThrow(/podezřele krátký/);
  });

  it("server error je chyba, kterou lze opakovat", async () => {
    const parser = parserFor({ entries: singleSeries(5), chapterOverride: () => ({ status: 503, data: "" }) });
    await expect(parser.fetchChapter(`${ORIGIN}/novel/${SLUG}_1.html`)).rejects.toThrow(/HTTP 503/);
  });
});
