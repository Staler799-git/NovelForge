/**
 * Bezpečná oprava existujícího projektu (např. 57 stažených z 3 237 adres):
 * záloha, přepočet logických kapitol, vyčištění lokálních souborů, obnova.
 * Nic se nestahuje – síť je v testu zakázaná.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Chapter, Project } from "@/types";

const chapters: Chapter[] = [];
let projectRow: Project;
const files: Record<string, string> = {};
const deleted: string[] = [];
const network = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("síť se při opravě nesmí použít");
  }),
);

const active = () => chapters.filter((c) => !c.excluded);
vi.mock("@/services/http", async (orig) => ({ ...(await orig<typeof import("@/services/http")>()), http: { get: network, getBinary: network } }));
vi.mock("@/services/db", () => ({
  db: {
    init: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ ...projectRow })),
    getProjects: vi.fn(async () => [{ ...projectRow }]),
    getChapters: vi.fn(async () => chapters.map((c) => ({ ...c }))),
    getChapterStats: vi.fn(async () => ({
      total: active().length,
      downloaded: active().filter((c) => c.status === "downloaded").length,
      failed: active().filter((c) => c.status === "failed").length,
    })),
    updateProject: vi.fn(async (_id: string, patch: any) => {
      Object.assign(projectRow, patch);
    }),
    updateChapter: vi.fn(async (id: string, patch: any) => {
      const c = chapters.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    }),
    reorderChapters: vi.fn(async (patches: Array<{ id: string; orderIndex: number; excluded: boolean }>) => {
      for (const p of patches) {
        const c = chapters.find((x) => x.id === p.id);
        if (c) Object.assign(c, { orderIndex: p.orderIndex, excluded: p.excluded });
      }
    }),
  },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(async () => {}),
    backupDir: (name: string) => `NovelForge/backups/${name}`,
    chapterPath: vi.fn(async (pid: string, cid: string) => `NovelForge/projects/${pid}/${cid}.html`),
    readFile: vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error("ENOENT " + path);
      return files[path];
    }),
    writeFile: vi.fn(async (path: string, data: string) => {
      files[path] = data;
    }),
    copyFile: vi.fn(async (from: string, to: string) => {
      if (!(from in files)) throw new Error("ENOENT " + from);
      files[to] = files[from];
    }),
    deleteFile: vi.fn(async (path: string) => {
      deleted.push(path);
      delete files[path];
    }),
    fileSize: vi.fn(async (path: string) => (path in files ? files[path].length : null)),
    listDir: vi.fn(async (path: string) => {
      const names = new Set<string>();
      for (const f of Object.keys(files)) if (f.startsWith(path + "/")) names.add(f.slice(path.length + 1).split("/")[0]);
      return [...names];
    }),
  },
}));

import { repairProject, restoreBackup, listBackups, markForRedownload, analyzeProject } from "@/services/migrate";
import { chapterToXhtml, downloadManager } from "@/services/downloader";
import { chapterBodyFromFile } from "@/services/epub";
import { htmlToText } from "@/services/content";
import { preflight } from "@/services/preflight";

const PID = "proj-eternal-club-0001";
const ORIGIN = "https://www.wuxiabox.com/novel/i-created-the-longevity-club";
const story = (tag: string) => `<p>${`Synthetic story sentence ${tag} about a quiet harbor town. `.repeat(8)}</p><p>“You'll also like the tea,” said the clerk ${tag}.</p>`;
const ADS = `<p>Tap the screen to use advanced tools</p>`;
const TAIL = `<h4>You'll Also Like</h4><ul><li>Other Sample Novel One</li><li>Other Sample Novel Two</li></ul>`;

/** Stav, jaký vytvořila verze 1.1.2: 3 237 adres v pořadí 001, 1, 002, 2 …, staženo prvních 57. */
function seed(total = 3138, alt = 99, downloaded = 57) {
  chapters.length = 0;
  for (const k of Object.keys(files)) delete files[k];
  deleted.length = 0;
  let order = 0;
  const add = (suffix: string, title: string) => {
    const id = `ch-${suffix}`;
    const c: Chapter = { id, projectId: PID, title, url: `${ORIGIN}_${suffix}.html`, orderIndex: order, status: "pending", retryCount: 0 } as Chapter;
    if (order < downloaded) {
      const path = `NovelForge/projects/${PID}/${id}.html`;
      // každá třetí stažená kapitola je čistá, ostatní nesou reklamní bloky
      const body = order % 3 === 0 ? story(suffix) : ADS + story(suffix) + TAIL;
      files[path] = chapterToXhtml(title, body, "Eternal Club", "Test Author", "en");
      Object.assign(c, { status: "downloaded", filePath: path, fileSize: files[path].length, checksum: "0123456789abcdef".slice(0, 12) + String(order).padStart(4, "0") });
    }
    chapters.push(c);
    order++;
  };
  for (let n = 1; n <= total; n++) {
    if (n <= alt) add(String(n).padStart(3, "0"), `Chapter ${String(n).padStart(3, "0")}`);
    add(String(n), `Chapter ${n} Placeholder`);
  }
  projectRow = {
    id: PID, title: "Eternal Club", author: "Test Author", language: "en", sourceUrl: `${ORIGIN}.html`, sourceDomain: "www.wuxiabox.com",
    status: "downloading", totalChapters: chapters.length, downloadedChapters: downloaded, failedChapters: 0, progress: 1,
  } as unknown as Project;
}

