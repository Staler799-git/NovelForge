import JSZip from "jszip";
import { db } from "./db";
import { storage } from "@/services/storage";
import { escapeXml, sanitizeToXhtml } from "./content";
import { normalizeLanguage } from "./parser/base";
import { bytesToBase64 } from "./http";
import { extForMime } from "./cover";
import type { Project } from "@/types";

export interface EpubChapter {
  orderIndex: number;
  title: string;
  filePath?: string;
}

export interface EpubBuildResult {
  data: Uint8Array;
  /** Názvy kapitol, jejichž soubor se nepodařilo načíst (v knize chybí). */
  missing: string[];
  chapterCount: number;
}

const esc = escapeXml;

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "chapter";
}

function bodyTextFromFile(html: string): string {
  return chapterBodyFromFile(html).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * Vytáhne z uloženého souboru kapitoly jen samotný text (obsah .chapter-body)
 * a vrátí ho jako well-formed XHTML.
 *
 * Dřív se bral celý <body> včetně hlavičky, takže název kapitoly byl v EPUB
 * dvakrát, a HTML se nepřevádělo na XHTML (soubory ze starších verzí obsahují
 * `<br>` a `&nbsp;`, což v EPUB není platné).
 */
export function chapterBodyFromFile(html: string): string {
  // <head> se zahazuje: stačí tělo a parser nemá důvod sahat na styly.
  const doc = new DOMParser().parseFromString(html.replace(/^<\?xml[^>]*\?>/, "").replace(/<head[\s>][\s\S]*?<\/head>/i, ""), "text/html");
  const body = doc.querySelector(".chapter-body");
  if (body) return sanitizeToXhtml(body.innerHTML);
  for (const el of Array.from(doc.querySelectorAll("header.chapter-header"))) el.remove();
  return sanitizeToXhtml(doc.body?.innerHTML ?? html);
}

const STYLES_CSS = `
@charset "UTF-8";
@page { margin: 2cm; }
body { font-family: Georgia, Cambria, "Times New Roman", serif; line-height: 1.7; color: #1a1a1a; margin: 0; }
.cover { width: 100%; text-align: center; padding: 2em 0; }
.cover img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
h1 { font-size: 1.6em; margin: 1.2em 0 0.6em; line-height: 1.3; }
p { margin: 0.7em 0; text-align: justify; }
.chapter { page-break-before: always; margin: 1.5em 0; }
.chapter h1 { font-size: 1.5em; border-bottom: 1px solid #ccc; padding-bottom: 0.4em; }
.chapter-meta { font-size: 0.9em; color: #555; margin-bottom: 1em; }
ol.toc { list-style: none; padding-left: 0; }
ol.toc li { margin: 0.5em 0; font-size: 1.05em; }
nav#toc ol { padding-left: 1.2em; }
.small { font-size: 0.9em; color: #666; }
`.trim();

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const chapterFile = (i: number) => `chapter-${String(i + 1).padStart(5, "0")}.xhtml`;

function ncx(project: Project, lang: string, chapters: EpubChapter[]): string {
  const uid = `urn:uuid:${project.id}`;
  const navPoints = chapters
    .map(
      (c, i) =>
        `    <navPoint id="nav-${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${chapterFile(i)}"/></navPoint>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(lang)}">
  <head>
    <meta name="dtb:uid" content="${esc(uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(project.title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

function tocTitle(lang: string): string {
  return lang.startsWith("cs") ? "Obsah" : lang.startsWith("sk") ? "Obsah" : lang.startsWith("de") ? "Inhalt" : "Contents";
}

function navXhtml(project: Project, lang: string, chapters: EpubChapter[]): string {
  const items = chapters.map((c, i) => `      <li><a href="${chapterFile(i)}">${esc(c.title)}</a></li>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(project.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${tocTitle(lang)}</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function coverXhtml(project: Project, lang: string, coverHref: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(project.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <section class="cover" epub:type="cover"><img src="${esc(coverHref)}" alt="${esc(project.title)}"/></section>
</body>
</html>`;
}

interface CoverRef {
  href: string;
  mime: string;
}

function opf(project: Project, lang: string, chapters: EpubChapter[], cover: CoverRef | null, modified: string): string {
  const uid = `urn:uuid:${project.id}`;
  const manifest: string[] = [];
  const spine: string[] = [];

  if (cover) {
    // Obrázek obálky se v manifestu označí properties="cover-image" (EPUB 3)
    // a navíc <meta name="cover"> (EPUB 2 čtečky). Do spine patří XHTML
    // stránka s obrázkem – samotný obrázek ve spine být nesmí.
    manifest.push(`    <item id="cover-image" href="${esc(cover.href)}" media-type="${esc(cover.mime)}" properties="cover-image"/>`);
    manifest.push(`    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="cover"/>`);
  }
  manifest.push(`    <item id="css" href="styles.css" media-type="text/css"/>`);
  manifest.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  manifest.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  chapters.forEach((_c, i) => {
    manifest.push(`    <item id="chap-${i + 1}" href="${chapterFile(i)}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="chap-${i + 1}"/>`);
  });

  const meta: string[] = [
    `    <dc:identifier id="bookid">${esc(uid)}</dc:identifier>`,
    `    <dc:title>${esc(project.title)}</dc:title>`,
    `    <dc:language>${esc(lang)}</dc:language>`,
  ];
  if (project.author) {
    meta.push(`    <dc:creator id="creator">${esc(project.author)}</dc:creator>`);
    meta.push(`    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>`);
  }
  if (project.description) meta.push(`    <dc:description>${esc(project.description)}</dc:description>`);
  if (project.sourceUrl) meta.push(`    <dc:source>${esc(project.sourceUrl)}</dc:source>`);
  meta.push(`    <meta property="dcterms:modified">${esc(modified)}</meta>`);
  if (cover) meta.push(`    <meta name="cover" content="cover-image"/>`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="${esc(lang)}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta.join("\n")}
  </metadata>
  <manifest>
${manifest.join("\n")}
  </manifest>
  <spine toc="ncx">
${spine.join("\n")}
  </spine>
</package>`;
}

function chapterXhtml(title: string, bodyXhtml: string, lang: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <section class="chapter">
    <h1>${esc(title)}</h1>
${bodyXhtml}
  </section>
</body>
</html>`;
}

/**
 * Sestaví JEDEN EPUB 3 se všemi předanými kapitolami v pořadí `orderIndex`.
 *
 * - jazyk se bere z metadat projektu (dřív byl v XHTML natvrdo "cs"),
 * - obálka se vloží se správným MIME typem a příponou,
 * - obsah, navigace (nav.xhtml) i toc.ncx používají STEJNÉ seřazené pořadí,
 * - každý soubor je well-formed XML.
 */
export async function buildEpubDetailed(
  project: Project,
  chapters: EpubChapter[],
  coverBase64?: string,
  coverMime = "image/jpeg",
  onProgress?: (done: number, total: number) => void,
): Promise<EpubBuildResult> {
  const zip = new JSZip();
  const lang = normalizeLanguage(project.language, "en");

  // mimetype musí být první položka archivu a nekomprimovaná
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);

  let cover: CoverRef | null = null;
  if (coverBase64) {
    cover = { href: `cover.${extForMime(coverMime)}`, mime: coverMime };
    zip.file(`OEBPS/${cover.href}`, coverBase64.replace(/\s+/g, ""), { base64: true });
    zip.file("OEBPS/cover.xhtml", coverXhtml(project, lang, cover.href));
  }
  zip.file("OEBPS/styles.css", STYLES_CSS);

  const ordered = chapters.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const included: EpubChapter[] = [];
  const missing: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    let body = "";
    if (c.filePath) {
      try {
        body = chapterBodyFromFile(await storage.readFile(c.filePath));
      } catch {
        body = "";
      }
    }
    if (!body.trim()) {
      missing.push(c.title);
    } else {
      zip.file(`OEBPS/${chapterFile(included.length)}`, chapterXhtml(c.title, body, lang));
      included.push(c);
    }
    if (onProgress && (i % 25 === 0 || i === ordered.length - 1)) onProgress(i + 1, ordered.length);
  }
  if (included.length === 0) {
    throw new Error("Žádná z vybraných kapitol nemá uložený text – EPUB nelze vytvořit.");
  }

  zip.file("OEBPS/toc.ncx", ncx(project, lang, included));
  zip.file("OEBPS/nav.xhtml", navXhtml(project, lang, included));
  // dcterms:modified musí být přesně CCYY-MM-DDThh:mm:ssZ (bez milisekund)
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  zip.file("OEBPS/content.opf", opf(project, lang, included, cover, modified));

  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: "application/epub+zip" });
  return { data, missing, chapterCount: included.length };
}

