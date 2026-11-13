/**
 * v1.2.2 – pád při pokračování stahování (WTR-LAB, 3138 kapitol, 10 stažených).
 * Správce stahování běží proti skutečnému parseru WTR-LAB; síť, databáze,
 * úložiště a nativní vykreslování jsou nahrazené. Text kapitol je syntetický.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  chapters: [] as any[],
  projectRow: {} as Record<string, any>,
  files: {} as Record<string, string>,
  diagFiles: {} as Record<string, string>,
  http: {
    inFlight: 0,
    maxInFlight: 0,
    posts: [] as { url: string; body: any }[],
    gets: [] as string[],
    post: null as null | ((url: string, body: any) => Promise<any>),
    get: null as null | ((url: string) => Promise<any>),
  },
  render: {
    inFlight: 0,
    maxInFlight: 0,
    calls: [] as string[],
    impl: null as null | ((url: string) => Promise<{ html: string; url: string }>),
  },
  dbWrites: { project: 0 },
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async ({ path }: any) => {
      if (!(path in h.diagFiles)) throw new Error("File does not exist");
      return { size: h.diagFiles[path].length };
    }),
    appendFile: vi.fn(async ({ path, data }: any) => {
      h.diagFiles[path] = (h.diagFiles[path] ?? "") + data;
    }),
    writeFile: vi.fn(async ({ path, data }: any) => {
      h.diagFiles[path] = data;
    }),
    readFile: vi.fn(async ({ path }: any) => {
      if (!(path in h.diagFiles)) throw new Error("File does not exist");
      return { data: h.diagFiles[path] };
    }),
    deleteFile: vi.fn(async ({ path }: any) => {
      delete h.diagFiles[path];
    }),
    rename: vi.fn(async ({ from, to }: any) => {
      h.diagFiles[to] = h.diagFiles[from];
      delete h.diagFiles[from];
    }),
  },
}));

vi.mock("@/services/db", () => ({
  db: {
    init: vi.fn(async () => {}),
    getProject: vi.fn(async () => null),
    getProjects: vi.fn(async () => [{ ...h.projectRow }]),
    getChapters: vi.fn(async (projectId: string) => h.chapters.filter((c) => c.projectId === projectId).map((c) => ({ ...c }))),
    getChapterStats: vi.fn(async (projectId: string) => {
      const cs = h.chapters.filter((c) => c.projectId === projectId && !c.excluded);
      return { total: cs.length, downloaded: cs.filter((c) => c.status === "downloaded").length, failed: cs.filter((c) => c.status === "failed").length };
    }),
    updateProject: vi.fn(async (_id: string, patch: any) => {
      h.dbWrites.project++;
      Object.assign(h.projectRow, patch);
    }),
    updateChapter: vi.fn(async (id: string, patch: any) => {
      const c = h.chapters.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    }),
  },
}));

vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(async () => {}),
    chapterPath: vi.fn(async (projectId: string, chapterId: string) => `NovelForge/projects/${projectId}/${chapterId}.html`),
    writeFile: vi.fn(async (path: string, data: string) => {
      h.files[path] = data;
    }),
    fileSize: vi.fn(async (path: string) => (path in h.files ? h.files[path].length : null)),
  },
}));

vi.mock("@/services/http", async (orig) => {
  const actual = await orig<typeof import("@/services/http")>();
  const track = async <T,>(fn: () => Promise<T>): Promise<T> => {
    h.http.inFlight++;
    h.http.maxInFlight = Math.max(h.http.maxInFlight, h.http.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await fn();
    } finally {
      h.http.inFlight--;
    }
  };
  return {
    ...actual,
    http: {
      get: (url: string) => track(async () => {
        h.http.gets.push(url);
        if (h.http.get) return h.http.get(url);
        return { ok: false, status: 404, data: "", url, headers: {} };
      }),
      postJson: (url: string, body: any) => track(async () => {
        h.http.posts.push({ url, body });
        return h.http.post!(url, body);
      }),
      getBinary: async () => {
        throw new Error("not used");
      },
    },
  };
});

vi.mock("@/services/render", () => {
  class RenderError extends Error {
    critical: boolean;
    constructor(m: string, critical = false) {
      super(m);
      this.critical = critical;
    }
  }
  const renderPage = async (url: string) => {
    h.render.calls.push(url);
    h.render.inFlight++;
    h.render.maxInFlight = Math.max(h.render.maxInFlight, h.render.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      if (!h.render.impl) throw new RenderError("Nativní modul WebRenderer není k dispozici");
      return await h.render.impl(url);
    } finally {
      h.render.inFlight--;
    }
  };
  return { RenderError, renderPage, renderHtml: async (u: string) => (await renderPage(u)).html, onMemoryWarning: () => () => {} };
});

import { downloadManager, effectiveConcurrency } from "@/services/downloader";
import { getParser, parserInfo } from "@/services/parser/registry";
import { identityMismatch } from "@/services/parser/wtrlab";
import { diag, DIAG_FILE } from "@/services/diag";
import type { Project } from "@/types";

const NOVEL = "https://wtr-lab.com/en/novel/7898/i-created-the-longevity-club";
const chapterUrl = (n: number) => `${NOVEL}/chapter-${n}`;
const TEXT = (n: number) => Array.from({ length: 8 }, (_, i) => `Synthetic filler paragraph ${i + 1} of chapter ${n}, standing in for the real text of the book.`);

const ok = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, data: JSON.stringify(data), url: "", headers: {} });
/** Odpověď čtečky pro kapitolu `no` novely `raw`. */
const reader = (raw: number, no: number, title = `Chapter title ${no}`) =>
  ok({ success: true, chapter: { raw_id: raw, order: no, title }, data: { data: { title, body: TEXT(no) } } });

