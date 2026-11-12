import JSZip from "jszip";
import { db } from "./db";
import { storage } from "@/services/storage";
import type { Project } from "@/types";

export interface EpubChapter {
  orderIndex: number;
  title: string;
  filePath?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

function safeName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "chapter";
}

function bodyTextFromFile(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) return "";
  return m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function bodyHtmlFromFile(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
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
nav[epub|type="toc"] ol { padding-left: 1.2em; }
.small { font-size: 0.9em; color: #666; }
`.trim();

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

function ncx(project: Project, chapters: EpubChapter[]): string {
  const uid = `urn:uuid:${project.id}`;
  const navPoints = chapters
    .map(
      (c, i) =>
        `<navPoint id="nav-${i + 1}" playOrder="${i + 1}">
  <navLabel><text>${esc(c.title)}</text></navLabel>
  <content src="chapter-${String(i + 1).padStart(4, "0")}.xhtml"/>
</navPoint>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${esc(project.language)}">
  <head>
    <meta name="dtb:uid" content="${esc(uid)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${esc(project.title)}</text></docTitle>
  <docAuthor><text>${esc(project.author)}</text></docAuthor>
  <navMap>
${navPoints}
  </navMap>
</ncx>`;
}

function navXhtml(project: Project, chapters: EpubChapter[]): string {
  const items = chapters
    .map(
      (c, i) =>
        `<li><a href="chapter-${String(i + 1).padStart(4, "0")}.xhtml">${esc(c.title)}</a></li>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(project.language)}" lang="${esc(project.language)}">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(project.title)} - Obsah</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Obsah</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>`;
}

function opf(project: Project, chapters: EpubChapter[], coverId: string | null, modified: string): string {
  const uid = `urn:uuid:${project.id}`;
  const manifestItems: string[] = [];
  const spineItems: string[] = [];

  if (coverId) {
    manifestItems.push(`    <item id="${coverId}" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>`);
    spineItems.push(`    <itemref idref="${coverId}" linear="no"/>`);
  }
  manifestItems.push(`    <item id="css" href="styles.css" media-type="text/css"/>`);
  manifestItems.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  manifestItems.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  chapters.forEach((_c, i) => {
    const id = `chap-${i + 1}`;
    const file = `chapter-${String(i + 1).padStart(4, "0")}.xhtml`;
    manifestItems.push(`    <item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${id}"/>`);
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="${esc(project.language)}" unique-identifier="bookid" prefix="dcterms: http://purl.org/dc/terms/ schema: http://schema.org/">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(uid)}</dc:identifier>
    <dc:title>${esc(project.title)}</dc:title>
${project.author ? `    <dc:creator opf:role="aut" opf:file-as="${esc(project.author)}">${esc(project.author)}</dc:creator>` : ""}
    <dc:language>${esc(project.language)}</dc:language>
${project.description ? `    <dc:description>${esc(project.description)}</dc:description>` : ""}
    <meta property="dcterms:modified">${esc(modified)}</meta>
${coverId ? `    <meta name="cover" content="${coverId}"/>` : ""}
    <meta property="schema:accessMode">text</meta>
    <meta property="schema:accessModeSufficient">text</meta>
    <meta name="generator" content="NovelForge 1.0"/>
  </metadata>
  <manifest>
${manifestItems.join("\n")}
  </manifest>
  <spine>
${spineItems.join("\n")}
  </spine>
</package>`;
}

function chapterXhtml(title: string, bodyHtml: string, lang: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${esc(lang)}" lang="${esc(lang)}">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
  <div class="chapter">
    <h1>${esc(title)}</h1>
    <div class="chapter-body">${bodyHtml}</div>
  </div>
</body>
</html>`;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function buildEpub(
  project: Project,
  chapters: EpubChapter[],
  coverBase64?: string,
  coverMime = "image/jpeg"
): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", CONTAINER_XML);

  const coverId = coverBase64 ? "cover-image" : null;
  if (coverBase64) {
    zip.file(`OEBPS/cover.${coverMime === "image/png" ? "png" : coverMime === "image/svg+xml" ? "svg" : "jpg"}`, coverBase64, { base64: true });
  }
  zip.file("OEBPS/styles.css", STYLES_CSS);
  zip.file("OEBPS/toc.ncx", ncx(project, chapters));
  zip.file("OEBPS/nav.xhtml", navXhtml(project, chapters));

  const ordered = chapters.slice().sort((a, b) => a.orderIndex - b.orderIndex);
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const file = `chapter-${String(i + 1).padStart(4, "0")}.xhtml`;
    let bodyHtml = "";
    if (c.filePath) {
      try {
        bodyHtml = bodyHtmlFromFile(await storage.readFile(c.filePath));
      } catch {
        bodyHtml = "";
      }
    }
    zip.file(`OEBPS/${file}`, chapterXhtml(c.title, bodyHtml, project.language));
  }

  zip.file("OEBPS/content.opf", opf(project, ordered, coverId, new Date().toISOString()));

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function generateEpub(
  project: Project,
  chapters: EpubChapter[],
  coverBase64?: string,
  coverMime = "image/jpeg"
): Promise<{ path: string; size: number }> {
  await storage.init();
  const content = await buildEpub(project, chapters, coverBase64, coverMime);
  const fileName = `novel-${safeName(project.title)}-${project.id.slice(0, 8)}.epub`;
  const path = storage.epubPath(fileName);
  await storage.writeFile(path, uint8ArrayToBase64(content));
  const size = await storage.fileSize(path);
  await db.updateProject(project.id, { epubPath: path });
  return { path, size: size ?? content.byteLength };
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
  const fileName = `novel-${safeName(project.title)}-${project.id.slice(0, 8)}.txt`;
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
        bodyHtml = bodyHtmlFromFile(await storage.readFile(c.filePath));
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
  const fileName = `novel-${safeName(project.title)}-${project.id.slice(0, 8)}.html`;
  const path = storage.epubPath(fileName);
  await storage.writeFile(path, html);
  const size = await storage.fileSize(path);
  return { path, size: size ?? new TextEncoder().encode(html).byteLength };
}

export { storage as epubStorage };
