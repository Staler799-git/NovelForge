/**
 * WTR-LAB.
 *
 * POZOR: živý web wtr-lab.com není z vývojového prostředí dostupný. Stránky
 * níže jsou SYNTETICKÉ vzorky napodobující aplikaci v Next.js (data ve
 * <script id="__NEXT_DATA__">, obsah vykreslený až JavaScriptem). Testy ověřují
 * chování parseru nad těmito tvary – ne shodu se skutečnou strukturou webu.
 * Texty i počty kapitol jsou vymyšlené.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { XMLValidator } from "fast-xml-parser";

const pages: Record<string, { status?: number; data: string }> = {};
const rendered: Record<string, string> = {};
const requests: string[] = [];
const renders: string[] = [];
const posts: Array<{ url: string; body: any }> = [];
type Routed = { status?: number; data: unknown } | undefined;
let getHandler: ((url: string) => Routed) | null = null;
let postHandler: ((body: any) => Routed) | null = null;
let renderHandler: ((url: string) => string | undefined) | null = null;

vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: {
    postJson: vi.fn(async (url: string, body: any) => {
      posts.push({ url, body });
      const r = postHandler?.(body);
      if (!r) return { url, status: 404, ok: false, data: "<html><body>Not Found</body></html>", headers: {} };
      const status = r.status ?? 200;
      return { url, status, ok: status >= 200 && status < 300, data: typeof r.data === "string" ? r.data : JSON.stringify(r.data), headers: {} };
    }),
    get: vi.fn(async (url: string) => {
      requests.push(url);
      const routed = getHandler?.(url);
      if (routed) {
        const status = routed.status ?? 200;
        return { url, status, ok: status >= 200 && status < 300, data: typeof routed.data === "string" ? routed.data : JSON.stringify(routed.data), headers: {} };
      }
      const p = pages[url];
      if (!p) return { url, status: 404, ok: false, data: "<html><body>Not Found</body></html>", headers: {} };
      const status = p.status ?? 200;
      return { url, status, ok: status >= 200 && status < 300, data: p.data, headers: {} };
    }),
  },
}));
vi.mock("@/services/render", () => ({
  renderHtml: vi.fn(async (url: string) => {
    renders.push(url);
    const dynamic = renderHandler?.(url);
    if (dynamic !== undefined) return dynamic;
    if (!(url in rendered)) throw new Error("Nativní modul WebRenderer není k dispozici");
    return rendered[url];
  }),
}));

import { getParser, GenericNovelParser, WtrLabParser } from "@/services/parser/registry";
import { parseWtrUrl, resolveTokens } from "@/services/parser/wtrlab";
import { numberCoverage, formatRanges } from "@/services/catalog";
import { UNRELIABLE_CATALOG } from "@/services/parser/generic";
import { htmlToText } from "@/services/content";
import { chapterToXhtml } from "@/services/downloader";

const NOVEL = "https://wtr-lab.com/en/novel/7898/i-created-the-longevity-club";
const CH1 = `${NOVEL}/chapter-1`;
const TOTAL = 412; // záměrně jiné číslo než na skutečném webu – nic není zadáno napevno

/** Kostra webu: bez dat vypadá přesně jako to, co dřív vedlo k projektu „WTR-LAB“ s kapitolou „v1.13.17“. */
function shell(body: string, nextData?: unknown, head = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>WTR-LAB</title>
<meta property="og:site_name" content="WTR-LAB"><meta property="og:title" content="WTR-LAB">${head}</head>
<body><nav><a href="/en">Home</a><a href="/en/novel-finder">Finder</a><a href="/en/login">Login</a></nav>
<div id="__next">${body}</div>
<footer><a href="/en/changelog/1">v1.13.17</a><a href="/en/privacy">Privacy</a></footer>
${nextData ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData).replace(/</g, "\\u003c")}</script>` : ""}
<script src="/_next/static/chunks/main.js"></script></body></html>`;
}