const events: any[] = [];
downloadManager.on((e: any) => events.push(e));
const lastEnd = () => events.filter((e) => e.type === "project-end").at(-1);
const logs = () => events.filter((e) => e.type === "log").map((e) => e.message as string);

function project(concurrentRequests: number): Project {
  return {
    id: "p1", title: "I Created the Longevity Club", author: "Author", language: "en", sourceUrl: NOVEL,
    totalChapters: 0, downloadedChapters: 0, failedChapters: 0, status: "paused", progress: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    settings: { concurrentRequests, delayMs: 0, maxRetries: 0 },
  } as unknown as Project;
}

/** Projekt s `total` kapitolami, prvních `done` je stažených včetně souborů. */
function seed(total: number, done: number) {
  for (let n = 1; n <= total; n++) {
    const c: any = { id: `c${n}`, projectId: "p1", title: `Chapter ${n}`, url: chapterUrl(n), orderIndex: n - 1, status: "pending" };
    if (n <= done) {
      const path = `NovelForge/projects/p1/c${n}.html`;
      h.files[path] = `<html>original ${n}</html>`;
      Object.assign(c, { status: "downloaded", filePath: path, fileSize: h.files[path].length, checksum: `orig${n}` });
    }
    h.chapters.push(c);
  }
}
const count = (status: string) => h.chapters.filter((c) => c.status === status).length;

beforeEach(async () => {
  await diag.flush();
  h.chapters.length = 0;
  for (const k of Object.keys(h.projectRow)) delete h.projectRow[k];
  Object.assign(h.projectRow, { id: "p1", status: "paused", progress: 0 });
  for (const k of Object.keys(h.files)) delete h.files[k];
  for (const k of Object.keys(h.diagFiles)) delete h.diagFiles[k];
  Object.assign(h.http, { inFlight: 0, maxInFlight: 0, posts: [], gets: [], get: null });
  h.http.post = async (_u, body) => reader(body.raw_id, body.chapter_no);
  Object.assign(h.render, { inFlight: 0, maxInFlight: 0, calls: [], impl: null });
  h.dbWrites.project = 0;
  events.length = 0;
  const p = getParser(NOVEL) as any;
  p.chapterIntervalMs = 0;
  p.renderDelayMs = 0;
  p.catalogDelayMs = 0;
  p.preferredMode = null;
  p.lastChapterAt = 0;
});