export async function buildEpub(
  project: Project,
  chapters: EpubChapter[],
  coverBase64?: string,
  coverMime = "image/jpeg"
): Promise<Uint8Array> {
  return (await buildEpubDetailed(project, chapters, coverBase64, coverMime)).data;
}

export async function generateEpub(
  project: Project,
  chapters: EpubChapter[],
  coverBase64?: string,
  coverMime = "image/jpeg",
  onProgress?: (done: number, total: number) => void,
): Promise<{ path: string; size: number; missing: string[]; chapterCount: number }> {
  await storage.init();
  const built = await buildEpubDetailed(project, chapters, coverBase64, coverMime, onProgress);
  const fileName = `${safeName(project.title)}-${project.id.slice(0, 8)}.epub`;
  const path = storage.epubPath(fileName);
  // BINÁRNÍ zápis. Dřív se base64 zapisoval s Encoding.UTF8, takže soubor
  // .epub obsahoval base64 text a žádná čtečka ho neotevřela.
  await storage.writeBinary(path, bytesToBase64(built.data));
  const size = await storage.fileSize(path);
  await db.updateProject(project.id, { epubPath: path });
  return { path, size: size ?? built.data.byteLength, missing: built.missing, chapterCount: built.chapterCount };
}

export async function generateTxt(project: Project, chapters: EpubChapter[]): Promise<{ path: string; size: number }> {
  await storage.init();
  const ordered = chapters.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  let text = `${project.title}\n${project.author}\n${project.language}\n\n`;
  if (project.description) text += `${project.description}\n\n`;
  text += "=".repeat(40) + "\n\n";
  for (const c of ordered) {
    let body = "";
    if (c.filePath) {
      try {
        body = bodyTextFromFile(await storage.readFile(c.filePath));
      } catch {
        body = "";
      }
    }
    text += `${c.title}\n${"-".repeat(c.title.length)}\n\n${body}\n\n`;
    text += "~".repeat(40) + "\n\n";
  }
  const fileName = `${safeName(project.title)}-${project.id.slice(0, 8)}.txt`;
  const path = storage.epubPath(fileName);
  await storage.writeFile(path, text);
  const size = await storage.fileSize(path);
  return { path, size: size ?? new TextEncoder().encode(text).byteLength };
}

