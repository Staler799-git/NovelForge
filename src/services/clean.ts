/**
 * Čištění textu kapitoly od reklam, navigace a doporučení.
 *
 * Dvě úrovně:
 *  1) `cleanChapterElement` – STRUKTURÁLNÍ čištění nad původním DOM stránky
 *     (značky, třídy/id, hustota odkazů). Používají ho parsery při stahování.
 *  2) `stripBoilerplateXhtml` – čištění už uloženého XHTML (bez tříd a odkazů).
 *     Odstraňuje jen CELÉ samostatné bloky/řádky, které přesně odpovídají
 *     známým prvkům rozhraní, a koncový blok doporučení za nadpisem typu
 *     "You'll Also Like". Běžný odstavec, který takové slovo jen obsahuje,
 *     zůstává.
 *
 * Nic se neodstraňuje plošně podle výskytu řetězce uvnitř textu.
 */
import { parseHtml } from "./html";
import { escapeXml } from "./content";

/** Značky, které text příběhu nikdy nenesou. */
const DROP_TAGS = "script,style,noscript,iframe,nav,header,footer,aside,form,button,input,select,textarea,ins,svg,canvas,video,audio";

/** Slova v class/id (celé tokeny, ne podřetězce – "shadow" tedy neobsahuje "ad"). */
const UI_TOKENS = new Set([
  "ad", "ads", "adsbygoogle", "advert", "advertisement", "advertising", "sponsor", "sponsored", "promo", "promotion",
  "recommend", "recommends", "recommended", "recommendation", "recommendations", "related", "similar", "alsolike",
  "share", "sharing", "social", "comment", "comments", "disqus", "nav", "navigation", "navbar", "pagination", "pager",
  "breadcrumb", "breadcrumbs", "guide", "tips", "tip", "report", "toolbar", "tools", "footer", "header", "sidebar",
  "popup", "modal", "banner", "subscribe", "newsletter", "rating", "vote", "bookmark", "chapternav", "actions",
]);

function norm(s: string): string {
  return s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/\s+/g, " ").trim();
}

/** Nadpis, za kterým následuje blok doporučení – vše za ním už není kapitola. */
const TAIL_HEADINGS: RegExp[] = [
  /^you'?ll also like:?$/i,
  /^you (may|might) also like:?$/i,
  /^recommended( novels?| reads?| for you)?:?$/i,
  /^related (novels?|posts?|books?|stories):?$/i,
  /^more (novels?|books?) (like this|from .{2,40}):?$/i,
  /^(popular|hot|new|latest) (novels?|books?|releases?):?$/i,
];

/** Samostatný řádek rozhraní (musí odpovídat CELÝ blok/řádek). */
const NOTICE_LINES: RegExp[] = [
  /^tap the screen to use advanced tools\.?( tip:.{0,160})?$/i,
  /^tip: you can use (the )?left,? (and )?right,?.{0,120}keys?.{0,80}$/i,
  /^(« |< |← )?(prev(ious)?|next)( chapter)?( »| >| →)?$/i,
  /^(table of contents|chapter list|back to (index|novel|contents)|index)$/i,
  /^report( chapter| error| this chapter)?$/i,
  /^(add to (library|bookshelf|bookmarks?)|bookmark( this (chapter|page))?)$/i,
  /^(chapter )?comments?( \(\d+\))?$/i,
  /^(share|share this( chapter)?|log ?in|sign ?(in|up)|register)$/i,
  /^(a\+|a-|font size|night mode|dark mode|settings)$/i,
  /^(please )?(read|visit|find|follow)\b.{0,90}\b(latest|newest|more|updated|free|best)\b.{0,60}\b(chapters?|novels?|updates?)\b.{0,80}$/i,
  /^(the )?(source|content) of this (chapter|content|novel) is .{2,60}$/i,
  /^this chapter is (updated|upload(ed)?) (by|first at|at) .{2,60}$/i,
];

export interface CleanOptions {
  /** Názvy webu (např. "wuxiabox") – krátký samostatný řádek, který web jmenuje, je propagace. */
  siteNames?: string[];
}

function isNoticeLine(text: string, opts?: CleanOptions): boolean {
  const t = norm(text);
  if (!t || t.length > 220) return false;
  if (NOTICE_LINES.some((re) => re.test(t))) return true;
  if (t.length <= 160 && opts?.siteNames?.length) {
    const low = t.toLowerCase();
    for (const name of opts.siteNames) {
      const n = name.toLowerCase().replace(/^www\./, "");
      if (n.length < 4) continue;
      const bare = n.replace(/\.[a-z]{2,6}$/, "");
      // jen když řádek zmiňuje web jako web (doména, nebo název + sloveso výzvy)
      if (low.includes(n) && /\.[a-z]{2,6}\b/.test(n)) return true;
      if (low.includes(bare) && /\b(read|visit|website|site|app|download|chapters?|novels?|update[sd]?)\b/.test(low)) return true;
    }
  }
  return false;
}