const serie = {
  id: 55, raw_id: 7898, slug: "i-created-the-longevity-club", chapter_count: TOTAL,
  data: { title: "Sample Longevity Club", author: "Wo Xing Yu", description: "Synthetic description of a sample novel.", image: "https://img.example-cdn.test/covers/7898.jpg" },
};
const para = (n: number, i: number) => `Synthetic paragraph ${i} of chapter ${n}: the clerk counted lanterns along the quiet harbor and wrote the number in a ledger.`;
const chapterData = (n: number) => ({ props: { pageProps: { serie, chapter: { order: n, title: `Sample Heading ${n}`, data: { body: [1, 2, 3, 4].map((i) => para(n, i)) } } } } });

function reset() {
  for (const k of Object.keys(pages)) delete pages[k];
  for (const k of Object.keys(rendered)) delete rendered[k];
  requests.length = 0;
  renders.length = 0;
  posts.length = 0;
  getHandler = null;
  postHandler = null;
  renderHandler = null;
  const parser = getParser(NOVEL) as WtrLabParser;
  parser.catalogDelayMs = 0;
  parser.chapterIntervalMs = 0;
  (parser as any).preferredMode = null;
}
beforeEach(reset);

describe("WTR-LAB – adresy", () => {
  it("má vlastní parser, obecný se nepoužije", () => {
    expect(getParser(NOVEL)).toBeInstanceOf(WtrLabParser);
    expect(getParser(CH1)).toBeInstanceOf(WtrLabParser);
    expect(getParser("https://www.wtr-lab.com/en/novel/1/x")).toBeInstanceOf(WtrLabParser);
    expect(getParser("https://example.com/novel/1/x")).toBeInstanceOf(GenericNovelParser);
  });
  it("rozloží adresu novely i kapitoly a z kapitoly odvodí adresu novely", () => {
    expect(parseWtrUrl(NOVEL)).toMatchObject({ lang: "en", id: "7898", slug: "i-created-the-longevity-club", chapter: null, novelUrl: NOVEL });
    expect(parseWtrUrl(CH1)).toMatchObject({ chapter: 1, novelUrl: NOVEL });
    expect(parseWtrUrl(`${NOVEL}/chapter-3138?service=web#x`)).toMatchObject({ chapter: 3138, novelUrl: NOVEL });
    expect(parseWtrUrl("https://wtr-lab.com/en")).toBeNull();
    expect(parseWtrUrl("https://wtr-lab.com/en/changelog/1")).toBeNull();
  });
});

describe("WTR-LAB – metadata", () => {
  it("čte název, autora, popis, obálku, jazyk a počet kapitol z dat stránky", async () => {
    pages[NOVEL] = { data: shell("<h1>Sample Longevity Club</h1>", { props: { pageProps: { serie } } }) };
    const meta = await getParser(NOVEL).fetchMetadata(NOVEL);
    expect(meta).toMatchObject({
      title: "Sample Longevity Club", author: "Wo Xing Yu", description: "Synthetic description of a sample novel.", language: "en",
      coverUrl: "https://img.example-cdn.test/covers/7898.jpg", sourceUrl: NOVEL, sourceDomain: "wtr-lab.com", declaredChapters: TOTAL,
    });
  });

  it("adresa kapitoly se sama přepne na stránku novely", async () => {
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie } } }) };
    const meta = await getParser(CH1).fetchMetadata(CH1);
    expect(meta.title).toBe("Sample Longevity Club");
    expect(meta.sourceUrl).toBe(NOVEL);
    expect(requests).toEqual([NOVEL]);
  });

  it("bez dat ve statickém HTML použije vykreslení ve WKWebView (autor v čínštině, lazy obálka)", async () => {
    pages[NOVEL] = { data: shell("") };
    rendered[NOVEL] = shell(`<main><img class="cover" src="/_next/image?url=%2Fcovers%2F7898.jpg&amp;w=256" alt="Sample Longevity Club">
      <h1>Sample Longevity Club</h1><a href="/en/author/55">我姓俞</a><p class="desc">Synthetic description.</p><span>${TOTAL} Chapters</span></main>`);
    const meta = await getParser(NOVEL).fetchMetadata(NOVEL);
    expect(renders).toEqual([NOVEL]);
    expect(meta.title).toBe("Sample Longevity Club");
    expect(meta.author).toBe("我姓俞");
    expect(meta.declaredChapters).toBe(TOTAL);
    expect(meta.coverUrl).toMatch(/^https:\/\/wtr-lab\.com\/_next\/image/);
  });

  it("nikdy nevrátí název webu jako název novely", async () => {
    pages[NOVEL] = { data: shell("") }; // prázdná kostra, vykreslení není k dispozici
    await expect(getParser(NOVEL).fetchMetadata(NOVEL)).rejects.toThrow(/nepodařilo spolehlivě přečíst/);
  });

  it("stránku s ověřením (CAPTCHA) neobchází a ohlásí ji", async () => {
    pages[NOVEL] = { status: 403, data: "<html><head><title>Just a moment...</title></head><body><div id='challenge-form'>Checking your browser before accessing. Please complete the captcha.</div></body></html>" };
    await expect(getParser(NOVEL).fetchMetadata(NOVEL)).rejects.toThrow();
    expect(requests.every((u) => u === NOVEL)).toBe(true); // žádné jiné adresy (API) se nezkouší
  });
});

