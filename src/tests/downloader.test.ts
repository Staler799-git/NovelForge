import { describe, it, expect, vi, beforeEach } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { downloadManager } from "@/services/downloader";
import type { Project } from "@/types";

type DBChapter = {
  id: string;
  projectId: string;
  title: string;
  url: string;
  orderIndex: number;
  status: string;
  filePath?: string;
  fileSize?: number;
  checksum?: string;
  retryCount?: number;
  errorMessage?: string | null;
};

const chapters: DBChapter[] = [];
const projectRow: Record<string, any> = {};
const files: Record<string, string> = {};
const events: any[] = [];
downloadManager.on((e: any) => events.push(e));

vi.mock("@/services/db", () => ({
  db: {
    init: vi.fn(async () => {}),
    getProject: vi.fn(async () => null),
    getProjects: vi.fn(async () => [{ ...projectRow }]),
    getChapters: vi.fn(async (projectId: string) => chapters.filter((c) => c.projectId === projectId).map((c) => ({ ...c }))),
    getChapterStats: vi.fn(async (projectId: string) => {
      const cs = chapters.filter((c) => c.projectId === projectId);
      return {
        total: cs.length,
        downloaded: cs.filter((c) => c.status === "downloaded").length,
        failed: cs.filter((c) => c.status === "failed").length,
      };
    }),
    updateProject: vi.fn(async (_id: string, patch: any) => {
      Object.assign(projectRow, patch);
    }),
    updateChapter: vi.fn(async (id: string, patch: any) => {
      const c = chapters.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    }),
  },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(async () => {}),
    chapterPath: vi.fn(async (projectId: string, chapterId: string) => `NovelForge/projects/${projectId}/${chapterId}.html`),
    writeFile: vi.fn(async (path: string, data: string) => {
      files[path] = data;
    }),
    fileSize: vi.fn(async (path: string) => (path in files ? files[path].length : null)),
  },
}));

const GOOD = "<p>" + "A plain synthetic sentence standing in for chapter text. ".repeat(6) + "</p>";
type Behaviour = (url: string, opts?: { signal?: AbortSignal }) => Promise<{ title: string; html: string }>;
let behaviour: Behaviour;
vi.mock("@/services/parser/registry", () => ({
  parseChapter: vi.fn((url: string, opts?: any) => behaviour(url, opts)),
}));
import { parseChapter } from "@/services/parser/registry";
import { db } from "@/services/db";

const project = {
  id: "p1",
  title: "Test Book",
  author: "Author",
  language: "en",
  sourceUrl: "https://example.com/novel.html",
  totalChapters: 0,
  downloadedChapters: 0,
  failedChapters: 0,
  status: "idle",
  progress: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  settings: { concurrentRequests: 1, delayMs: 0, maxRetries: 0 },
} as unknown as Project;

function seed(n: number, status = "pending") {
  for (let i = 1; i <= n; i++) {
    chapters.push({ id: `c${i}`, projectId: "p1", title: `Chapter ${i}`, url: `https://example.com/${i}`, orderIndex: i - 1, status });
  }
}
const byId = (id: string) => chapters.find((c) => c.id === id)!;
const end = () => events.filter((e) => e.type === "project-end").at(-1);

beforeEach(() => {
  chapters.length = 0;
  for (const k of Object.keys(projectRow)) delete projectRow[k];
  Object.assign(projectRow, { id: "p1", status: "idle", progress: 0 });
  for (const k of Object.keys(files)) delete files[k];
  events.length = 0;
  behaviour = async (url) => ({ title: "Parsed title", html: GOOD + `<p>marker ${url}</p>` });
  vi.clearAllMocks();
});

