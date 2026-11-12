import { parseHtml } from "./html";
/**
 * Práce s obsahem kapitol: převod HTML -> well-formed XHTML, normalizace textu,
 * otisky obsahu, ověření, že stránka opravdu obsahuje text kapitoly.
 */
import { ContentError, detectBlockPage } from "./parser/base";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeXml(s: string): string {
  // Znaky zakázané v XML 1.0 (řídicí znaky) by rozbily celý EPUB.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Tagy, které se do EPUB přenášejí (bez atributů). */
const KEEP = new Set([
  "p", "br", "hr", "em", "strong", "i", "b", "u", "s", "sup", "sub", "blockquote",
  "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "table", "thead",
  "tbody", "tr", "td", "th", "span", "div",
]);
/** Tagy, které se zahodí i s obsahem. */
const DROP = new Set([
  "script", "style", "noscript", "iframe", "object", "embed", "form", "button", "input",
  "select", "textarea", "nav", "header", "footer", "aside", "svg", "canvas", "video",
  "audio", "img", "picture", "source", "ins", "link", "meta", "head", "title",
]);
const VOID = new Set(["br", "hr"]);
const BLOCK = new Set(["p", "div", "blockquote", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "table", "tr", "hr"]);

function serialize(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(escapeXml(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== 1) return; // komentáře, PI…
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return;
  // h1 patří názvu kapitoly, který EPUB doplňuje sám
  const name = tag === "h1" ? "h2" : tag;
  if (!KEEP.has(name)) {
    for (const child of Array.from(el.childNodes)) serialize(child, out); // rozbalit (a, font, center…)
    return;
  }
  if (VOID.has(name)) {
    out.push(`<${name}/>`);
    return;
  }
  const inner: string[] = [];
  for (const child of Array.from(el.childNodes)) serialize(child, inner);
  const body = inner.join("");
  if (!body.trim() && name !== "td" && name !== "th") return; // prázdné obaly
  out.push(`<${name}>${body}</${name}>`);
}

/**
 * Převede libovolné HTML na WELL-FORMED XHTML fragment.
 *
 * `innerHTML` vrací HTML serializaci (`<br>`, `&nbsp;`, neuzavřené tagy), která
 * není platné XML – přísné čtečky (Apple Books) pak kapitolu nebo celou knihu
 * odmítnou. Tady se strom projde ručně a vypíše jako XML: bez atributů, se
 * samouzavíracími `<br/>`, s číselnými entitami a bez skriptů/reklam.
 */
export function sanitizeToXhtml(html: string): string {
  const doc = parseHtml(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const out: string[] = [];
  const pending: string[] = [];
  const flush = () => {
    const text = pending.join("");
    pending.length = 0;
    if (text.trim()) out.push(`<p>${text.trim()}</p>`);
  };
  // Text a inline prvky přímo v kořeni zabalíme do <p> (body v XHTML nesmí mít holý text).
  for (const child of Array.from(doc.body.childNodes)) {
    const isBlock = child.nodeType === 1 && BLOCK.has((child as Element).tagName.toLowerCase());
    if (isBlock) {
      flush();
      serialize(child, out);
    } else if (child.nodeType === 1 && (child as Element).tagName.toLowerCase() === "br") {
      flush();
    } else {
      serialize(child, pending);
    }
  }
  flush();
  return out.join("\n");
}

/** Čistý text z HTML (bez tagů), s normalizovanými mezerami. */
export function htmlToText(html: string): string {
  // Hranice bloků a <br> musí oddělit slova ("a<br>b" není "ab").
  const spaced = html.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/td|\/blockquote|hr)\b[^>]*>/gi, "$& ");
  const doc = parseHtml(`<!DOCTYPE html><html><body>${spaced}</body></html>`);
  for (const el of Array.from(doc.body.querySelectorAll("script, style, noscript"))) el.remove();
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Normalizace pro porovnávání obsahu: malá písmena, bez interpunkce a mezer navíc. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201C\u201D'"`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** 64bitový otisk (dvě nezávislé 32bitové FNV-1a) jako 16 hex znaků. */
export function hash64(s: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Otisk normalizovaného textu kapitoly – stejný text => stejný otisk, i když se liší HTML. */
export function contentHash(html: string): string {
  return hash64(normalizeText(htmlToText(html)));
}

/** Podobnost dvou textů 0–1 (Jaccard nad trojicemi slov). */
export function textSimilarity(a: string, b: string): number {
  const shingles = (t: string) => {
    const w = normalizeText(t).split(" ").filter(Boolean);
    const set = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) set.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return set;
  };
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let common = 0;
  for (const s of sa) if (sb.has(s)) common++;
  return common / (sa.size + sb.size - common);
}

export const MIN_CHAPTER_TEXT = 120;

/**
 * Ověří, že HTML opravdu obsahuje text kapitoly. Vyhodí ContentError s
 * konkrétním důvodem – prázdná stránka, blokace ani CAPTCHA se tak nikdy
 * neuloží jako "stažená kapitola".
 */
export function assertChapterContent(html: string): { text: string; words: number } {
  const text = htmlToText(html);
  const blocked = detectBlockPage(html, text.length);
  if (blocked) throw new ContentError(blocked);
  if (text.length === 0) throw new ContentError("Stránka neobsahuje žádný text kapitoly");
  if (text.length < MIN_CHAPTER_TEXT) {
    throw new ContentError(`Text kapitoly je podezřele krátký (${text.length} znaků) – pravděpodobně chybová stránka`);
  }
  return { text, words: text.split(" ").length };
}
