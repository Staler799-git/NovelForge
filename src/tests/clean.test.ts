/**
 * Čištění kapitol od reklam, navigace a doporučení.
 * Všechny texty jsou vymyšlené; struktura napodobuje stránku kapitoly.
 */
import { describe, it, expect, vi } from "vitest";
import { createSite, singleSeries, ORIGIN, SLUG, type SiteOptions } from "./helpers/wuxiaboxSite";

let site: ReturnType<typeof createSite>;
vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: { get: vi.fn((url: string, o?: any) => site.get(url, o)) },
}));

import { WuxiaBoxParser } from "@/services/parser/wuxiabox";
import { cleanChapterElement, stripBoilerplateXhtml, findBoilerplate } from "@/services/clean";
import { sanitizeToXhtml, htmlToText } from "@/services/content";
import { parseHtml } from "@/services/html";

const STORY = [
  "Kapitán Šťastný řekl: „Žluťoučký kůň úpěl ďábelské ódy.“ — 他说:“长生俱乐部。”",
  "“You'll also like the tea here,” Mirela said, pouring a second cup for the stranger who had walked in from the rain.",
  "He told her to tap the screen to use advanced tools hidden in the old terminal, and she laughed because the terminal had no screen at all.",
  "“Read the latest chapters of your own life first,” the old man muttered, and nobody at the long table knew what he meant by it.",
  "Next chapter of the ledger was missing. Previous owners had torn it out, and the report on the theft ran to forty pages of careful handwriting.",
];
const storyHtml = STORY.map((p) => `<p>${p}</p>`).join("\n") + `<p>${"A neutral filler sentence that keeps the chapter long enough. ".repeat(8)}</p>`;

function parserFor(opts: SiteOptions) {
  site = createSite(opts);
  const p = new WuxiaBoxParser();
  p.pageDelayMs = 0;
  return p;
}
const chapterUrl = (n: number) => `${ORIGIN}/novel/${SLUG}_${n}.html`;

