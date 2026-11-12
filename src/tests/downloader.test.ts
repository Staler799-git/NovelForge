import { describe, it, expect, vi, beforeEach } from "vitest";
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
  errorMessage?: string | null;
};

const chapters: DBChapter[] = [];
let projectStatus = "idle";
let projectProgress = 0;
const storageSizes: Record<string, number | null> = {};
const events: any[] = [];
downloadManager.on((e: any) => events.push(e));

vi.mock("@/services/db", () => ({
  db: {
    init: vi.fn(),
    getChapters: vi.fn(async (projectId: string) => chapters.filter((c) => c.projectId === projectId)),
    getChapterStats: vi.fn(async (projectId: string) => {
      const cs = chapters.filter((c) => c.projectId === projectId);
      return {
        total: cs.length,
        downloaded: cs.filter((c) => c.status === "downloaded").length,
        failed: cs.filter((c) => c.status === "failed").length,
      };
    }),
    updateProject: vi.fn(async (_id: string, patch: any) => {
      if (patch.status !== undefined) projectStatus = patch.status;
      if (patch.progress !== undefined) projectProgress = patch.progress;
    }),
    updateChapter: vi.fn(async (_id: string, patch: any) => {
      const c = chapters.find((x) => x.id === _id);
      if (c) Object.assign(c, patch);
    }),
  },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(),
    chapterPath: vi.fn((projectId: string, chapterId: string) => `NovelForge/projects/${projectId}/${chapterId}.html`),
    writeFile: vi.fn(),
    fileSize: vi.fn(async (path: string) => storageSizes[path] ?? null),
  },
}));
vi.mock("@/services/parser/registry", () => ({
  parseChapter: vi.fn(async (_url: string) => ({ title: "Kapitola z testu", html: "<p>obsah kapitoly</p>" })),
}));
import { parseChapter } from "@/services/parser/registry";

const project = {
  id: "p1",
  title: "Testní kniha",
  author: "Autor",
  language: "cs",
  sourceUrl: "https://example.com/novel.html",
  totalChapters: 0,
  downloadedChapters: 0,
  failedChapters: 0,
  status: "idle",
  progress: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  settings: { concurrentRequests: 2, delayMs: 0, maxRetries: 1 },
} as unknown as Project;

beforeEach(() => {
  chapters.length = 0;
  projectStatus = "idle";
  projectProgress = 0;
  Object.keys(storageSizes).forEach((k) => delete storageSizes[k]);
  events.length = 0;
  vi.clearAllMocks();
});

describe("download manager", () => {
  it("stáhne všechny čekající kapitoly a projekt ukončí jako completed", async () => {
    chapters.push(
      { id: "c1", projectId: "p1", title: "Kapitola 1", url: "https://example.com/1", orderIndex: 0, status: "pending" },
      { id: "c2", projectId: "p1", title: "Kapitola 2", url: "https://example.com/2", orderIndex: 1, status: "pending" }
    );

    await downloadManager.startProject(project);

    expect(parseChapter).toHaveBeenCalledTimes(2);
    const c1 = chapters.find((c) => c.id === "c1")!;
    const c2 = chapters.find((c) => c.id === "c2")!;
    expect(c1.status).toBe("downloaded");
    expect(c2.status).toBe("downloaded");
    expect(c1.filePath).toBeDefined();
    expect(projectStatus).toBe("completed");
    expect(projectProgress).toBe(100);
    expect(events.some((e) => e.type === "project-end" && e.ok === true)).toBe(true);
  });

  it("při obnovení přeskočí kapitoly, jejichž soubor na disku sedí", async () => {
    storageSizes[`NovelForge/projects/p1/c2.html`] = 500;
    chapters.push(
      { id: "c1", projectId: "p1", title: "Kapitola 1", url: "https://example.com/1", orderIndex: 0, status: "pending" },
      {
        id: "c2",
        projectId: "p1",
        title: "Kapitola 2",
        url: "https://example.com/2",
        orderIndex: 1,
        status: "downloaded",
        filePath: `NovelForge/projects/p1/c2.html`,
        fileSize: 500,
      }
    );

    await downloadManager.startProject(project);

    expect(parseChapter).toHaveBeenCalledTimes(1);
    expect(parseChapter).toHaveBeenCalledWith("https://example.com/1", expect.anything());
    const c2 = chapters.find((c) => c.id === "c2")!;
    expect(c2.status).toBe("downloaded");
    expect(c2.filePath).toBe(`NovelForge/projects/p1/c2.html`);
  });

  it("při chybějícím nebo neúplném souboru u 'downloaded' kapitoly ji stáhne znovu", async () => {
    storageSizes[`NovelForge/projects/p1/c2.html`] = 10;
    chapters.push(
      { id: "c1", projectId: "p1", title: "Kapitola 1", url: "https://example.com/1", orderIndex: 0, status: "pending" },
      {
        id: "c2",
        projectId: "p1",
        title: "Kapitola 2",
        url: "https://example.com/2",
        orderIndex: 1,
        status: "downloaded",
        filePath: `NovelForge/projects/p1/c2.html`,
        fileSize: 500,
      }
    );

    await downloadManager.startProject(project);

    expect(parseChapter).toHaveBeenCalledTimes(2);
  });

  it("retryFailed resetuje selhané kapitoly na pending a spustí je", async () => {
    chapters.push(
      { id: "c1", projectId: "p1", title: "Kapitola 1", url: "https://example.com/1", orderIndex: 0, status: "failed", errorMessage: "timeout" },
      { id: "c2", projectId: "p1", title: "Kapitola 2", url: "https://example.com/2", orderIndex: 1, status: "downloaded" }
    );

    await downloadManager.retryFailed(project);
    expect(chapters.find((c) => c.id === "c1")!.errorMessage).toBeUndefined();
    expect(chapters.find((c) => c.id === "c1")!.status).toBe("downloaded");
  });
});
