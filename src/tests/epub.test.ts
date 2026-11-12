import { describe, it, expect, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { buildEpub, buildEpubDetailed, generateEpub, chapterBodyFromFile } from "@/services/epub";
import { chapterToXhtml } from "@/services/downloader";
import { base64ToBytes } from "@/services/http";
import type { Project } from "@/types";

const files: Record<string, string> = {};
const binary: Record<string, string> = {};

vi.mock("@/services/db", () => ({
  db: { updateProject: vi.fn(async () => {}), init: vi.fn(async () => {}) },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error("File does not exist");
      return files[path];
    }),
    fileSize: vi.fn(async (path: string) => (path in binary ? base64ToBytes(binary[path]).length : null)),
    epubPath: vi.fn((name: string) => `NovelForge/exports/${name}`),
    writeFile: vi.fn(async () => {
      throw new Error("EPUB se nesmí zapisovat jako text");
    }),
    writeBinary: vi.fn(async (path: string, base64: string) => {
      binary[path] = base64;
    }),
  },
}));
import { storage } from "@/services/storage";

// 1×1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const project = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  title: "Sample Club & <Friends>",
  author: 'Test "Author"',
  language: "en",
  description: "A synthetic description for tests.",
  sourceUrl: "https://www.example.com/novel/sample.html?a=1&b=2",
} as unknown as Project;

function put(n: number, body: string, title = `Chapter ${n}`) {
  const path = `NovelForge/projects/p/c${n}.html`;
  files[path] = chapterToXhtml(title, body, project.title, project.author, "en");
  return { orderIndex: n - 1, title, filePath: path };
}

async function unzip(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const text = (name: string) => zip.file(name)!.async("string");
  return { zip, text, names: Object.keys(zip.files).filter((n) => !zip.files[n].dir) };
}

beforeEach(() => {
  for (const k of Object.keys(files)) delete files[k];
  for (const k of Object.keys(binary)) delete binary[k];
  vi.clearAllMocks();
});