function isTailHeading(text: string): boolean {
  const t = norm(text);
  return t.length > 0 && t.length <= 60 && TAIL_HEADINGS.some((re) => re.test(t));
}

function textOf(n: Node | null | undefined): string {
  return norm(n?.textContent ?? "");
}

function hasUiToken(el: Element): boolean {
  const raw = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  if (!raw.trim()) return false;
  const tokens = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((t) => UI_TOKENS.has(t));
}

export interface CleanReport {
  /** Krátké popisy toho, co bylo odstraněno. */
  removed: string[];
}

/**
 * Strukturální čištění kontejneru kapitoly (pracuje přímo nad předaným prvkem –
 * předávejte klon). Zachovává všechny odstavce, které nejsou rozhraním webu.
 */
export function cleanChapterElement(root: Element, opts?: CleanOptions): CleanReport {
  const removed: string[] = [];
  const total = Math.max(1, textOf(root).length);
  const drop = (el: Element, why: string) => {
    const t = textOf(el);
    if (t) removed.push(`${why}: ${t.slice(0, 60)}`);
    el.remove();
  };

  for (const el of Array.from(root.querySelectorAll(DROP_TAGS))) el.remove();

  // 1) prvky rozhraní podle class/id – nikdy ne prvek, který nese většinu textu
  for (const el of Array.from(root.querySelectorAll("[class],[id]"))) {
    if (!root.contains(el)) continue; // (klon není připojený k dokumentu – isConnected nelze použít)
    if (!hasUiToken(el)) continue;
    const len = textOf(el).length;
    if (len > total * 0.5) continue;
    // Odstavec souvislé prózy bez odkazů zůstane, i když má nešťastně pojmenovanou třídu.
    if (el.tagName.toLowerCase() === "p" && len >= 80 && !el.querySelector("a,img,button") && !isNoticeLine(textOf(el), opts)) continue;
    drop(el, "prvek rozhraní");
  }

  // 2) bloky tvořené převážně odkazy (seznamy doporučených novel, navigace)
  for (const el of Array.from(root.querySelectorAll("ul,ol,div,section,p,table,li"))) {
    if (!root.contains(el)) continue;
    const links = Array.from(el.querySelectorAll("a[href]"));
    if (links.length === 0) continue;
    const len = textOf(el).length;
    if (len === 0 || len > total * 0.5) continue;
    const linkLen = links.reduce((s, a) => s + textOf(a).length, 0);
    if (linkLen >= len * 0.6 && (links.length >= 2 || len <= 120)) drop(el, "blok odkazů");
  }

  // 3) nadpis doporučení => on a vše za ním v pořadí dokumentu
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el) || el.children.length > 2) continue;
    if (!isTailHeading(textOf(el))) continue;
    const before = precedingTextLength(root, el);
    if (before < 200) continue; // nadpis hned na začátku není konec kapitoly
    // Za nadpisem smí zbývat jen menší část stránky (seznam novel), ne další próza.
    const after = Math.max(0, textOf(root).length - before - textOf(el).length);
    if (after > total * 0.4) continue;
    removed.push(`doporučení za nadpisem: ${textOf(el)}`);
    removeFollowing(root, el);
    el.remove();
    break;
  }

  // 4) samostatné řádky rozhraní (celý blok)
  for (const el of Array.from(root.querySelectorAll("p,div,span,li,h1,h2,h3,h4,h5,h6,a,strong,em,b,i,center"))) {
    if (!root.contains(el) || el.children.length > 3) continue;
    if (isNoticeLine(textOf(el), opts)) drop(el, "řádek rozhraní");
  }
  return { removed };
}

function precedingTextLength(root: Element, el: Element): number {
  let len = 0;
  let node: Node | null = el;
  while (node && node !== root) {
    let prev = node.previousSibling;
    while (prev) {
      len += (prev.textContent ?? "").length;
      prev = prev.previousSibling;
    }
    node = node.parentNode;
  }
  return len;
}

function removeFollowing(root: Element, el: Element): void {
  let node: Node | null = el;
  while (node && node !== root) {
    let next = node.nextSibling;
    while (next) {
      const n = next;
      next = next.nextSibling;
      n.parentNode?.removeChild(n);
    }
    node = node.parentNode;
  }
}

export interface StripResult {
  html: string;
  removed: string[];
  /** Zbylé podezřelé pasáže, které se nepodařilo bezpečně odstranit (k ruční kontrole). */
  suspicious: string[];
}