describe("souběžnost", () => {
  it("WTR-LAB je omezený na jeden požadavek bez ohledu na nastavení", () => {
    expect(parserInfo(NOVEL)).toMatchObject({ name: "wtrlab", maxConcurrency: 1 });
    expect(effectiveConcurrency(3, chapterUrl(11))).toBe(1);
    expect(effectiveConcurrency(8, chapterUrl(11))).toBe(1);
    expect(effectiveConcurrency(undefined, chapterUrl(11))).toBe(1);
  });

  it("ostatní weby si nastavenou souběžnost ponechají (nejvýše 4)", () => {
    expect(effectiveConcurrency(3, "https://www.wuxiabox.com/novel/x_1.html")).toBe(3);
    expect(effectiveConcurrency(1, "https://www.wuxiabox.com/novel/x_1.html")).toBe(1);
    expect(effectiveConcurrency(9, "https://example.com/book/1")).toBe(4);
    expect(effectiveConcurrency(0, "https://example.com/book/1")).toBe(1);
  });
});

describe("pokračování projektu 3138 kapitol s 10 staženými", () => {
  it("nastavení 3 souběžné → nikdy neběží dva požadavky ani dvě vykreslení naráz; 10 hotových zůstává", async () => {
    seed(3138, 10);
    const before = Object.fromEntries(Object.entries(h.files));
    let served = 0;
    h.http.post = async (_u, body) => {
      served++;
      if (served === 100) downloadManager.pauseProject("p1"); // 100 kapitol v jednom běhu
      return reader(body.raw_id, body.chapter_no);
    };
    await downloadManager.startProject(project(3));

    expect(logs()).toContain("Stahuji 3128 kapitol (10 už hotovo).");
    expect(logs().some((m) => /po jedné kapitole/.test(m))).toBe(true);
    expect(h.http.maxInFlight).toBe(1);
    expect(h.render.maxInFlight).toBeLessThanOrEqual(1);
    expect(count("downloaded")).toBe(110);
    expect(count("failed")).toBe(0);
    expect(count("pending")).toBe(3028);
    expect(h.projectRow).toMatchObject({ status: "paused", downloadedChapters: 110, totalChapters: 3138 });
    // původních 10 kapitol se nestahovalo znovu a jejich soubory jsou beze změny
    expect(h.http.posts.map((p) => p.body.chapter_no).slice(0, 3)).toEqual([11, 12, 13]);
    expect(Math.min(...h.http.posts.map((p) => p.body.chapter_no))).toBe(11);
    for (const [path, data] of Object.entries(before)) expect(h.files[path]).toBe(data);
    for (let n = 1; n <= 10; n++) expect(h.chapters[n - 1]).toMatchObject({ status: "downloaded", checksum: `orig${n}` });
    // každý požadavek nese číslo novely z adresy a správné číslo kapitoly
    expect(h.http.posts.every((p) => p.body.raw_id === 7898)).toBe(true);
    // průběh projektu se nezapisuje po každé kapitole
    expect(h.dbWrites.project).toBeLessThan(40);
    expect(lastEnd()).toMatchObject({ ok: false });
    expect(lastEnd().error).toBeUndefined();
  }, 60000);

  it("opakované Pozastavit / Pokračovat: nic se nestáhne dvakrát a nic se neztratí", async () => {
    seed(3138, 10);
    let served = 0;
    let stopAt = 0;
    h.http.post = async (_u, body) => {
      served++;
      if (served === stopAt) downloadManager.pauseProject("p1");
      return reader(body.raw_id, body.chapter_no);
    };
    for (let round = 1; round <= 5; round++) {
      stopAt = served + 4;
      await downloadManager.startProject(project(3));
      expect(h.projectRow.status).toBe("paused");
      expect(count("downloaded")).toBe(10 + round * 4);
    }
    const nos = h.http.posts.map((p) => p.body.chapter_no);
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => 11 + i));
    expect(new Set(nos).size).toBe(nos.length);
    expect(count("failed")).toBe(0);
    expect(h.http.maxInFlight).toBe(1);
  }, 30000);

  it("dvojí stisk Pokračovat nespustí druhý běh", async () => {
    seed(30, 10);
    const a = downloadManager.startProject(project(3));
    const b = downloadManager.startProject(project(3));
    await Promise.all([a, b]);
    expect(h.http.posts).toHaveLength(20);
    expect(h.http.maxInFlight).toBe(1);
    expect(h.projectRow.status).toBe("completed");
  });

  it("po restartu aplikace: projekt ve stavu downloading se pozastaví, počty se opraví a jde obnovit", async () => {
    seed(3138, 10);
    // stav po pádu: 3 další kapitoly uložené, ale průběh projektu se nestihl zapsat
    for (let n = 11; n <= 13; n++) {
      const path = `NovelForge/projects/p1/c${n}.html`;
      h.files[path] = `<html>saved ${n}</html>`;
      Object.assign(h.chapters[n - 1], { status: "downloaded", filePath: path, fileSize: h.files[path].length });
    }
    Object.assign(h.projectRow, { status: "downloading", downloadedChapters: 10 });
    await downloadManager.recoverInterrupted();
    expect(h.projectRow).toMatchObject({ status: "paused", downloadedChapters: 13 });

    let served = 0;
    h.http.post = async (_u, body) => {
      if (++served === 5) downloadManager.pauseProject("p1");
      return reader(body.raw_id, body.chapter_no);
    };
    await downloadManager.startProject(project(3));
    expect(logs()).toContain("Stahuji 3125 kapitol (13 už hotovo).");
    expect(h.http.posts[0].body.chapter_no).toBe(14);
    expect(count("downloaded")).toBe(18);
  }, 30000);
});