/**
 * Stránka novely tak, jak ji popisují open-source čtečky: data v
 * props.pageProps.serie.serie_data a v HTML jen několik posledních kapitol.
 */
function novelPage(total: number | null, visibleLast = 5): string {
  const links = total
    ? Array.from({ length: visibleLast }, (_, i) => total - i).map((n) => `<a href="/en/novel/7898/i-created-the-longevity-club/chapter-${n}">Sample Heading ${n}</a>`).join("")
    : "";
  const serie_data = { id: 55, raw_id: 7898, slug: "i-created-the-longevity-club", ...(total ? { chapter_count: total } : {}), data: serie.data };
  return shell(`<main><h1>Sample Longevity Club</h1><div class="latest">${links}</div></main>`, { props: { pageProps: { serie: { serie_data } } } });
}

interface ApiOptions {
  /** Čísla kapitol, která web v seznamu nemá. */
  gaps?: number[];
  /** Server ignoruje start/end a vrací vždy vše. */
  ignoreRange?: boolean;
  /** Dávky (podle `start`), které selžou. */
  failStarts?: number[];
  title?: (n: number) => string;
  wrap?: (chapters: unknown[]) => unknown;
  /** Odpověď pro běžný HTTP požadavek (např. stránka ověření); data pak vydá jen WKWebView. */
  httpBlocked?: boolean;
}
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/x.js'></script></body></html>";

/** Napodobí rozhraní /api/chapters/{id}?start=&end= */
function chapterApi(total: number, o: ApiOptions = {}) {
  const calls: Array<{ start: number; end: number }> = [];
  const answer = (url: string): Routed => {
    const u = new URL(url);
    if (u.pathname !== "/api/chapters/7898") return undefined;
    const start = Number(u.searchParams.get("start"));
    const end = Number(u.searchParams.get("end"));
    calls.push({ start, end });
    if (o.failStarts?.includes(start)) return { status: 500, data: "<html><body>Internal Server Error</body></html>" };
    const gaps = new Set(o.gaps ?? []);
    const list = [];
    for (let n = o.ignoreRange ? 1 : start; n <= (o.ignoreRange ? total : Math.min(end, total)); n++) {
      if (!gaps.has(n)) list.push({ id: 900000 + n, serie_id: 55, order: n, title: (o.title ?? ((k: number) => `Sample Heading ${k}`))(n), updated_at: "2026-01-01T00:00:00Z" });
    }
    return { data: o.wrap ? o.wrap(list) : { chapters: list } };
  };
  if (o.httpBlocked) {
    getHandler = (url) => (new URL(url).pathname.startsWith("/api/") ? { status: 403, data: CHALLENGE } : undefined);
    renderHandler = (url) => {
      const r = answer(url);
      // WKWebView zobrazí JSON jako text v <pre>
      return r ? `<html><head></head><body><pre>${JSON.stringify(r.data).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>` : undefined;
    };
  } else getHandler = answer;
  return calls;
}

