/**
 * Simulace webu WuxiaBox pro testy.
 *
 * HTML napodobuje STRUKTURU webu (stránka novely s první stránkou katalogu,
 * stránkovaný katalog /e/extend/fy.php?page=N&wjm=slug, kapitoly
 * /novel/<slug>_<n>.html, lazy-load obálka). Texty kapitol jsou vymyšlené
 * výplňové věty – žádný obsah skutečné novely se v repozitáři neukládá.
 */
export const SLUG = "i-created-the-longevity-club";
export const ORIGIN = "https://www.wuxiabox.com";
export const NOVEL_URL = `${ORIGIN}/novel/${SLUG}.html`;

export interface SiteEntry {
  seq: number; // pořadí v URL
  label: string; // číslo zobrazené v katalogu
  title: string;
}

export interface SiteOptions {
  entries: SiteEntry[];
  perPage?: number;
  /** První stránka katalogu má index 0 (výchozí) nebo 1. */
  firstPage?: 0 | 1;
  /** Stránka 0 vrací totéž co stránka 1 (weby číslované od 1 to dělají). */
  page0Mirrors1?: boolean;
  /** Stránky katalogu, které vrací HTTP 500. */
  failPages?: number[];
  declaredTotal?: number;
  /** Katalog vypisuje kapitoly od nejnovější. */
  descending?: boolean;
  coverAttr?: string;
  /** Vlastní text kapitoly podle pořadí v URL. */
  chapterText?: (seq: number) => string;
  /** Stavový kód / HTML pro konkrétní kapitoly. */
  chapterOverride?: (seq: number) => { status: number; data: string } | undefined;
}

export function singleSeries(count: number): SiteEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    label: String(i + 1),
    title: `Chapter ${i + 1} Placeholder Heading ${i + 1}`,
  }));
}

/** Dvě souběžné řady: "001 Chapter 001" a "1 Chapter 1 <název>", prokládané. */
export function twoSeries(count: number): SiteEntry[] {
  const out: SiteEntry[] = [];
  for (let n = 1; n <= count; n++) {
    const padded = String(n).padStart(3, "0");
    out.push({ seq: out.length + 1, label: padded, title: `Chapter ${padded}` });
    out.push({ seq: out.length + 1, label: String(n), title: `Chapter ${n} Placeholder Heading ${n}` });
  }
  return out;
}

export function fillerText(seed: number, sentences = 14): string {
  const words = ["amber", "river", "lantern", "meadow", "copper", "willow", "harbor", "granite", "saffron", "thistle", "ember", "quartz"];
  const out: string[] = [];
  for (let s = 0; s < sentences; s++) {
    const pick = (k: number) => words[(seed * 7 + s * 5 + k * 3) % words.length];
    out.push(`The ${pick(0)} ${pick(1)} drifted past the ${pick(2)} ${pick(3)} while sample line ${seed}-${s} continued.`);
  }
  return out.join(" ");
}

function listItems(entries: SiteEntry[]): string {
  return entries
    .map(
      (e) => `      <li><a href="/novel/${SLUG}_${e.seq}.html" title="${e.title}">
        <span class="chapter-no">${e.label}</span>
        <strong class="chapter-title">${e.title}</strong>
        <time class="chapter-update">2 years ago</time></a></li>`,
    )
    .join("\n");
}

function pagination(pageCount: number, first: 0 | 1): string {
  const links: string[] = [];
  for (let i = 0; i < pageCount; i++) {
    links.push(`<li><a href="/e/extend/fy.php?page=${i + first}&amp;wjm=${SLUG}">${i + 1}</a></li>`);
  }
  return `<ul class="pagination">${links.join("")}</ul>`;
}