describe("chyby během stahování", () => {
  it("výpadek sítě: běh se řízeně pozastaví, stažené kapitoly zůstanou, po obnovení pokračuje", async () => {
    seed(60, 10);
    let served = 0;
    h.http.post = async (_u, body) => {
      if (++served > 3) throw new Error("The Internet connection appears to be offline.");
      return reader(body.raw_id, body.chapter_no);
    };
    await downloadManager.startProject(project(3));
    expect(h.projectRow.status).toBe("paused");
    expect(count("downloaded")).toBe(13);
    expect(count("failed")).toBe(5);
    expect(lastEnd()).toMatchObject({ ok: false, error: expect.stringMatching(/5 kapitol po sobě selhalo/) });

    h.http.post = async (_u, body) => reader(body.raw_id, body.chapter_no);
    await downloadManager.startProject(project(3));
    expect(h.projectRow.status).toBe("completed");
    expect(count("downloaded")).toBe(60);
  }, 30000);

  it("kapitoly WTR-LAB se nevykreslují ve WKWebView ani při chybě rozhraní", async () => {
    seed(13, 10);
    h.http.post = async (_u, body) => (body.chapter_no === 11 ? ok({ success: true, data: { data: { title: "x" } } }) : reader(body.raw_id, body.chapter_no));
    await downloadManager.startProject(project(3));
    expect(h.render.calls).toEqual([]);
    expect(h.chapters[10]).toMatchObject({ status: "failed", errorKind: "parser" });
    expect(count("downloaded")).toBe(12);
  });

  it("kritická chyba (pád procesu / paměť): stahování se hned pozastaví, kapitola zůstane ve frontě", async () => {
    seed(3138, 10);
    let n = 0;
    h.http.post = async (_u, body) => {
      if (++n === 3) throw Object.assign(new Error("Web content process terminated (possibly out of memory)"), { critical: true });
      return reader(body.raw_id, body.chapter_no);
    };
    await downloadManager.startProject(project(3));
    expect(n).toBe(3); // žádné další pokusy
    expect(h.projectRow.status).toBe("paused");
    expect(count("downloaded")).toBe(12);
    expect(count("failed")).toBe(0);
    expect(h.chapters[12].status).toBe("pending");
    expect(lastEnd()).toMatchObject({ ok: false, error: expect.stringMatching(/kritické chybě.*terminated/) });
  }, 30000);

  it("opakované upozornění na nedostatek paměti stahování pozastaví", async () => {
    seed(3138, 10);
    let served = 0;
    h.http.post = async (_u, body) => {
      if (++served === 3) {
        downloadManager.notifyMemoryWarning();
        downloadManager.notifyMemoryWarning();
      }
      return reader(body.raw_id, body.chapter_no);
    };
    await downloadManager.startProject(project(3));
    expect(served).toBe(3);
    expect(count("downloaded")).toBe(13);
    expect(h.projectRow.status).toBe("paused");
    expect(lastEnd().error).toMatch(/nedostatek paměti/);
  }, 30000);

  it("selhání databáze uprostřed běhu neskončí neobslouženou výjimkou", async () => {
    seed(20, 10);
    const { db } = await import("@/services/db");
    h.http.post = async (_u, body) => {
      if (body.chapter_no === 13) throw new Error("síť");
      return reader(body.raw_id, body.chapter_no);
    };
    (db.updateChapter as any).mockImplementation(async (id: string, patch: any) => {
      if (patch.status === "failed") throw new Error("database is locked");
      const c = h.chapters.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });
    try {
      await expect(downloadManager.startProject(project(3))).resolves.toBeUndefined();
    } finally {
      (db.updateChapter as any).mockImplementation(async (id: string, patch: any) => {
        const c = h.chapters.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
      });
    }
    expect(h.projectRow.status).toBe("paused");
    expect(lastEnd()).toMatchObject({ ok: false, error: expect.stringMatching(/database is locked/) });
    expect(downloadManager.isDownloading("p1")).toBe(false);
  });
});