beforeEach(() => {
  seed();
  vi.clearAllMocks();
});

describe("oprava existujícího projektu", () => {
  it("analýza nic nemění a ukáže 3 237 adres = 3 138 kapitol", async () => {
    const before = JSON.stringify(chapters);
    const { analysis } = await analyzeProject(PID);
    expect(analysis).toMatchObject({ urlCount: 3237, uniqueCount: 3138, alternatives: 99, altRange: { first: 1, last: 99 } });
    expect(JSON.stringify(chapters)).toBe(before);
  });

  it("vytvoří zálohu dřív, než cokoli změní, a nic nestahuje ani nemaže", async () => {
    const originals = { ...files };
    const report = await repairProject(projectRow, { variant: "plain", cleanFiles: true });

    expect(network).not.toHaveBeenCalled();
    expect(deleted).toEqual([]);
    const manifest = JSON.parse(files[`${report.backupDir}/backup.json`]);
    expect(manifest.chapters).toHaveLength(3237);
    expect(manifest.project.totalChapters).toBe(3237);
    // každý přepsaný soubor má v záloze původní podobu
    expect(Object.keys(manifest.files).length).toBe(report.cleanedFiles);
    for (const [orig, copy] of Object.entries(manifest.files as Record<string, string>)) expect(files[copy]).toBe(originals[orig]);
    // všechny původní soubory kapitol dál existují
    for (const path of Object.keys(originals)) expect(files[path]).toBeDefined();
  });

  it("přepočítá kapitoly: 3 138 unikátních, 99 vyřazených, žádná adresa se neztratí", async () => {
    const report = await repairProject(projectRow, { variant: "plain", cleanFiles: false });
    expect(report).toMatchObject({ urlCount: 3237, uniqueCount: 3138, excluded: 99 });
    expect(chapters).toHaveLength(3237);
    expect(chapters.filter((c) => c.excluded)).toHaveLength(99);
    expect(chapters.filter((c) => c.excluded).every((c) => /_0\d\d\.html$/.test(c.url))).toBe(true);
    // 57 stažených = 001,1,…,028,29(001..029 liché pozice) -> v hlavní řadě jich zůstává 28
    const keptDone = chapters.filter((c) => !c.excluded && c.status === "downloaded");
    expect(keptDone).toHaveLength(28);
    expect(projectRow.totalChapters).toBe(3138);
    expect(projectRow.downloadedChapters).toBe(28);
    expect(projectRow.status).toBe("paused"); // nic neběží => ne "downloading", a není hotovo
    // stažené soubory vyřazené verze zůstaly na disku i v databázi
    const excludedDone = chapters.filter((c) => c.excluded && c.status === "downloaded");
    expect(excludedDone).toHaveLength(29);
    for (const c of excludedDone) expect(files[c.filePath!]).toBeDefined();
  });

  it("vyčistí stažené kapitoly z lokálních souborů, čisté nechá být", async () => {
    const cleanBefore = chapters.filter((c) => c.status === "downloaded" && c.orderIndex % 3 === 0).map((c) => [c.filePath!, files[c.filePath!]] as const);
    const report = await repairProject(projectRow, { variant: "plain", cleanFiles: true });
    expect(report.cleanedFiles).toBe(38); // 57 stažených, 19 z nich bylo čistých
    expect(report.unreadable).toEqual([]);
    expect(report.suspicious).toEqual([]);
    for (const c of chapters.filter((x) => x.status === "downloaded")) {
      const text = htmlToText(chapterBodyFromFile(files[c.filePath!], false));
      expect(text).not.toMatch(/Tap the screen|You'll Also Like|Other Sample Novel/);
      expect(text).toContain("Synthetic story sentence");
      expect(text).toContain("“You'll also like the tea,” said the clerk"); // věta příběhu zůstala
    }
    for (const [path, content] of cleanBefore) expect(files[path]).toBe(content); // bajt po bajtu beze změny
    expect(chapters.every((c) => c.status !== "pending" || !c.filePath)).toBe(true); // nic nebylo označeno ke stažení
  });

  it("opakovaná oprava už nic nepřepisuje", async () => {
    await repairProject(projectRow, { variant: "plain", cleanFiles: true });
    const snapshot = Object.fromEntries(Object.entries(files).filter(([k]) => k.includes("/projects/")));
    const second = await repairProject(projectRow, { variant: "plain", cleanFiles: true });
    expect(second.cleanedFiles).toBe(0);
    expect(second.excluded).toBe(99);
    for (const [k, v] of Object.entries(snapshot)) expect(files[k]).toBe(v);
  });

  it("obnova ze zálohy vrátí databázi i soubory do původního stavu", async () => {
    const originalFiles = Object.fromEntries(Object.entries(files));
    const originalRows = chapters.map((c) => ({ id: c.id, orderIndex: c.orderIndex, excluded: !!c.excluded, status: c.status, checksum: c.checksum }));
    const report = await repairProject(projectRow, { variant: "padded", cleanFiles: true });
    expect(await listBackups(PID)).toEqual([report.backupDir]);

    const res = await restoreBackup(report.backupDir);
    expect(res.chapters).toBe(3237);
    expect(res.files).toBe(report.cleanedFiles);
    for (const [k, v] of Object.entries(originalFiles)) expect(files[k]).toBe(v);
    expect(chapters.map((c) => ({ id: c.id, orderIndex: c.orderIndex, excluded: !!c.excluded, status: c.status, checksum: c.checksum }))).toEqual(originalRows);
    expect(projectRow.totalChapters).toBe(3237);
    expect(projectRow.downloadedChapters).toBe(57);
    expect(projectRow.status).toBe("paused");
  });

  it("volba alternativní řady upozorní na změnu překladu", async () => {
    const report = await repairProject(projectRow, { variant: "padded", cleanFiles: false });
    expect(report.excluded).toBe(99);
    expect(report.warnings.join(" ")).toMatch(/změní překlad/);
    expect(chapters.filter((c) => c.excluded).every((c) => /_[1-9]\d?\.html$/.test(c.url))).toBe(true);
  });

  it("kapitolu, kde reklama splynula s textem, jen nahlásí; cíleně ji lze stáhnout znovu", async () => {
    const victim = chapters.find((c) => c.id === "ch-2")!;
    files[victim.filePath!] = chapterToXhtml(victim.title, `<p>${"Synthetic story sentence. ".repeat(12)} Tap the screen to use advanced tools You'll Also Like Other Sample Novel One</p>`, "Eternal Club", "Test Author", "en");
    const empty = chapters.find((c) => c.id === "ch-3")!;
    files[empty.filePath!] = chapterToXhtml(empty.title, ADS + TAIL, "Eternal Club", "Test Author", "en");
    const broken = chapters.find((c) => c.id === "ch-4")!;
    delete files[broken.filePath!];

    const report = await repairProject(projectRow, { variant: "plain", cleanFiles: true });
    expect(report.suspicious.map((s) => s.id).sort()).toEqual(["ch-2", "ch-3"]);
    expect(report.unreadable.map((s) => s.id)).toEqual(["ch-4"]);
    expect(files[empty.filePath!]).toContain("Tap the screen"); // soubor bez použitelného textu se nepřepisuje

    const n = await markForRedownload(projectRow, ["ch-2", "ch-3", "ch-4"], report.backupDir);
    expect(n).toBe(3);
    expect(chapters.filter((c) => c.status === "pending" && c.filePath).map((c) => c.id).sort()).toEqual(["ch-2", "ch-3", "ch-4"]);
    expect(chapters.filter((c) => c.status === "downloaded")).toHaveLength(54); // ostatní stažené zůstaly
    expect(files[`${report.backupDir}/files/ch-2.html`]).toContain("Tap the screen"); // původní verze je v záloze
    expect(deleted).toEqual([]);
  });

  it("po opravě kontrola před exportem hlásí neúplnou knihu a zvolenou verzi, ne duplicity", async () => {
    await repairProject(projectRow, { variant: "plain", cleanFiles: true });
    const check = preflight(chapters, true);
    expect(check.total).toBe(3138);
    expect(check.downloaded).toBe(28);
    expect(check.variantLabel).toMatch(/hlavní řada/);
    expect(check.issues.find((i) => i.code === "incomplete")?.message).toMatch(/NEÚPLNÁ: staženo 28 z 3138/);
    expect(check.issues.some((i) => i.code === "gaps")).toBe(false);
    expect(check.duplicates).toBe(0);
  });

  it("správce stahování po opravě nic nespouští sám", () => {
    expect(downloadManager.isDownloading(PID)).toBe(false);
  });
});