export async function generateHtml(project: Project, chapters: EpubChapter[]): Promise<{ path: string; size: number }> {
  await storage.init();
  const ordered = chapters.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const parts: string[] = [];
  for (const c of ordered) {
    let bodyHtml = "";
    if (c.filePath) {
      try {
        bodyHtml = chapterBodyFromFile(await storage.readFile(c.filePath));
      } catch {
        bodyHtml = "";
      }
    }
    parts.push(`<section class="chapter"><h1>${esc(c.title)}</h1>${bodyHtml}</section>`);
  }
  const html = `<!DOCTYPE html>
<html lang="${esc(project.language)}">
<head><meta charset="UTF-8"><title>${esc(project.title)}</title>
<style>body{font-family:Georgia,serif;line-height:1.7;color:#1a1a1a;padding:1rem}h1{font-size:1.5em;border-bottom:1px solid #ccc;padding-bottom:.4em}.chapter{page-break-before:always;margin:1.5em 0}</style></head>
<body>
<h1>${esc(project.title)}</h1><p class="small">${esc(project.author)}</p>
${parts.join("\n")}
</body>
</html>`;
  const fileName = `${safeName(project.title)}-${project.id.slice(0, 8)}.html`;
  const path = storage.epubPath(fileName);
  await storage.writeFile(path, html);
  const size = await storage.fileSize(path);
  return { path, size: size ?? new TextEncoder().encode(html).byteLength };
}

export { storage as epubStorage };