describe("EPUB generator", () => {
  it("vytvoří platnou strukturu EPUB 3 a každý XML soubor je well-formed", async () => {
    const chapters = [put(1, "<p>Body of the first chapter.</p>"), put(2, "<p>Body of the second chapter &amp; more.</p>")];
    const bytes = await buildEpub(project, chapters, PNG, "image/png");
    const { zip, text, names } = await unzip(bytes);

    // mimetype: první položka, nekomprimovaná, přesný obsah
    expect(names[0]).toBe("mimetype");
    expect(await text("mimetype")).toBe("application/epub+zip");
    expect(new TextDecoder().decode(bytes.slice(30, 38))).toBe("mimetype");
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(0); // STORE
    expect((zip.files["mimetype"] as any)._data.compressedSize).toBe(20);

    for (const name of names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n))) {
      const res = XMLValidator.validate(await text(name));
      expect(res === true ? name : `${name}: ${JSON.stringify(res)}`).toBe(name);
    }

    expect(await text("META-INF/container.xml")).toContain('full-path="OEBPS/content.opf"');
  });

  it("OPF: metadata, manifest a spine odpovídají souborům v archivu", async () => {
    const chapters = [put(1, "<p>One.</p>"), put(2, "<p>Two.</p>"), put(3, "<p>Three.</p>")];
    const { text, names } = await unzip(await buildEpub(project, chapters, PNG, "image/png"));
    const opf = new DOMParser().parseFromString(await text("OEBPS/content.opf"), "application/xml");

    expect(opf.querySelector("package")!.getAttribute("version")).toBe("3.0");
    expect(opf.querySelector("package")!.getAttribute("unique-identifier")).toBe("bookid");
    expect(opf.getElementsByTagName("dc:identifier")[0].getAttribute("id")).toBe("bookid");
    expect(opf.getElementsByTagName("dc:identifier")[0].textContent).toBe(`urn:uuid:${project.id}`);
    expect(opf.getElementsByTagName("dc:title")[0].textContent).toBe("Sample Club & <Friends>");
    expect(opf.getElementsByTagName("dc:creator")[0].textContent).toBe('Test "Author"');
    expect(opf.getElementsByTagName("dc:language")[0].textContent).toBe("en");
    expect(await text("OEBPS/content.opf")).toMatch(/<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);

    const items = Array.from(opf.getElementsByTagName("item"));
    const hrefs = items.map((i) => `OEBPS/${i.getAttribute("href")}`);
    // každý soubor v OEBPS (kromě OPF) je v manifestu právě jednou a naopak
    expect([...hrefs].sort()).toEqual(names.filter((n) => n.startsWith("OEBPS/") && n !== "OEBPS/content.opf").sort());
    expect(new Set(items.map((i) => i.getAttribute("id"))).size).toBe(items.length);
    expect(items.filter((i) => i.getAttribute("properties") === "nav")).toHaveLength(1);

    const ids = new Map(items.map((i) => [i.getAttribute("id"), i]));
    const spine = Array.from(opf.getElementsByTagName("itemref")).map((r) => r.getAttribute("idref"));
    expect(spine).toEqual(["cover", "chap-1", "chap-2", "chap-3"]);
    for (const idref of spine) expect(ids.get(idref)!.getAttribute("media-type")).toBe("application/xhtml+xml");
    expect(opf.querySelector("spine")!.getAttribute("toc")).toBe("ncx");
    expect((await text("OEBPS/content.opf")).includes("opf:role")).toBe(false);
  });

  it("jazyk se bere z projektu – anglická kniha nemá nikde lang=\"cs\"", async () => {
    const chapters = [put(1, "<p>One.</p>")];
    const { text, names } = await unzip(await buildEpub(project, chapters, PNG, "image/png"));
    for (const name of names.filter((n) => /\.(xhtml|opf|ncx)$/.test(n))) {
      const s = await text(name);
      expect(s).not.toMatch(/lang="cs"/);
      expect(s).toMatch(/xml:lang="en"/);
    }
    expect(await text("OEBPS/content.opf")).toContain("<dc:language>en</dc:language>");
    expect(await text("OEBPS/nav.xhtml")).toContain("<h1>Contents</h1>");

    const cs = await unzip(await buildEpub({ ...project, language: "cs" } as Project, chapters));
    expect(await cs.text("OEBPS/content.opf")).toContain("<dc:language>cs</dc:language>");
    expect(await cs.text("OEBPS/chapter-00001.xhtml")).toContain('xml:lang="cs" lang="cs"');

    const none = await unzip(await buildEpub({ ...project, language: "" } as Project, chapters));
    expect(await none.text("OEBPS/content.opf")).toContain("<dc:language>en</dc:language>");
  });

  it("kapitoly jsou seřazené podle orderIndex ve spine, nav i ncx shodně", async () => {
    const chapters = [put(3, "<p>Third body.</p>", "Gamma"), put(1, "<p>First body.</p>", "Alpha"), put(2, "<p>Second body.</p>", "Beta")];
    const { text } = await unzip(await buildEpub(project, chapters));
    expect(await text("OEBPS/chapter-00001.xhtml")).toContain("First body.");
    expect(await text("OEBPS/chapter-00002.xhtml")).toContain("Second body.");
    expect(await text("OEBPS/chapter-00003.xhtml")).toContain("Third body.");

    const nav = new DOMParser().parseFromString((await text("OEBPS/nav.xhtml")).replace(/<link[^>]*\/>/, ""), "application/xml");
    const links = Array.from(nav.getElementsByTagName("a"));
    expect(links.map((a) => a.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["chapter-00001.xhtml", "chapter-00002.xhtml", "chapter-00003.xhtml"]);
    expect(await text("OEBPS/nav.xhtml")).toContain('epub:type="toc"');

    const ncx = new DOMParser().parseFromString(await text("OEBPS/toc.ncx"), "application/xml");
    const points = Array.from(ncx.getElementsByTagName("navPoint"));
    expect(points.map((p) => p.getAttribute("playOrder"))).toEqual(["1", "2", "3"]);
    expect(Array.from(ncx.getElementsByTagName("content")).map((c) => c.getAttribute("src"))).toEqual(links.map((a) => a.getAttribute("href")));
    const uid = Array.from(ncx.getElementsByTagName("meta")).find((m) => m.getAttribute("name") === "dtb:uid")!;
    expect(uid.getAttribute("content")).toBe(`urn:uuid:${project.id}`);
  });

  it("název kapitoly je v souboru jen jednou (hlavička uloženého souboru se nepřenáší)", async () => {
    const { text } = await unzip(await buildEpub(project, [put(1, "<p>Only body here.</p>", "Unique Heading")]));
    const ch = await text("OEBPS/chapter-00001.xhtml");
    expect(ch.match(/<h1>/g)).toHaveLength(1);
    expect(ch).not.toContain("chapter-header");
    expect(ch).toContain("<p>Only body here.</p>");
    expect(ch).toContain('href="styles.css"');
  });

  it("obálka: správná přípona a MIME, cover-image, stránka obálky ve spine", async () => {
    const { zip, text } = await unzip(await buildEpub(project, [put(1, "<p>One.</p>")], PNG, "image/png"));
    const img = await zip.file("OEBPS/cover.png")!.async("uint8array");
    expect(Array.from(img.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(img.length).toBe(base64ToBytes(PNG).length);
    expect(zip.file("OEBPS/cover.jpg")).toBeNull();

    const opf = await text("OEBPS/content.opf");
    expect(opf).toContain('<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>');
    expect(opf).toContain('<meta name="cover" content="cover-image"/>');
    expect(opf).not.toContain('<itemref idref="cover-image"/>');
    expect(await text("OEBPS/cover.xhtml")).toContain('<img src="cover.png"');

    const jpg = await unzip(await buildEpub(project, [put(1, "<p>One.</p>")], "/9j/4AAQSkZJRg==", "image/jpeg"));
    expect(await jpg.text("OEBPS/content.opf")).toContain('href="cover.jpg" media-type="image/jpeg"');
  });

  it("bez obálky nevzniknou odkazy na neexistující soubor", async () => {
    const { text, names } = await unzip(await buildEpub(project, [put(1, "<p>One.</p>")]));
    expect(names.some((n) => n.includes("cover"))).toBe(false);
    expect(await text("OEBPS/content.opf")).not.toContain("cover");
  });

  it("soubory ze starší verze (HTML s <br> a &nbsp;) převede na platné XHTML", async () => {
    const path = "NovelForge/projects/p/old.html";
    files[path] = `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>Old</title></head><body>
      <header class="chapter-header"><h1>Old</h1></header><p>Line one<br>line&nbsp;two<p>Unclosed &copy; paragraph<img src="x.png"></body></html>`;
    const { text } = await unzip(await buildEpub(project, [{ orderIndex: 0, title: "Old", filePath: path }]));
    const ch = await text("OEBPS/chapter-00001.xhtml");
    expect(XMLValidator.validate(ch)).toBe(true);
    expect(ch).not.toMatch(/&nbsp;|&copy;|<img/);
    expect(ch.match(/<h1>/g)).toHaveLength(1);
    expect(chapterBodyFromFile(files[path])).toContain("Line one<br/>");
  });

  it("kapitolu bez souboru do knihy nevloží a nahlásí ji", async () => {
    const chapters = [put(1, "<p>One.</p>"), { orderIndex: 1, title: "Lost chapter", filePath: "NovelForge/projects/p/missing.html" }, put(3, "<p>Three.</p>")];
    const res = await buildEpubDetailed(project, chapters);
    expect(res.missing).toEqual(["Lost chapter"]);
    expect(res.chapterCount).toBe(2);
    const { text, names } = await unzip(res.data);
    expect(names.filter((n) => /chapter-\d+\.xhtml$/.test(n))).toEqual(["OEBPS/chapter-00001.xhtml", "OEBPS/chapter-00002.xhtml"]);
    expect(await text("OEBPS/nav.xhtml")).not.toContain("Lost chapter");
    expect(await text("OEBPS/chapter-00002.xhtml")).toContain("Three.");
  });

  it("bez jediné kapitoly s textem EPUB nevytvoří", async () => {
    await expect(buildEpub(project, [{ orderIndex: 0, title: "X", filePath: "nope" }])).rejects.toThrow(/EPUB nelze vytvořit/);
  });

  it("zvládne tisíce kapitol v jednom souboru", async () => {
    const chapters = Array.from({ length: 3138 }, (_, i) => put(i + 1, `<p>Body ${i + 1}.</p>`));
    const res = await buildEpubDetailed(project, chapters);
    expect(res.chapterCount).toBe(3138);
    const { text, names } = await unzip(res.data);
    expect(names).toContain("OEBPS/chapter-03138.xhtml");
    expect(await text("OEBPS/chapter-03138.xhtml")).toContain("Body 3138.");
    expect(XMLValidator.validate(await text("OEBPS/content.opf"))).toBe(true);
  }, 60000);

  it("generateEpub zapisuje soubor BINÁRNĚ (ne jako base64 text)", async () => {
    const out = await generateEpub(project, [put(1, "<p>One.</p>")], PNG, "image/png");
    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(storage.writeBinary).toHaveBeenCalledTimes(1);
    expect(out.path).toMatch(/^NovelForge\/exports\/sample_club_friends-0f8fad5b\.epub$/);
    const bytes = base64ToBytes(binary[out.path]);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]); // ZIP
    expect(out.size).toBe(bytes.length);
    expect((await unzip(bytes)).names[0]).toBe("mimetype");
  });
});
