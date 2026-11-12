import { describe, it, expect, vi } from "vitest";
import JSZip from "jszip";
import { buildEpub } from "@/services/epub";
import type { Project } from "@/types";

vi.mock("@/services/db", () => ({
  db: { updateProject: vi.fn() },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(),
    readFile: vi.fn(async (path: string) => {
      if (path.includes("c1-")) return '<html><body><p>Tělo první kapitoly.</p></body></html>';
      if (path.includes("c2-")) return '<html><body><p>Tělo druhé kapitoly.</p></body></html>';
      return "";
    }),
    fileSize: vi.fn(async () => 100),
    epubPath: vi.fn((name: string) => `NovelForge/exports/${name}`),
    writeFile: vi.fn(),
  },
}));

const project = {
  id: "p1",
  title: "Testovací kniha",
  author: "Testovací autor",
  language: "cs",
  description: "Popis knihy pro testy.",
} as unknown as Project;

const chapters = [
  { orderIndex: 0, title: "Kapitola jedna", filePath: `NovelForge/projects/p1/c1-1.html` },
  { orderIndex: 1, title: "Kapitola dva", filePath: `NovelForge/projects/p1/c2-2.html` },
];

describe("EPUB generator", () => {
  it("vygeneruje validní EPUB 3 strukturu", async () => {
    const bytes = await buildEpub(project, chapters);
    expect(bytes.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);

    // mimetype musí být první
    expect(names[0]).toBe("mimetype");
    expect(await zip.file("mimetype")!.async("string")).toBe("application/epub+zip");

    const container = await zip.file("META-INF/container.xml")!.async("string");
    expect(container).toContain("content.opf");

    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("Testovací kniha");
    expect(opf).toContain("Testovací autor");
    expect(opf).toContain("<dc:language>cs</dc:language>");
    expect(opf).toContain("Popis knihy pro testy");
    expect(opf).toContain('properties="nav"');
    expect(opf).toContain("chapter-0001.xhtml");
    expect(opf).toContain("chapter-0002.xhtml");

    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain("Kapitola jedna");
    expect(nav).toContain("chapter-0001.xhtml");

    const ch1 = await zip.file("OEBPS/chapter-0001.xhtml")!.async("string");
    expect(ch1).toContain("Kapitola jedna");
    expect(ch1).toContain("Tělo první kapitoly.");
    expect(ch1).toContain('<meta charset="UTF-8"/>');
    expect(ch1).toContain("xmlns=\"http://www.w3.org/1999/xhtml\"");

    const ncx = await zip.file("OEBPS/toc.ncx")!.async("string");
    expect(ncx).toContain("Testovací kniha");
    expect(ncx).toContain("playOrder=\"1\"");
  });

  it("vloží obálku do manifestu když je k dispozici", async () => {
    const cover = "VEVTVA==";
    const bytes = await buildEpub(project, chapters, cover, "image/jpeg");
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file("OEBPS/cover.jpg")!.async("string")).toBe("TEST");
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain('<item id="cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
  });
});
