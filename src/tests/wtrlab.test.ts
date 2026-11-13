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

vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: {
    get: vi.fn(async (url: string) => {
      requests.push(url);
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
    if (!(url in rendered)) throw new Error("Nativní modul WebRenderer není k dispozici");
    return rendered[url];
  }),
}));

import { getParser, GenericNovelParser, WtrLabParser } from "@/services/parser/registry";
import { parseWtrUrl } from "@/services/parser/wtrlab";
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

describe("WTR-LAB – katalog", () => {
  it("úplný seznam z dat stránky => kompletní, seřazený, adresy chapter-N", async () => {
    const list = Array.from({ length: TOTAL }, (_, i) => ({ id: 9000 + i, order: TOTAL - i, title: `Sample Heading ${TOTAL - i}` })); // web je vrátí sestupně
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie, chapters: list } } }) };
    const cat = await getParser(CH1).fetchCatalog(CH1);
    expect(cat.chapters).toHaveLength(TOTAL);
    expect(cat.complete).toBe(true);
    expect(cat.declaredTotal).toBe(TOTAL);
    expect(cat.chapters[0]).toMatchObject({ title: "Sample Heading 1", url: CH1, orderIndex: 0 });
    expect(cat.chapters[TOTAL - 1].url).toBe(`${NOVEL}/chapter-${TOTAL}`);
    expect(cat.chapters.map((c) => c.orderIndex)).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
  });

  it("kratší seznam než uváděný počet => NENÍ kompletní", async () => {
    const list = Array.from({ length: 50 }, (_, i) => ({ order: i + 1, title: `Sample Heading ${i + 1}` }));
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie, chapters: list } } }) };
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(50);
    expect(cat.complete).toBe(false);
    expect(cat.warnings.join(" ")).toMatch(new RegExp(`uvádí ${TOTAL} kapitol.*obsahuje 50`));
  });

  it("jen počet kapitol => adresy odvozené z číslování, označené jako neověřené", async () => {
    pages[NOVEL] = { data: shell("", { props: { pageProps: { serie } } }) };
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters).toHaveLength(TOTAL);
    expect(cat.complete).toBe(false);
    expect(cat.warnings.join(" ")).toMatch(/odvozeny z číslování webu a nejsou jednotlivě ověřené/);
    expect(cat.chapters[2]).toMatchObject({ url: `${NOVEL}/chapter-3`, title: "Chapter 3" });
  });

  it("jen pár odkazů bez počtu => neúplný katalog s varováním", async () => {
    pages[NOVEL] = { data: shell(`<main><h1>Sample Longevity Club</h1><a href="/en/novel/7898/i-created-the-longevity-club/chapter-1">Sample Heading 1</a>
      <a href="/en/novel/7898/i-created-the-longevity-club/chapter-2">Sample Heading 2</a><a href="/en/novel/1234/other-novel/chapter-9">Other</a></main>`) };
    const cat = await getParser(NOVEL).fetchCatalog(NOVEL);
    expect(cat.chapters.map((c) => c.title)).toEqual(["Sample Heading 1", "Sample Heading 2"]);
    expect(cat.complete).toBe(false);
  });

  it("prázdná kostra webu => chyba, žádná falešná kapitola „v1.13.17“", async () => {
    pages[NOVEL] = { data: shell("") };
    await expect(getParser(NOVEL).fetchCatalog(NOVEL)).rejects.toThrow(/Katalog kapitol nebyl spolehlivě rozpoznán/);
  });
});

describe("WTR-LAB – text kapitol", () => {
  it("první tři kapitoly z dat stránky: správný název, celý text, platné XHTML", async () => {
    for (const n of [1, 2, 3]) pages[`${NOVEL}/chapter-${n}`] = { data: shell("", chapterData(n)) };
    for (const n of [1, 2, 3]) {
      const ch = await getParser(CH1).fetchChapter(`${NOVEL}/chapter-${n}`);
      expect(ch.title).toBe(`Sample Heading ${n}`);
      const text = htmlToText(ch.html);
      for (const i of [1, 2, 3, 4]) expect(text).toContain(para(n, i));
      expect(text).not.toMatch(/WTR-LAB|v1\.13\.17|Login|Privacy/);
      expect(XMLValidator.validate(chapterToXhtml(ch.title, ch.html, "Sample Longevity Club", "Wo Xing Yu", "en"))).toBe(true);
    }
  });

  it("text až po vykreslení: vezme jen tělo kapitoly, bez ovládání čtečky a doporučení", async () => {
    pages[CH1] = { data: shell("") };
    rendered[CH1] = shell(`<main><h1 class="chapter-title">Sample Heading 1</h1>
      <div class="chapter-tools"><button>A+</button><a href="${NOVEL}/chapter-2">Next</a></div>
      <div class="chapter-body">${[1, 2, 3, 4].map((i) => `<p>${para(1, i)}</p>`).join("")}<p>“Žluťoučký kůň,” řekl 我姓俞.</p></div>
      <section class="recommend"><h4>You'll Also Like</h4><a href="/en/novel/1/a">Other Sample One</a><a href="/en/novel/2/b">Other Sample Two</a></section></main>`);
    const ch = await getParser(CH1).fetchChapter(CH1);
    const text = htmlToText(ch.html);
    expect(ch.title).toBe("Sample Heading 1");
    expect(text).toContain(para(1, 4));
    expect(text).toContain("“Žluťoučký kůň,” řekl 我姓俞.");
    expect(text).not.toMatch(/Also Like|Other Sample|Next|A\+|v1\.13\.17/);
    expect(text.startsWith("Synthetic paragraph 1")).toBe(true);
  });

  it("když web text nevydá (přihlášení, zámek), řekne to a nic si nevymýšlí", async () => {
    pages[CH1] = { data: shell("<main><h1>Sample Heading 1</h1><p>Please log in to continue reading.</p></main>") };
    await expect(getParser(CH1).fetchChapter(CH1)).rejects.toThrow(/nepodařilo načíst|přihlášení/);
  });

  it("adresa novely není kapitola", async () => {
    await expect(getParser(NOVEL).fetchChapter(NOVEL)).rejects.toThrow(/neodkazuje na kapitolu/);
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