describe("WuxiaBox – extrakce jen textu příběhu", () => {
  for (const where of ["outside", "inside"] as const) {
    it(`odstraní nápovědu, doporučení a propagaci (${where === "outside" ? "vedle" : "uvnitř"} kontejneru)`, async () => {
      const parser = parserFor({ entries: singleSeries(5), ads: where, chapterText: () => STORY.join("</p><p>") + "</p><p>" + "A neutral filler sentence. ".repeat(12) });
      const ch = await parser.fetchChapter(chapterUrl(2));
      const text = htmlToText(ch.html);
      expect(text).not.toMatch(/You'll Also Like/);
      expect(text).not.toMatch(/Tap the screen/);
      expect(text).not.toMatch(/keyboard keys/);
      expect(text).not.toMatch(/Other Sample Novel/);
      expect(text).not.toMatch(/wuxiabox/i);
      expect(text).not.toMatch(/ADVERT/);
      expect(findBoilerplate(ch.html)).toEqual([]);
      // příběh zůstal celý, včetně vět, které reklamu jen připomínají
      for (const p of STORY) expect(text).toContain(p.replace(/\s+/g, " "));
      expect(ch.html).not.toMatch(/<a\b|href=/);
    });
  }

  it("čistá kapitola projde beze změny textu", async () => {
    const parser = parserFor({ entries: singleSeries(3) });
    const ch = await parser.fetchChapter(chapterUrl(1));
    const again = stripBoilerplateXhtml(ch.html, { siteNames: ["wuxiabox.com"] });
    expect(again.removed).toEqual([]);
    expect(htmlToText(again.html)).toBe(htmlToText(ch.html));
  });
});

describe("cleanChapterElement – strukturální čištění", () => {
  const clean = (inner: string) => {
    const doc = parseHtml(`<html><body><div id="c">${inner}</div></body></html>`);
    const el = doc.getElementById("c")!.cloneNode(true) as Element;
    const report = cleanChapterElement(el, { siteNames: ["wuxiabox.com", "wuxiabox"] });
    return { text: htmlToText(sanitizeToXhtml(el.innerHTML)), report };
  };

  it("odstraní bloky rozhraní podle struktury (třídy, seznamy odkazů, navigace)", () => {
    const { text, report } = clean(`
      <div class="chapter-nav"><a href="/n/x_1.html">Prev</a><a href="/n/x.html">Index</a><a href="/n/x_3.html">Next</a></div>
      ${storyHtml}
      <div class="adsbygoogle">ADVERT</div>
      <ins class="ads">ADVERT</ins>
      <div class="related-novels"><h3>Recommended Novels</h3><ul><li><a href="/a.html">Alpha Sample</a></li><li><a href="/b.html">Beta Sample</a></li></ul></div>
      <ul><li><a href="/n/x_4.html">Chapter 4</a></li><li><a href="/n/x_5.html">Chapter 5</a></li><li><a href="/n/x_6.html">Chapter 6</a></li></ul>
      <p>Visit wuxiabox.com to read more novels.</p>`);
    expect(text).not.toMatch(/ADVERT|Recommended Novels|Alpha Sample|Chapter 5|\bPrev\b|\bIndex\b|wuxiabox/);
    for (const p of STORY) expect(text).toContain(p);
    expect(report.removed.length).toBeGreaterThan(0);
  });

  it("nesmaže odstavec příběhu jen proto, že obsahuje odkaz nebo slovo jako reklama", () => {
    const { text } = clean(`
      <p>The advertisement on the wall promised a <a href="/glossary.html">longevity elixir</a>, and the sponsor of the club smiled at the banner above the door.</p>
      <p class="recommend-letter">She carried a letter of recommendation, share and share alike, into the related office.</p>
      ${storyHtml}`);
    expect(text).toContain("The advertisement on the wall promised a longevity elixir");
    expect(text).toContain("sponsor of the club smiled at the banner");
    for (const p of STORY) expect(text).toContain(p);
  });
});

describe("stripBoilerplateXhtml – už uložené kapitoly (bez tříd a odkazů)", () => {
  const dirty =
    `<p>Tap the screen to use advanced tools</p><p>Tip: You can use left, right keyboard keys to browse between chapters.</p>` +
    storyHtml +
    `<p>Read the latest chapters at wuxiabox.com for free</p><h4>You'll Also Like</h4><ul><li>Other Sample Novel One</li><li>Other Sample Novel Two</li><li>Chapter 12 of Other Sample</li></ul>`;

  it("odstraní nápovědu čtečky, propagaci a koncový blok doporučení", () => {
    const res = stripBoilerplateXhtml(dirty, { siteNames: ["wuxiabox.com", "wuxiabox"] });
    const text = htmlToText(res.html);
    expect(text).not.toMatch(/Tap the screen|keyboard keys|You'll Also Like|Other Sample Novel|wuxiabox/);
    for (const p of STORY) expect(text).toContain(p);
    expect(res.removed.length).toBeGreaterThanOrEqual(3);
    expect(res.suspicious).toEqual([]);
  });

  it("je idempotentní a zachová Unicode i uvozovky", () => {
    const once = stripBoilerplateXhtml(dirty, { siteNames: ["wuxiabox.com"] });
    const twice = stripBoilerplateXhtml(once.html, { siteNames: ["wuxiabox.com"] });
    expect(twice.removed).toEqual([]);
    expect(twice.html).toBe(once.html);
    expect(once.html).toContain("„Žluťoučký kůň úpěl ďábelské ódy.“");
    expect(once.html).toContain("长生俱乐部");
  });

  it("řádky oddělené <br/> čistí jednotlivě, zbytek odstavce nechá", () => {
    const res = stripBoilerplateXhtml(`<p>Tap the screen to use advanced tools<br/>${STORY[1]}<br/>${STORY[2]}</p>${storyHtml}`);
    const text = htmlToText(res.html);
    expect(text).not.toMatch(/^Tap the screen to use advanced tools/);
    expect(text).toContain(STORY[1]);
    expect(text).toContain(STORY[2]);
  });

  it("nadpis „You'll Also Like“, za kterým pokračuje próza, nemaže – jen ho nahlásí", () => {
    const res = stripBoilerplateXhtml(`${storyHtml}<p>You'll Also Like</p>${storyHtml}${storyHtml}`);
    const text = htmlToText(res.html);
    expect(text.split(STORY[0]).length - 1).toBe(3); // všechny tři kopie příběhu zůstaly
  });

  it("zbytek reklamy uvnitř odstavce nahlásí jako podezřelý, text ale nezničí", () => {
    const glued = `<p>${STORY[4]} Tap the screen to use advanced tools You'll Also Like Other Sample Novel One</p>${storyHtml}`;
    const res = stripBoilerplateXhtml(glued);
    expect(htmlToText(res.html)).toContain(STORY[4]);
    expect(res.suspicious.length).toBeGreaterThan(0);
  });
});
