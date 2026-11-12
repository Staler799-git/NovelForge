import { describe, it, expect } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { sanitizeToXhtml, contentHash, textSimilarity, assertChapterContent, hash64, htmlToText } from "@/services/content";
import { findCoverUrl, detectLanguage, normalizeLanguage, detectBlockPage } from "@/services/parser/base";

const wellFormed = (fragment: string) => XMLValidator.validate(`<root>${fragment}</root>`);
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("sanitizeToXhtml", () => {
  it("z HTML udělá well-formed XHTML (br, entity, neuzavřené tagy)", () => {
    const html = `<p>One&nbsp;two<br>three &amp; four<p>Unclosed <b>bold <i>both</b> tail
      <img src=x.png><a href="/x" onclick="evil()">link text</a> &copy; 5 < 6`;
    const out = sanitizeToXhtml(html);
    expect(wellFormed(out)).toBe(true);
    expect(out).toContain("<br/>");
    expect(out).not.toMatch(/&nbsp;|&copy;|<img|onclick|href/);
    expect(out).toContain("link text");
    expect(out).toContain("5 &lt; 6");
  });

  it("zahodí skripty, styly, formuláře a iframy i s obsahem", () => {
    const out = sanitizeToXhtml(`<p>Keep</p><script>var hidden = "<p>x</p>";</script><style>p{}</style><iframe src="a"></iframe><form><input value="q"><button>Go</button></form>`);
    expect(out).toBe("<p>Keep</p>");
  });

  it("holý text v kořeni zabalí do odstavců", () => {
    const out = sanitizeToXhtml("First line<br><br>Second line");
    expect(out).toBe("<p>First line</p>\n<p>Second line</p>");
    expect(wellFormed(out)).toBe(true);
  });

  it("je idempotentní", () => {
    const once = sanitizeToXhtml("<div><p>A &amp; B</p><br><h1>Title</h1></div>");
    expect(sanitizeToXhtml(once)).toBe(once);
  });

  it("odstraní znaky zakázané v XML", () => {
    const out = sanitizeToXhtml("<p>a\u0000b\u000Bc</p>");
    expect(out).toBe("<p>abc</p>");
  });
});

describe("otisk a podobnost obsahu", () => {
  it("stejný text v jiném HTML má stejný otisk", () => {
    const a = "<p>Hello,   World!</p><p>Second “line”.</p>";
    const b = "<div>hello world<br/>SECOND line</div>";
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toHaveLength(16);
  });

  it("jiný text má jiný otisk", () => {
    expect(contentHash("<p>alpha beta gamma</p>")).not.toBe(contentHash("<p>alpha beta delta</p>"));
    expect(hash64("a")).not.toBe(hash64("b"));
  });

  it("podobnost rozliší shodný, příbuzný a cizí text", () => {
    const base = "the quick brown fox jumps over the lazy dog near the quiet river bank today";
    expect(textSimilarity(base, base)).toBe(1);
    expect(textSimilarity(base, base + " and then rests")).toBeGreaterThan(0.7);
    expect(textSimilarity(base, "completely unrelated words about copper lanterns and granite harbors far away")).toBeLessThan(0.1);
  });
});

describe("assertChapterContent", () => {
  const long = "<p>" + "Ordinary sentence of a chapter body. ".repeat(10) + "</p>";
  it("přijme skutečný text", () => {
    expect(assertChapterContent(long).words).toBeGreaterThan(30);
  });
  it("odmítne prázdný obsah, krátký obsah a CAPTCHA", () => {
    expect(() => assertChapterContent("<p> </p>")).toThrow(/žádný text/);
    expect(() => assertChapterContent("<p>Error.</p>")).toThrow(/podezřele krátký/);
    expect(() => assertChapterContent("<div class='g-recaptcha'></div><p>Please verify you are human to continue reading this page right now, thank you very much for patience.</p>")).toThrow(/CAPTCHA/);
  });
  it("dlouhou kapitolu se slovem captcha neodmítne", () => {
    const text = "<p>" + "He solved the captcha puzzle and kept walking through the hall. ".repeat(40) + "</p>";
    expect(htmlToText(text).length).toBeGreaterThan(1500);
    expect(() => assertChapterContent(text)).not.toThrow();
    expect(detectBlockPage(text, 3000)).toBeNull();
  });
});

describe("findCoverUrl", () => {
  const base = "https://site.example/novel/book.html";
  it("Open Graph má přednost a relativní adresa se převede na absolutní", () => {
    expect(findCoverUrl(doc(`<head><meta property="og:image" content="/img/c.jpg"></head><body><div class="cover"><img src="/other.jpg"></div></body>`), base)).toBe("https://site.example/img/c.jpg");
  });
  it("použije twitter:image, link image_src i JSON-LD", () => {
    expect(findCoverUrl(doc(`<head><meta name="twitter:image" content="t.png"></head>`), base)).toBe("https://site.example/novel/t.png");
    expect(findCoverUrl(doc(`<head><link rel="image_src" href="//cdn.x/y.jpg"></head>`), base)).toBe("https://cdn.x/y.jpg");
    expect(findCoverUrl(doc(`<head><script type="application/ld+json">{"@type":"Book","image":{"url":"https://a.b/ld.jpg"}}</script></head>`), base)).toBe("https://a.b/ld.jpg");
  });
  it("u lazy-load obrázku vezme data-src, ne zástupný src", () => {
    expect(findCoverUrl(doc(`<div class="cover"><img src="/static/placeholder.png" data-src="../covers/real.jpg"></div>`), base)).toBe("https://site.example/covers/real.jpg");
    expect(findCoverUrl(doc(`<div class="book"><img src="data:image/gif;base64,R0lGOD" srcset="/a-300.jpg 300w, /a-600.jpg 600w"></div>`), base)).toBe("https://site.example/a-300.jpg");
  });
  it("bez obálky vrátí undefined", () => {
    expect(findCoverUrl(doc(`<div class="cover"><img src="/static/loading.gif"></div>`), base)).toBeUndefined();
  });
});

describe("jazyk", () => {
  it("normalizuje kódy a odmítne nesmysly", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("en_us")).toBe("en-US");
    expect(normalizeLanguage("zh-hans-cn")).toBe("zh-Hans-CN");
    expect(normalizeLanguage("čeština", "en")).toBe("en");
    expect(normalizeLanguage("", "cs")).toBe("cs");
  });
  it("bere <html lang>, jinak odhaduje z textu", () => {
    expect(detectLanguage(doc(`<html lang="en-GB"><body></body></html>`))).toBe("en-GB");
    expect(detectLanguage(doc(`<html><body></body></html>`), "Příběh o muži, který založil klub dlouhověkosti a žil velmi dlouho šťastně.")).toBe("cs");
    expect(detectLanguage(doc(`<html><body></body></html>`), "A story about a man who founded a club and lived for a very long time.")).toBe("en");
  });
});
