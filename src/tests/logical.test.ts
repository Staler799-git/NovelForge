/**
 * Logická identita kapitol: …_001.html a …_1.html jsou dvě verze kapitoly 1.
 * Katalog napodobuje skutečný stav webu: 3 138 kapitol, z toho prvních 99
 * ve dvou verzích = 3 237 adres na 33 stránkách. (Simulace – živý web není
 * z vývojového prostředí dostupný.)
 */
import { describe, it, expect, vi } from "vitest";
import { createSite, mixedCatalog, singleSeries, NOVEL_URL, ORIGIN, SLUG, type SiteOptions } from "./helpers/wuxiaboxSite";

let site: ReturnType<typeof createSite>;
vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: { get: vi.fn((url: string, o?: any) => site.get(url, o)) },
}));

import { WuxiaBoxParser } from "@/services/parser/wuxiabox";
import { analyzeLogical, selectVariant, urlChapterNumber, verifyAlternatives } from "@/services/catalog";

function parserFor(opts: SiteOptions) {
  site = createSite(opts);
  const p = new WuxiaBoxParser();
  p.pageDelayMs = 0;
  return p;
}
const file = (url: string) => url.split("/").pop();

describe("číslo kapitoly z adresy", () => {
  it("normalizuje 001 a 1 na stejné číslo a pamatuje si úvodní nuly", () => {
    expect(urlChapterNumber(`${ORIGIN}/novel/${SLUG}_001.html`)).toEqual({ num: 1, raw: "001", padded: true });
    expect(urlChapterNumber(`${ORIGIN}/novel/${SLUG}_1.html`)).toEqual({ num: 1, raw: "1", padded: false });
    expect(urlChapterNumber(`${ORIGIN}/novel/${SLUG}_100.html`)).toMatchObject({ num: 100, padded: false });
    expect(urlChapterNumber(`${ORIGIN}/novel/${SLUG}_3138.html`).num).toBe(3138);
    expect(urlChapterNumber("https://wtr-lab.com/en/novel/7898/sample/chapter-12").num).toBe(12);
    expect(urlChapterNumber(`${ORIGIN}/novel/${SLUG}.html`).num).toBeNull();
  });
});