describe("download manager", () => {
  it("stáhne všechny kapitoly, uloží je a projekt ukončí jako completed", async () => {
    seed(3);
    await downloadManager.startProject(project);

    expect(parseChapter).toHaveBeenCalledTimes(3);
    expect(parseChapter).toHaveBeenCalledWith("https://example.com/1", expect.objectContaining({ signal: expect.anything() }));
    for (const c of chapters) {
      expect(c.status).toBe("downloaded");
      expect(c.filePath).toBe(`NovelForge/projects/p1/${c.id}.html`);
      expect(c.fileSize).toBe(files[c.filePath!].length);
      expect(c.checksum).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(projectRow.status).toBe("completed");
    expect(projectRow.progress).toBe(100);
    expect(projectRow.downloadedChapters).toBe(3);
    expect(end()).toMatchObject({ ok: true });
  });

  it("databázi inicializuje jen idempotentně a průběh hlásí po každé kapitole", async () => {
    seed(4);
    await downloadManager.startProject(project);
    const progress = events.filter((e) => e.type === "progress");
    expect(progress.map((e) => e.downloaded)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(progress.map((e) => e.progress)).toEqual([0, 25, 50, 75, 100, 100]);
    expect(progress.every((e) => e.total === 4)).toBe(true);
  });

  it("uložený soubor je well-formed XHTML v jazyce projektu", async () => {
    seed(1);
    behaviour = async () => ({ title: "x", html: GOOD + "<p>Tom &amp; Jerry<br>next&nbsp;line <b>unclosed" });
    await downloadManager.startProject(project);
    const file = files["NovelForge/projects/p1/c1.html"];
    expect(XMLValidator.validate(file)).toBe(true);
    expect(file).toContain('xml:lang="en" lang="en"');
    expect(file).not.toContain('lang="cs"');
    expect(file).toContain("<h1>Chapter 1</h1>");
  });

  it("chyba databáze se nezahodí – ohlásí se důvod a projekt se pozastaví", async () => {
    seed(2);
    (db.init as any).mockRejectedValueOnce(new Error("Connection novelforge already exists"));
    await downloadManager.startProject(project);
    expect(parseChapter).not.toHaveBeenCalled();
    expect(end()).toMatchObject({ ok: false, error: expect.stringContaining("Connection novelforge already exists") });
    expect(downloadManager.getLastError("p1")).toMatch(/Stahování selhalo/);
    expect(projectRow.status).toBe("paused");
    expect(downloadManager.isDownloading("p1")).toBe(false);
  });

  it("projekt bez kapitol ohlásí chybu místo tichého 0 %", async () => {
    await downloadManager.startProject(project);
    expect(end()).toMatchObject({ ok: false, error: expect.stringMatching(/žádné kapitoly/) });
  });

  it("chybovou stránku, CAPTCHA ani prázdné HTML neuloží jako úspěch", async () => {
    seed(4);
    behaviour = async (url) => {
      if (url.endsWith("/2")) return { title: "", html: "<p>Oops.</p>" };
      if (url.endsWith("/3")) return { title: "", html: "<div class='g-recaptcha'></div><p>Please verify you are human before you continue to read this page, thank you for your patience today.</p>" };
      if (url.endsWith("/4")) return { title: "", html: "   " };
      return { title: "", html: GOOD };
    };
    await downloadManager.startProject(project);

    expect(byId("c1").status).toBe("downloaded");
    expect(byId("c2")).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/podezřele krátký/) });
    expect(byId("c3")).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/CAPTCHA/) });
    expect(byId("c4")).toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/žádný text/) });
    expect(Object.keys(files)).toEqual(["NovelForge/projects/p1/c1.html"]);
  });

  it("projekt se selhanými kapitolami NENÍ completed", async () => {
    seed(3);
    behaviour = async (url) => {
      if (url.endsWith("/2")) throw Object.assign(new Error("Server vrátil HTTP 404"), { retryable: false });
      return { title: "", html: GOOD };
    };
    await downloadManager.startProject(project);
    expect(projectRow.status).toBe("failed");
    expect(projectRow.downloadedChapters).toBe(2);
    expect(projectRow.failedChapters).toBe(1);
    expect(projectRow.progress).toBe(66);
    expect(byId("c2").errorMessage).toBe("Server vrátil HTTP 404");
    expect(end()).toMatchObject({ ok: false, error: expect.stringMatching(/2\/3 kapitol, 1 selhalo/) });
  });

  it("chybu, kterou nemá smysl opakovat, neopakuje; dočasnou ano", async () => {
    seed(2);
    const calls: Record<string, number> = {};
    behaviour = async (url) => {
      calls[url] = (calls[url] ?? 0) + 1;
      if (url.endsWith("/1")) throw Object.assign(new Error("Server vrátil HTTP 404"), { retryable: false });
      if (calls[url] === 1) throw new Error("Server vrátil HTTP 503");
      return { title: "", html: GOOD };
    };
    await downloadManager.startProject({ ...project, settings: { concurrentRequests: 1, delayMs: 0, maxRetries: 2 } } as Project);
    expect(calls["https://example.com/1"]).toBe(1);
    expect(calls["https://example.com/2"]).toBe(2);
    expect(byId("c2").status).toBe("downloaded");
  }, 10000);

  it("po 5 selháních za sebou zastaví a sdělí konkrétní důvod", async () => {
    seed(40);
    behaviour = async () => {
      throw Object.assign(new Error("Web zablokoval přístup (HTTP 403)"), { retryable: false });
    };
    await downloadManager.startProject(project);
    expect(parseChapter).toHaveBeenCalledTimes(5);
    expect(chapters.filter((c) => c.status === "failed")).toHaveLength(5);
    expect(chapters.filter((c) => c.status === "pending")).toHaveLength(35);
    expect(projectRow.status).toBe("paused");
    expect(end()).toMatchObject({ ok: false, error: expect.stringMatching(/5 kapitol po sobě selhalo.*HTTP 403/) });
    expect(downloadManager.getLastError("p1")).toMatch(/HTTP 403/);
  });

  it("Pause přeruší běh, Resume pokračuje a nic nestahuje dvakrát", async () => {
    seed(6);
    const fetched: string[] = [];
    behaviour = async (url, opts) => {
      if (opts?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      fetched.push(url);
      if (fetched.length === 3) downloadManager.pauseProject("p1");
      return { title: "", html: GOOD };
    };
    await downloadManager.startProject(project);

    expect(projectRow.status).toBe("paused");
    expect(chapters.filter((c) => c.status === "downloaded")).toHaveLength(3);
    expect(chapters.filter((c) => c.status === "pending")).toHaveLength(3);
    expect(chapters.some((c) => c.status === "failed")).toBe(false);
    expect(end()).toMatchObject({ ok: false });
    expect(end().error).toBeUndefined();

    behaviour = async (url) => {
      fetched.push(url);
      return { title: "", html: GOOD };
    };
    await downloadManager.startProject(project);

    expect(fetched).toEqual([1, 2, 3, 4, 5, 6].map((n) => `https://example.com/${n}`));
    expect(projectRow.status).toBe("completed");
    expect(projectRow.progress).toBe(100);
  });

  it("při obnovení přeskočí kapitoly, jejichž soubor na disku sedí", async () => {
    seed(2);
    const path = "NovelForge/projects/p1/c2.html";
    files[path] = "x".repeat(500);
    Object.assign(byId("c2"), { status: "downloaded", filePath: path, fileSize: 500 });
    await downloadManager.startProject(project);
    expect(parseChapter).toHaveBeenCalledTimes(1);
    expect(parseChapter).toHaveBeenCalledWith("https://example.com/1", expect.anything());
    expect(files[path]).toBe("x".repeat(500));
  });

  it("chybějící nebo neúplný soubor 'stažené' kapitoly stáhne znovu", async () => {
    seed(2);
    const path = "NovelForge/projects/p1/c2.html";
    files[path] = "x".repeat(10);
    Object.assign(byId("c2"), { status: "downloaded", filePath: path, fileSize: 500 });
    await downloadManager.startProject(project);
    expect(parseChapter).toHaveBeenCalledTimes(2);
    expect(byId("c2").status).toBe("downloaded");
    expect(files[path].length).toBeGreaterThan(100);
  });

  it("retryFailed zkusí znovu jen selhané kapitoly a smaže starou chybu", async () => {
    seed(2);
    const path = "NovelForge/projects/p1/c2.html";
    files[path] = "x".repeat(500);
    Object.assign(byId("c1"), { status: "failed", errorMessage: "Server vrátil HTTP 503" });
    Object.assign(byId("c2"), { status: "downloaded", filePath: path, fileSize: 500 });
    await downloadManager.retryFailed(project);
    expect(parseChapter).toHaveBeenCalledTimes(1);
    expect(byId("c1").status).toBe("downloaded");
    expect(byId("c1").errorMessage).toBeFalsy();
    expect(projectRow.status).toBe("completed");
  });

  it("po restartu aplikace převede 'downloading' na 'paused'", async () => {
    projectRow.status = "downloading";
    await downloadManager.recoverInterrupted();
    expect(projectRow.status).toBe("paused");
  });
});