describe("WTR-LAB – katalog", () => {
  const REAL = 3138; // počet, který web uváděl při testu na zařízení; parser ho bere ze stránky, ne z kódu
  const urls = (cat: { chapters: Array<{ url: string }> }) => new Set(cat.chapters.map((c) => c.url));

  it("pět viditelných kapitol není katalog: úplný seznam se načte po dávkách z rozhraní webu", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    const calls = chapterApi(REAL);
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(calls).toEqual([1, 501, 1001, 1501, 2001, 2501, 3001].map((start) => ({ start, end: start + 499 })));
    expect(cat.chapters).toHaveLength(REAL);
    expect(cat.declaredTotal).toBe(REAL);
    expect(cat.complete).toBe(true);
    expect(cat.warnings).toEqual([]);
    expect(cat.pagesLoaded).toBe(7);
    // správné pořadí a adresy
    expect(cat.chapters.map((c) => c.orderIndex)).toEqual(Array.from({ length: REAL }, (_, i) => i));
    expect(cat.chapters.map((c) => Number(c.label))).toEqual(Array.from({ length: REAL }, (_, i) => i + 1));
    for (const n of [1, 2, 100, 1500, 3138]) {
      expect(cat.chapters[n - 1]).toMatchObject({ url: `${NOVEL}/chapter-${n}`, title: `Sample Heading ${n}`, label: String(n) });
    }
    expect(urls(cat).size).toBe(REAL);
  });

  it("počet kapitol se bere ze stránky – jiná novela, jiný počet", async () => {
    pages[NOVEL] = { data: novelPage(TOTAL) };
    const calls = chapterApi(TOTAL);
    const cat = await getParser(CH1).fetchCatalog(CH1); // i z adresy kapitoly
    expect(calls).toEqual([{ start: 1, end: 500 }]);
    expect(cat.chapters).toHaveLength(TOTAL);
    expect(cat.complete).toBe(true);
  });

  it("rozhraní nedostupné => chyba; z pěti viditelných kapitol projekt nevznikne a adresy se neodhadují", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    const err = await getParser(NOVEL).fetchCatalog(NOVEL).then(() => null, (e) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/^Katalog kapitol nebyl spolehlivě rozpoznán\./);
    expect(err!.message).toMatch(/uvádí 3138 kapitol/);
    expect(err!.message).toMatch(/HTTP 404/);
    expect(err!.message).toMatch(/je vidět jen 5 kapitol \(3134–3138\)/);
    expect(err!.message).toMatch(/adresy kapitol se neodhadují/);
  });

  it("běžný požadavek narazí na ověření prohlížeče => data se přečtou ve WKWebView", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    chapterApi(REAL, { httpBlocked: true });
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(REAL);
    expect(cat.complete).toBe(true);
    expect(renders.filter((u) => u.includes("/api/chapters/7898?start="))).toHaveLength(7);
  });

  it("ověření neprojde ani ve WKWebView => chyba s důvodem, nic se neobchází", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    getHandler = (url) => (new URL(url).pathname.startsWith("/api/") ? { status: 403, data: CHALLENGE } : undefined);
    renderHandler = (url) => (url.includes("/api/") ? CHALLENGE : undefined);
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/HTTP 403 \(web vyžaduje ověření prohlížeče\); ani ve WKWebView adresa nevrátila data/);
  });

  it("selže jedna dávka => katalog NENÍ kompletní a varování jmenuje chybějící rozsah", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    chapterApi(REAL, { failStarts: [1001] });
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.complete).toBe(false);
    expect(cat.chapters).toHaveLength(REAL - 500);
    expect(cat.warnings[0]).toMatch(/Katalog NENÍ kompletní: ověřeno 2638 kapitol z 3138, chybí 500 \(1001–1500\)/);
    expect(cat.warnings[1]).toMatch(/Část seznamu se nepodařilo načíst \(HTTP 500.*\): rozsahy 1001–1500/);
    expect(urls(cat).has(`${NOVEL}/chapter-1200`)).toBe(false); // nic odvozeného
    expect(urls(cat).has(`${NOVEL}/chapter-1501`)).toBe(true);
    // pořadí zůstává souvislé, čísla kapitol zůstávají pravdivá
    expect(cat.chapters[1000]).toMatchObject({ orderIndex: 1000, label: "1501" });
  });

  it("skutečné mezery v číslování web => neúplný katalog se seznamem mezer", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    chapterApi(REAL, { gaps: [57, 2000, 2001, 2002, 2003, 2004] });
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.complete).toBe(false);
    expect(cat.chapters).toHaveLength(REAL - 6);
    expect(cat.warnings[0]).toMatch(/ověřeno 3132 kapitol z 3138, chybí 6 \(57, 2000–2004\)/);
  });

  it("seznam kratší než uváděný počet => neúplný (chybí konec)", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    chapterApi(3130);
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.complete).toBe(false);
    expect(cat.chapters).toHaveLength(3130);
    expect(cat.warnings[0]).toMatch(/chybí 8 \(3131–3138\)/);
  });

  it("seznam delší než uváděný počet (nové kapitoly) je kompletní a upozorní na rozdíl", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    chapterApi(3141);
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(3141);
    expect(cat.complete).toBe(true);
    expect(cat.warnings.join(" ")).toMatch(/až do čísla 3141; stránka novely uvádí 3138/);
  });

  it("server, který rozsah ignoruje a vrací vždy vše, nezpůsobí duplicity ani smyčku", async () => {
    pages[NOVEL] = { data: novelPage(REAL) };
    const calls = chapterApi(REAL, { ignoreRange: true });
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(REAL);
    expect(cat.complete).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("odpověď zabalená v `data` se přijme; neznámý tvar odpovědi je chyba, ne odhad", async () => {
    pages[NOVEL] = { data: novelPage(TOTAL) };
    chapterApi(TOTAL, { wrap: (chapters) => ({ success: true, data: { chapters } }) });
    expect((await getParser(NOVEL).fetchCatalog(NOVEL)).chapters).toHaveLength(TOTAL);

    chapterApi(TOTAL, { wrap: (chapters) => ({ items: chapters }) });
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/neočekávaný formát odpovědi/);
    chapterApi(TOTAL, { wrap: () => ({ chapters: [{ title: "no number" }, { title: "also none" }] }) });
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/Katalog kapitol nebyl spolehlivě rozpoznán/);
  });

  it("značky %{text|base64} v názvech nahradí čitelným textem", async () => {
    pages[NOVEL] = { data: novelPage(TOTAL) };
    const b64 = btoa("Club");
    chapterApi(TOTAL, { title: (n) => (n === 2 ? `The %{Society|${b64}} Opens` : n === 3 ? "" : `Sample Heading ${n}`) });
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters[1].title).toBe("The Club Opens");
    expect(cat.chapters[2].title).toBe("Chapter 3"); // prázdný název => číslo kapitoly
    expect(resolveTokens('A %{"x y":"A"} B')).toBe("A x y B"); // neplatné base64 => viditelný text
    expect(resolveTokens("50 %{ off")).toBe("50 %{ off");
  });

  it("stránka neuvádí počet => úplnost jen podle souvislosti číslování, s upozorněním", async () => {
    pages[NOVEL] = { data: novelPage(null) };
    chapterApi(40);
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(40);
    expect(cat.complete).toBe(true);
    expect(cat.declaredTotal).toBeUndefined();
    expect(cat.warnings.join(" ")).toMatch(/neuvádí počet kapitol/);
  });

  it("bez rozhraní se seznam ze stránky použije jen když pokrývá celý rozsah", async () => {
    const list = Array.from({ length: TOTAL }, (_, i) => ({ id: 9000 + i, order: TOTAL - i, title: `Sample Heading ${TOTAL - i}` }));
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie, chapters: list } } }) };
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(TOTAL);
    expect(cat.complete).toBe(true);
    expect(cat.chapters[0]).toMatchObject({ title: "Sample Heading 1", url: CH1 });
    expect(cat.warnings.join(" ")).toMatch(/přímo ze stránky novely/);

    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie, chapters: list.slice(0, 50) } } }) };
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/je vidět jen 50 kapitol \(363–412\)/);
  });

  it("jen počet kapitol bez seznamu => chyba (dřív se adresy odhadovaly)", async () => {
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie } } }) };
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/úplný seznam se nepodařilo načíst/);
  });

  it("prázdná kostra webu => chyba, žádná falešná kapitola „v1.13.17“", async () => {
    pages[NOVEL] = { data: shell("") };
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/Katalog kapitol nebyl spolehlivě rozpoznán/);
  });
});