describe("WuxiaBox – 3 237 adres, 3 138 kapitol", () => {
  it("načte všech 33 stránek katalogu a nic nezahodí", async () => {
    const parser = parserFor({ entries: mixedCatalog(3138, 99), declaredTotal: 3138 });
    const result = await parser.fetchCatalog(NOVEL_URL);
    expect(site.pageCount).toBe(33);
    expect(result.pagesLoaded).toBe(33);
    expect(result.chapters).toHaveLength(3237);
    expect(new Set(result.chapters.map((c) => c.url)).size).toBe(3237);
    expect(result.declaredTotal).toBe(3138);
  });

  it("rozpozná 3 138 logických kapitol a rozsah alternativ 1–99 (ověřený z dat, ne zadaný)", async () => {
    const parser = parserFor({ entries: mixedCatalog(3138, 99), declaredTotal: 3138 });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const a = analyzeLogical(chapters);
    expect(a.urlCount).toBe(3237);
    expect(a.uniqueCount).toBe(3138);
    expect(a.alternatives).toBe(99);
    expect(a.altRange).toEqual({ first: 1, last: 99 });
    expect(a.uncertain).toEqual([]);
    expect(a.variants.map((v) => v.id)).toEqual(["plain", "padded"]);
    expect(a.variants[1].samples[0]).toContain(`${SLUG}_001.html`);
    expect(a.orderByNumber).toBe(true);

    // jiný rozsah alternativ se pozná stejně dobře
    const b = analyzeLogical((await parserFor({ entries: mixedCatalog(500, 37) }).fetchCatalog(NOVEL_URL)).chapters);
    expect(b).toMatchObject({ urlCount: 537, uniqueCount: 500, alternatives: 37, altRange: { first: 1, last: 37 } });
  });

  it("hlavní řada: 3 138 kapitol souvisle 1…3138, alternativy jen vyřazené (adresy zůstávají)", async () => {
    const parser = parserFor({ entries: mixedCatalog(3138, 99) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const sel = selectVariant(chapters, "plain");
    expect(sel.chapters).toHaveLength(3237); // žádná adresa se neztratila
    expect(sel.included).toBe(3138);
    expect(sel.excluded).toBe(99);
    expect(sel.mixed).toBe(false);
    expect(sel.warnings).toEqual([]);
    const kept = sel.chapters.filter((c) => !c.excluded);
    expect(kept.map((c) => c.num)).toEqual(Array.from({ length: 3138 }, (_, i) => i + 1));
    expect(kept.every((c) => !/_0\d+\.html$/.test(c.url))).toBe(true);
    expect(sel.chapters.filter((c) => c.excluded).every((c) => /_0\d\d\.html$/.test(c.url))).toBe(true);
    // pořadí je společné a souvislé přes všechny adresy
    expect(sel.chapters.map((c) => c.orderIndex)).toEqual(Array.from({ length: 3237 }, (_, i) => i));
  });

  it("alternativní řada: 001–099, pak hlavní od 100 – s upozorněním na změnu překladu", async () => {
    const parser = parserFor({ entries: mixedCatalog(3138, 99) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const sel = selectVariant(chapters, "padded");
    const kept = sel.chapters.filter((c) => !c.excluded);
    expect(kept).toHaveLength(3138);
    expect(kept.map((c) => c.num)).toEqual(Array.from({ length: 3138 }, (_, i) => i + 1));
    expect(file(kept[0].url)).toBe(`${SLUG}_001.html`);
    expect(file(kept[98].url)).toBe(`${SLUG}_099.html`);
    expect(file(kept[99].url)).toBe(`${SLUG}_100.html`);
    expect(sel.mixed).toBe(true);
    expect(sel.warnings.join(" ")).toMatch(/jen kapitoly 1–99.*za kapitolou 99 změní překlad/);
  });

  it("obě verze: nic se nevyřadí, ale uživatel dostane varování o opakování", async () => {
    const parser = parserFor({ entries: mixedCatalog(300, 99) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const sel = selectVariant(chapters, "all");
    expect(sel.excluded).toBe(0);
    expect(sel.warnings.join(" ")).toMatch(/1–99 budou v knize DVAKRÁT/);
    // obě verze téže kapitoly jsou vedle sebe, alternativní první
    expect(sel.chapters.slice(0, 4).map((c) => file(c.url))).toEqual([`${SLUG}_001.html`, `${SLUG}_1.html`, `${SLUG}_002.html`, `${SLUG}_2.html`]);
  });

  it("řadí podle čísla i když web vypíše alternativní řadu v bloku před hlavní", () => {
    const urls = [
      ...Array.from({ length: 99 }, (_, i) => `${ORIGIN}/novel/${SLUG}_${String(i + 1).padStart(3, "0")}.html`),
      ...Array.from({ length: 400 }, (_, i) => `${ORIGIN}/novel/${SLUG}_${i + 1}.html`),
    ].map((url) => ({ url, title: "Chapter" }));
    const sel = selectVariant(urls, "plain");
    expect(sel.included).toBe(400);
    expect(sel.chapters.filter((c) => !c.excluded).map((c) => c.num)).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
  });

  it("katalog bez alternativ zůstane beze změny", async () => {
    const parser = parserFor({ entries: singleSeries(250) });
    const { chapters } = await parser.fetchCatalog(NOVEL_URL);
    const a = analyzeLogical(chapters);
    expect(a).toMatchObject({ urlCount: 250, uniqueCount: 250, alternatives: 0, altRange: null, variants: [] });
    const sel = selectVariant(chapters, "plain");
    expect(sel.excluded).toBe(0);
    expect(sel.chapters.map((c) => c.url)).toEqual(chapters.map((c) => c.url));
  });

  it("stejné číslo u adres, které nejde rozlišit, označí jako nejisté a nic nevyřadí", () => {
    const list = [
      { url: "https://example.org/book/a/chapter-1", title: "Chapter 1" },
      { url: "https://example.org/book/b/chapter-1", title: "Chapter 1 (v2)" },
      { url: "https://example.org/book/a/chapter-2", title: "Chapter 2" },
      { url: "https://example.org/book/a/chapter-3", title: "Chapter 3" },
    ];
    const a = analyzeLogical(list);
    expect(a.alternatives).toBe(0);
    expect(a.uncertain).toHaveLength(1);
    expect(a.uncertain[0]).toMatchObject({ num: 1, urls: [list[0].url, list[1].url] });
    const sel = selectVariant(list, "plain");
    expect(sel.excluded).toBe(0);
    expect(sel.warnings.join(" ")).toMatch(/nejde rozlišit.*zkontrolujte je ručně/);
  });

  it("stejný název sám o sobě duplicitu neznamená", () => {
    const list = Array.from({ length: 6 }, (_, i) => ({ url: `https://example.org/n/x_${i + 1}.html`, title: "Untitled" }));
    expect(analyzeLogical(list)).toMatchObject({ uniqueCount: 6, alternatives: 0, uncertain: [] });
  });
});

describe("ověření alternativních verzí na vzorku", () => {
  const names = (n: number) => `Captain Mirela met Doctor Ostrander at Harbor Velden in the year 18${40 + (n % 50)}. `;
  const proseA = (n: number) => names(n) + `Then Mirela counted ${200 + n} lanterns while Ostrander waited by the gate of Velden. `.repeat(4);
  const proseB = (n: number) => `In 18${40 + (n % 50)}, at the port called Velden, a physician named Ostrander was greeted by Mirela. ` + `Ostrander stood near the Velden entrance as Mirela tallied ${200 + n} lamps one by one. `.repeat(4);
  const mk = (text: (padded: boolean, n: number) => string) => {
    const entries = mixedCatalog(140, 99);
    const parser = parserFor({ entries, chapterText: () => "unused" });
    return {
      chapters: entries.map((e) => ({ url: `${ORIGIN}/novel/${SLUG}_${e.suffix ?? e.seq}.html`, title: e.title })),
      fetch: async (url: string) => {
        const u = urlChapterNumber(url);
        void parser;
        return { html: `<p>${text(u.padded, u.num!)}</p>` };
      },
    };
  };

  it("shodný text => duplicita", async () => {
    const { chapters, fetch } = mk((_p, n) => proseA(n));
    const r = await verifyAlternatives(chapters, fetch);
    expect(r.verdict).toBe("duplicate");
    expect(r.pairs.map((p) => p.number)).toEqual([1, 50, 99]);
  });

  it("jiné znění se stejnými jmény a čísly => pravděpodobně alternativní překlad", async () => {
    const { chapters, fetch } = mk((padded, n) => (padded ? proseB(n) : proseA(n)));
    const r = await verifyAlternatives(chapters, fetch);
    expect(r.verdict).toBe("translation");
    expect(r.pairs.every((p) => !p.identical && p.similarity < 0.5 && p.affinity >= 0.5)).toBe(true);
    expect(r.message).toMatch(/pravděpodobně jde o dva překlady/);
  });

  it("nesouvisející texty => nejisté, rozhodnutí je na uživateli", async () => {
    const other = (n: number) => `Weaver Tolland sold ${n + 700} bolts of cloth to Baroness Quill in Marrow Dell. `.repeat(5);
    const { chapters, fetch } = mk((padded, n) => (padded ? other(n) : proseA(n)));
    const r = await verifyAlternatives(chapters, fetch);
    expect(r.verdict).toBe("uncertain");
    expect(r.message).toMatch(/Rozhodněte ručně/);
  });

  it("pozná, když číslování řad na sebe nesedí (alternativní 99 odpovídá hlavní 100)", async () => {
    // jména jedinečná pro každou kapitolu (jen písmena)
    const w = (n: number) => String(n).split("").map((d) => "abcdefghij"[Number(d)]).join("");
    const tagged = (n: number) =>
      `The warden Ysolde${w(n)} guarded the tower of Bryn${w(n)} beside the lake called Corvane${w(n)}. `.repeat(6) + `Later Ysolde${w(n)} left Bryn${w(n)} for Corvane${w(n)} again. `;
    const { chapters, fetch } = mk((padded, n) => tagged(padded ? n + 1 : n));
    const r = await verifyAlternatives(chapters, fetch);
    expect(r.aligned).toBe(false);
    expect(r.verdict).toBe("uncertain");
    expect(r.message).toMatch(/na sebe nesedí/);
  });
});