// Záměrně rozlišuje velikost písmen: nadpis webu je „You'll Also Like“, kdežto
// věta příběhu „you'll also like the tea“ podezřelá není.
const RESIDUAL: RegExp[] = [/You['’]?ll Also Like/, /Tap the screen to use advanced tools/, /[Uu]se (the )?left,? (and )?right,? .{0,30}keys? to browse/];

/** Najde zbytky reklam/navigace uvnitř textu (jen hlásí, nic nemění). */
export function findBoilerplate(xhtml: string): string[] {
  const text = norm(parseHtml(`<body>${xhtml.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "$& ")}</body>`).body.textContent ?? "");
  const out: string[] = [];
  for (const re of RESIDUAL) {
    const m = text.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

/**
 * Vyčistí už uložené XHTML kapitoly (bez tříd a odkazů).
 * Bezpečné opakovat – na čistém textu nic nezmění.
 */
export function stripBoilerplateXhtml(xhtml: string, opts?: CleanOptions): StripResult {
  const doc = parseHtml(`<!DOCTYPE html><html><body>${xhtml}</body></html>`);
  const body = doc.body;
  const removed: string[] = [];
  const blocks = Array.from(body.children);

  // 1) koncový blok doporučení
  const total = textOf(body).length;
  let seen = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const t = textOf(b);
    const heading = isTailHeading(t) ? b : Array.from(b.querySelectorAll("*")).find((c) => c.children.length === 0 && isTailHeading(textOf(c)));
    if (heading && seen >= 200) {
      const rest = blocks.slice(i + 1);
      const restLen = rest.reduce((s, r) => s + textOf(r).length, 0);
      const lines = rest.flatMap((r) => linesOf(r)).filter(Boolean);
      const avg = lines.length ? lines.reduce((s, l) => s + l.length, 0) / lines.length : 0;
      // Za nadpisem smí být jen krátké položky (názvy novel), ne další próza.
      if (restLen <= total * 0.4 && avg <= 90) {
        removed.push(`doporučení za nadpisem: ${norm(textOf(heading))}`);
        for (const r of rest) r.remove();
        if (heading === b) b.remove();
        else {
          removeFollowing(b, heading);
          heading.remove();
          if (!textOf(b)) b.remove();
        }
        break;
      }
    }
    seen += t.length;
  }

  // 2) samostatné bloky a řádky rozhraní
  for (const b of Array.from(body.querySelectorAll("p,div,li,h2,h3,h4,h5,h6,blockquote"))) {
    if (!body.contains(b)) continue;
    if (b.querySelector("p,div,li,blockquote")) continue; // jen listové bloky
    const t = textOf(b);
    if (isNoticeLine(t, opts)) {
      removed.push(`řádek rozhraní: ${t.slice(0, 60)}`);
      b.remove();
      continue;
    }
    if (!b.querySelector("br")) continue;
    // řádky oddělené <br/>
    let line: Node[] = [];
    const flush = (br: Node | null) => {
      const text = norm(line.map((n) => n.textContent ?? "").join(""));
      if (text && isNoticeLine(text, opts)) {
        removed.push(`řádek rozhraní: ${text.slice(0, 60)}`);
        for (const n of line) n.parentNode?.removeChild(n);
        br?.parentNode?.removeChild(br);
      }
      line = [];
    };
    for (const n of Array.from(b.childNodes)) {
      if (n.nodeType === 1 && (n as Element).tagName.toLowerCase() === "br") flush(n);
      else line.push(n);
    }
    flush(null);
    if (!textOf(b)) b.remove();
  }

  const html = removed.length === 0 ? xhtml : serializeBody(body);
  return { html, removed, suspicious: findBoilerplate(html) };
}

function linesOf(el: Element): string[] {
  const html = el.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  return parseHtml(`<body>${html.replace(/\n/g, "<br>")}</body>`)
    .body.innerHTML.split(/<br\s*\/?>/i)
    .map((s) => norm(s.replace(/<[^>]*>/g, "")))
    .filter(Boolean);
}

const VOID = new Set(["br", "hr"]);
function serializeNode(n: Node, out: string[]): void {
  if (n.nodeType === 3) {
    out.push(escapeXml(n.nodeValue ?? ""));
    return;
  }
  if (n.nodeType !== 1) return;
  const tag = (n as Element).tagName.toLowerCase();
  if (VOID.has(tag)) {
    out.push(`<${tag}/>`);
    return;
  }
  out.push(`<${tag}>`);
  for (const c of Array.from(n.childNodes)) serializeNode(c, out);
  out.push(`</${tag}>`);
}
function serializeBody(body: Element): string {
  const parts: string[] = [];
  for (const c of Array.from(body.children)) {
    const out: string[] = [];
    serializeNode(c, out);
    parts.push(out.join(""));
  }
  return parts.join("\n");
}