describe("kapitola jiné knihy se nikdy neuloží", () => {
  it("identityMismatch porovnává jen pole, která odpověď obsahuje", () => {
    const t = { id: "7898", chapter: 11 };
    expect(identityMismatch({ raw_id: 7898, order: 11 }, t)).toBeNull();
    expect(identityMismatch({ raw_id: "7898", chapter_no: "11" }, t)).toBeNull();
    expect(identityMismatch({ title: "x" }, t)).toBeNull();
    expect(identityMismatch(null, t)).toBeNull();
    expect(identityMismatch({ raw_id: 4521, order: 11 }, t)).toMatch(/jiné novele/);
    expect(identityMismatch({ raw_id: 7898, order: 12 }, t)).toMatch(/jiné kapitole/);
  });

  it("rozhraní čtečky vrátí kapitolu jiné novely → neuloží se, žádný soubor nevznikne", async () => {
    seed(12, 10);
    h.http.post = async (_u, body) => (body.chapter_no === 11 ? reader(4521, 11, "Black spear!") : reader(body.raw_id, body.chapter_no));
    await downloadManager.startProject(project(3));
    expect(h.chapters[10].status).toBe("failed");
    expect(h.chapters[10].errorMessage).toMatch(/nepatří k této kapitole.*jiné novele/);
    expect(h.files["NovelForge/projects/p1/c11.html"]).toBeUndefined();
    expect(Object.values(h.files).some((f) => f.includes("Black spear"))).toBe(false);
    expect(h.chapters[11].status).toBe("downloaded");
    expect(h.http.posts.filter((p) => p.body.chapter_no === 11)).toHaveLength(1); // neopakuje se
  });

  it("rozhraní čtečky vrátí jinou kapitolu téže novely → neuloží se", async () => {
    seed(11, 10);
    h.http.post = async (_u, body) => reader(body.raw_id, body.chapter_no + 1);
    await downloadManager.startProject(project(1));
    expect(h.chapters[10].status).toBe("failed");
    expect(h.chapters[10].errorMessage).toMatch(/jiné kapitole/);
    expect(h.files["NovelForge/projects/p1/c11.html"]).toBeUndefined();
  });

});

describe("diagnostický záznam stahování", () => {
  it("zapisuje běh, parser, číslo kapitoly, adresu a výsledek – trvale do souboru", async () => {
    seed(12, 10);
    await downloadManager.startProject(project(3));
    await diag.flush();
    const text = h.diagFiles[DIAG_FILE];
    expect(text).toMatch(/ run-start op=\d+ project="p1" source="wtr-lab\.com"/);
    expect(text).toMatch(/ queue project="p1" parser="wtrlab" total=12 downloaded=10 pending=2 concurrency=1 requested=3 delayMs=0 speed="balanced" translation="ai"/);
    expect(text).toMatch(/ chapter-start op=\d+ project="p1" parser="wtrlab" no="11" index=0 translation="ai" url=https:\/\/wtr-lab\.com\/en\/novel\/7898\/i-created-the-longevity-club\/chapter-11/);
    expect(text).toMatch(/ chapter-end op=\d+ ms=\d+ ok=true attempts=1 bytes=\d+ fetchMs=\d+ cleanMs=\d+ writeMs=\d+ dbMs=\d+/);
    expect(text).toMatch(/ run-end op=\d+ ms=\d+ ok=true/);
    expect(text).not.toContain("Synthetic filler");
    for (const line of text.trim().split("\n")) expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \S+/);
  });
});