describe("kontrola pokrytí číselného rozsahu", () => {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  it("úplné pokrytí 1…N", () => {
    expect(numberCoverage(range(1, 3138), 3138)).toMatchObject({ unique: 3138, duplicates: 0, min: 1, max: 3138, missingCount: 0, complete: true });
  });
  it("posledních pět kapitol z 3138 není úplný katalog", () => {
    const c = numberCoverage(range(3134, 3138), 3138);
    expect(c).toMatchObject({ unique: 5, complete: false, missingCount: 3133 });
    expect(c.missing).toEqual([[1, 3133]]);
  });
  it("počítá unikátní čísla, duplicity a skutečné mezery", () => {
    const c = numberCoverage([1, 2, 2, 3, 5, 6, 9, 9, 9], 10);
    expect(c).toMatchObject({ unique: 6, duplicates: 3, complete: false, missingCount: 4, expectedLast: 10 });
    expect(c.missing).toEqual([[4, 4], [7, 8], [10, 10]]);
    expect(formatRanges(c.missing)).toBe("4, 7–8, 10");
  });
  it("bez uváděného počtu kontroluje jen souvislost; prázdný seznam úplný není", () => {
    expect(numberCoverage(range(1, 40)).complete).toBe(true);
    expect(numberCoverage(range(2, 40)).complete).toBe(false);
    expect(numberCoverage([], 10).complete).toBe(false);
    expect(numberCoverage([], null)).toMatchObject({ unique: 0, complete: false });
  });
});