export function createSite(opts: SiteOptions) {
  const perPage = opts.perPage ?? 100;
  const first = opts.firstPage ?? 0;
  const ordered = opts.descending ? opts.entries.slice().reverse() : opts.entries;
  const pageCount = Math.max(1, Math.ceil(ordered.length / perPage));
  const pageEntries = (index: number) => ordered.slice(index * perPage, (index + 1) * perPage);
  const requests: string[] = [];
  const declared = opts.declaredTotal ?? opts.entries.length;
  const coverAttr = opts.coverAttr ?? `src="/static/picture/placeholder.png" data-src="/files/article/image/12/${SLUG}.jpg"`;

  const novelHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sample Longevity Club Novel - Read Online</title>
  <meta name="description" content="Synthetic test description.">
</head>
<body>
  <header class="novel-header">
    <div class="fixed-img"><figure class="cover"><img ${coverAttr} alt="cover"></figure></div>
    <div class="novel-info">
      <h1 itemprop="name" class="novel-title text2row">Sample Longevity Club Novel</h1>
      <div class="author"><span>Author:</span><span itemprop="author">Test Author</span></div>
      <div class="header-stats">
        <span><strong><i class="icon-book-open"></i> ${declared}</strong><small>Chapters</small></span>
        <span><strong>1.2M</strong><small>Views</small></span>
      </div>
      <a id="readchapterbtn" href="/novel/${SLUG}_${ordered[ordered.length - 1]?.seq ?? 1}.html">Latest</a>
    </div>
  </header>
  <div class="summary"><div class="content">Synthetic summary used only by automated tests.</div></div>
  <section id="chapters">
    <ul class="chapter-list">
${listItems(pageEntries(0))}
    </ul>
    ${pagination(pageCount, first)}
  </section>
  <script>window.dummy = 1;</script>
</body>
</html>`;

  const catalogHtml = (index: number) => `<!DOCTYPE html><html lang="en"><head><title>Chapters</title></head><body>
    <ul class="chapter-list">
${listItems(pageEntries(index))}
    </ul>
    ${pagination(pageCount, first)}
  </body></html>`;

  const chapterHtml = (e: SiteEntry) => `<!DOCTYPE html><html lang="en"><head><title>${e.title}</title></head><body>
  <header><nav><a href="/">Home</a></nav></header>
  <article id="chapter-article">
    <div class="titles"><h1><a href="/novel/${SLUG}.html">Sample Longevity Club Novel</a></h1><h2>${e.title}</h2></div>
    <div class="chapter-content">
      <p>${(opts.chapterText ?? fillerText)(e.seq)}</p>
      <div class="adsbygoogle">ADVERT</div>
      <p>Second paragraph &nbsp; with a break<br>and <em>emphasis</em> for entry ${e.seq}.</p>
      <script>var x = "<p>not content</p>";</script>
    </div>
    <div class="chapternav"><a href="/novel/${SLUG}_${e.seq + 1}.html">Next</a></div>
  </article>
  <footer>Footer links</footer>
</body></html>`;

  const respond = (url: string, status: number, data: string) => ({ url, status, ok: status >= 200 && status < 300, data, headers: {} });

  const get = async (url: string, o?: { signal?: AbortSignal }) => {
    if (o?.signal?.aborted) {
      const e = new Error("Přerušeno");
      e.name = "AbortError";
      throw e;
    }
    requests.push(url);
    const u = new URL(url);
    if (u.pathname === `/novel/${SLUG}.html`) return respond(url, 200, novelHtml);
    if (u.pathname === "/e/extend/fy.php") {
      const page = Number(u.searchParams.get("page"));
      if (opts.failPages?.includes(page)) return respond(url, 500, "<html><body>Internal Server Error</body></html>");
      let index = page - first;
      if (page === 0 && first === 1) {
        if (!opts.page0Mirrors1) return respond(url, 404, "<html><body>Not Found</body></html>");
        index = 0;
      }
      if (index < 0 || index >= pageCount) return respond(url, 200, catalogHtml(pageCount + 5)); // prázdný seznam
      return respond(url, 200, catalogHtml(index));
    }
    const m = u.pathname.match(new RegExp(`^/novel/${SLUG}_(\\d+)\\.html$`));
    if (m) {
      const seq = Number(m[1]);
      const override = opts.chapterOverride?.(seq);
      if (override) return respond(url, override.status, override.data);
      const entry = opts.entries.find((e) => e.seq === seq);
      if (entry) return respond(url, 200, chapterHtml(entry));
    }
    return respond(url, 404, "<html><body>Not Found</body></html>");
  };

  return { get, requests, pageCount };
}