describe("WTR-LAB – text kapitol", () => {
  it("stránka kapitoly se nevykresluje: z vykreslené stránky nejde poznat překlad", async () => {
    pages[CH1] = { data: shell("", chapterData(1)) };
    rendered[CH1] = shell(`<main><div class="chapter-body">${[1, 2, 3, 4].map((i) => `<p>${para(1, i)}</p>`).join("")}</div></main>`);
    await expect(getParser(CH1).fetchChapter(CH1)).rejects.toMatchObject({ kind: "unavailable" });
    expect(renders).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("adresa novely není kapitola", async () => {
    await expect(getParser(NOVEL).fetchChapter(NOVEL)).rejects.toThrow(/neodkazuje na kapitolu/);
  });
});

describe("WTR-LAB – text kapitol z rozhraní čtečky", () => {
  const body = (n: number) => [1, 2, 3, 4].map((i) => para(n, i));
  const chUrl = (n: number) => `${NOVEL}/chapter-${n}`;

  it("kapitoly 1, 2, 100, 1500 a 3138: správný požadavek, název a celý text", async () => {
    postHandler = (b) => ({ data: { success: true, chapter: { title: `Sample Heading ${b.chapter_no}` }, data: { data: { title: "x", body: body(b.chapter_no) } } } });
    for (const n of [1, 2, 100, 1500, 3138]) {
      const ch = await getParser(NOVEL).fetchChapter(chUrl(n));
      expect(ch.title).toBe(`Sample Heading ${n}`);
      const text = htmlToText(ch.html);
      for (const i of [1, 2, 3, 4]) expect(text).toContain(para(n, i));
      expect(XMLValidator.validate(chapterToXhtml(ch.title, ch.html, "Sample Longevity Club", "Wo Xing Yu", "en"))).toBe(true);
    }
    expect(posts[0]).toEqual({ url: "https://wtr-lab.com/api/reader/get", body: { translate: "ai", language: "en", raw_id: 7898, chapter_no: 1, retry: false, force_retry: false } });
    expect(posts.map((p) => p.body.chapter_no)).toEqual([1, 2, 100, 1500, 3138]);
    expect(requests).toEqual([]); // stránka kapitoly se zbytečně nestahuje
    expect(renders).toEqual([]);
  });

  it("obsah přes content_url, slovníček ※N⛬, [image] a značky %{…} se zpracují", async () => {
    postHandler = () => ({ data: { success: true, chapter: { title: "Meeting ※0⛬" }, content_url: "/api/reader/content/abc.json" } });
    getHandler = (url) =>
      url === "https://wtr-lab.com/api/reader/content/abc.json"
        ? { data: { data: { data: { title: "x", body: ["※0⛬ greeted ※1〓 at the gate of the old harbor.", "[image]", `The %{Guild|${btoa("Club")}} was quiet & cold <tonight>.`, ...body(7)], glossary_data: { terms: [["Mirela", "米"], ["Ostrander", "奥"]] } } } } }
        : undefined;
    const ch = await getParser(NOVEL).fetchChapter(chUrl(7));
    const text = htmlToText(ch.html);
    expect(ch.title).toBe("Meeting Mirela");
    expect(text).toContain("Mirela greeted Ostrander at the gate of the old harbor.");
    expect(text).toContain("The Club was quiet & cold <tonight>.");
    expect(text).not.toMatch(/※|\[image\]|%\{/);
    expect(XMLValidator.validate(`<div>${ch.html}</div>`)).toBe(true);
  });

  it("zamčený překlad AI se NEnahradí jiným: žádný automatický přechod na Web", async () => {
    postHandler = (b) => (b.translate === "ai" ? { data: { code: "CHAPTER_LOCKED" } } : { data: { success: true, data: { data: { title: `Web Heading ${b.chapter_no}`, body: body(b.chapter_no) } } } });
    await expect(getParser(NOVEL).fetchChapter(chUrl(11))).rejects.toMatchObject({ kind: "login-required", stopSource: true });
    expect(posts.map((p) => p.body.translate)).toEqual(["ai"]);
    // výslovně zvolený Web se stáhne a ohlásí svůj režim
    posts.length = 0;
    const ch = await getParser(NOVEL).fetchChapter(chUrl(11), { translationMode: "web" });
    expect(ch).toMatchObject({ title: "Web Heading 11", translationMode: "web" });
    expect(posts.map((p) => p.body.translate)).toEqual(["web"]);
  });

  it("web žádá ověření Turnstile => nic se neobchází, nic se nevykresluje, další režim se nezkouší", async () => {
    postHandler = () => ({ data: { requireTurnstile: true } });
    rendered[CH1] = shell(`<main><div class="chapter-body">${body(1).map((p) => `<p>${p}</p>`).join("")}</div></main>`);
    await expect(getParser(NOVEL).fetchChapter(CH1)).rejects.toMatchObject({ kind: "challenge", stopSource: true, message: expect.stringMatching(/Turnstile.*neobchází/) });
    expect(posts).toHaveLength(1);
    expect(renders).toEqual([]);
  });

  it("chráněný (šifrovaný) obsah nedešifruje", async () => {
    postHandler = () => ({ data: { success: true, data: { data: { title: "x", body: "arr:AAAA:BBBB:CCCC" } } } });
    await expect(getParser(NOVEL).fetchChapter(CH1, { translationMode: "web" })).rejects.toMatchObject({ kind: "mode-unsupported", stopSource: true, message: expect.stringMatching(/Překlad Web .*chráněné podobě.*nedešifruje/) });
    postHandler = () => ({ data: { success: true, data: { data: { title: "x", body: ["str:AAAA:BBBB", "str:CCCC"] } } } });
    await expect(getParser(NOVEL).fetchChapter(CH1, { translationMode: "webplus" })).rejects.toMatchObject({ kind: "mode-unsupported" });
  });

  it("nevyplněné zástupné značky ani obsah z cizí adresy neuloží", async () => {
    postHandler = () => ({ data: { success: true, data: { data: { title: "x", body: ["※5⛬ walked. " + para(1, 1), ...body(1)], glossary_data: { terms: [["Only"]] } } } } });
    await expect(getParser(NOVEL).fetchChapter(CH1)).rejects.toThrow(/nevyplněné zástupné značky/);
    postHandler = () => ({ data: { success: true, content_url: "https://evil.example.org/x.json" } });
    await expect(getParser(NOVEL).fetchChapter(CH1)).rejects.toThrow(/obsah kapitoly odkazuje mimo web/);
    expect(requests.some((u) => u.includes("evil.example.org"))).toBe(false);
  });

  it("mezi kapitolami drží odstup (web omezuje rychlost)", async () => {
    postHandler = (b) => ({ data: { success: true, data: { data: { title: "t", body: body(b.chapter_no) } } } });
    const parser = getParser(NOVEL) as WtrLabParser;
    parser.chapterIntervalMs = 60;
    const t0 = Date.now();
    await Promise.all([parser.fetchChapter(chUrl(1)), parser.fetchChapter(chUrl(2)), parser.fetchChapter(chUrl(3))]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110); // tři souběžné požadavky šly za sebou
  });
});

describe("obecný parser – jistota detekce katalogu", () => {
  const URL_ = "https://reader.example.org/en/novel/7898/sample";
  const generic = new GenericNovelParser();

  it("kostra webu s odkazem na verzi aplikace není katalog", async () => {
    pages[URL_] = { data: shell("<main><p>Loading…</p></main>").replace(/WTR-LAB/g, "ReaderSite") };
    await expect(generic.fetchChapterList(URL_)).rejects.toThrow(UNRELIABLE_CATALOG);
    const meta = await generic.fetchMetadata(URL_);
    expect(meta.title).toBe(""); // název webu se jako název novely nepoužije
  });

  it("verze, aktualizace, přihlášení, patička a doporučení se za kapitoly nepovažují", async () => {
    pages[URL_] = {
      data: `<html><head><title>Sample Tale</title></head><body>
        <div class="menu"><a href="/chapter-1-of-something">Chapter 1 of Promo</a><a href="/login?step=2">Login 2</a></div>
        <main><h1>Sample Tale</h1>
          <a href="/release/v2.4.1">v2.4.1</a><a href="/news/2026-01-05">Update 2026-01-05</a><a href="/register/1">Register</a>
          <ul class="chapters">${Array.from({ length: 12 }, (_, i) => `<li><a href="/en/novel/7898/sample/chapter-${i + 1}">Chapter ${i + 1}: Sample</a></li>`).join("")}</ul>
          <div class="recommended"><a href="/en/novel/1/other/chapter-1">Chapter 1</a><a href="/en/novel/2/other/chapter-1">Chapter 1</a><a href="/en/novel/3/other/chapter-1">Chapter 1</a></div>
        </main><footer><a href="/app/v1.13.17">v1.13.17</a><a href="/terms/2">Terms 2</a></footer></body></html>`,
    };
    const list = await generic.fetchChapterList(URL_);
    expect(list).toHaveLength(12);
    expect(list.every((c) => /\/sample\/chapter-\d+$/.test(c.url))).toBe(true);
    expect(list.map((c) => c.orderIndex)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it("stránkovaný seznam neoznačí jako kompletní", async () => {
    const links = Array.from({ length: 12 }, (_, i) => `<li><a href="/en/novel/7898/sample/chapter-${i + 1}">Chapter ${i + 1}</a></li>`).join("");
    const page = (extra: string) => `<html><head><title>Sample Tale</title></head><body><main><h1>Sample Tale</h1><ul>${links}</ul>${extra}</main></body></html>`;
    pages[URL_] = { data: page(`<div class="pagination"><a href="${URL_}?page=2">2</a></div>`) };
    const paged = await generic.fetchCatalog(URL_);
    expect(paged.complete).toBe(false);
    expect(paged.warnings.join(" ")).toMatch(/více stránek/);
    pages[URL_] = { data: page("") };
    const single = await generic.fetchCatalog(URL_);
    expect(single.complete).toBe(true);
    expect(single.warnings.join(" ")).toMatch(/úplnost nelze ověřit/);
  });

  it("jediný odkaz s číslem nestačí; dva výslovně pojmenované ano", async () => {
    const page = (links: string) => `<html><head><title>Sample Tale</title></head><body><main><h1>Sample Tale</h1><p>${"Intro text. ".repeat(20)}</p>${links}</main></body></html>`;
    pages[URL_] = { data: page(`<a href="/en/novel/7898/sample/chapter-1">Chapter 1</a>`) };
    await expect(generic.fetchChapterList(URL_)).rejects.toThrow(UNRELIABLE_CATALOG);
    pages[URL_] = { data: page(`<a href="/en/novel/7898/sample/chapter-1">Chapter 1</a><a href="/en/novel/7898/sample/chapter-2">Chapter 2</a>`) };
    expect(await generic.fetchChapterList(URL_)).toHaveLength(2);
  });
});
