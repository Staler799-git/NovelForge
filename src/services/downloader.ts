import { storage } from "./storage";
import { db } from "./db";
import { parseChapter } from "./parser/registry";
import type { Project, Chapter, DownloadResult } from "@/types";

const SLEEP = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hashString(s: string): string {
  const enc = new TextEncoder();
  const data = enc.encode(s);
  let h = 2166136261 >>> 0;
  for (const b of data) {
    h ^= b;
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export type DownloadEvent =
  | { type: "project-start"; projectId: string }
  | { type: "project-end"; projectId: string; ok: boolean }
  | { type: "chapter-start"; projectId: string; chapterId: string; title: string; index: number; total: number }
  | { type: "chapter-end"; projectId: string; chapterId: string; result: DownloadResult }
  | { type: "progress"; projectId: string; progress: number }
  | { type: "log"; projectId: string; message: string };

export type DownloadOptions = {
  concurrentRequests: number;
  delayMs: number;
  maxRetries: number;
};

export interface CurrentChapter {
  chapterId: string;
  title: string;
}

export class DownloadManager {
  private listeners = new Set<(e: DownloadEvent) => void>();
  private active = new Map<string, AbortController>(); // projectId -> controller
  private runningProjects = new Set<string>();
  private current = new Map<string, CurrentChapter>(); // projectId -> current chapter

  on(event: (e: DownloadEvent) => void): () => void {
    this.listeners.add(event);
    return () => this.listeners.delete(event);
  }

  private emit(e: DownloadEvent): void {
    this.listeners.forEach((cb) => cb(e));
  }

  isDownloading(projectId: string): boolean {
    return this.runningProjects.has(projectId);
  }

  getCurrentChapter(projectId: string): CurrentChapter | undefined {
    return this.current.get(projectId);
  }

  async startProject(project: Project): Promise<void> {
    if (this.runningProjects.has(project.id)) return;
    const controller = new AbortController();
    this.active.set(project.id, controller);
    this.runningProjects.add(project.id);

    try {
      await this.runLoop(project, {
        concurrentRequests: project.settings?.concurrentRequests ?? 3,
        delayMs: project.settings?.delayMs ?? 1500,
        maxRetries: project.settings?.maxRetries ?? 5,
      }, controller.signal);
    } finally {
      this.current.delete(project.id);
      this.runningProjects.delete(project.id);
      this.active.delete(project.id);
    }
  }

  pauseProject(projectId: string): void {
    const ctrl = this.active.get(projectId);
    if (ctrl) ctrl.abort();
  }

  cancelProject(projectId: string): void {
    const ctrl = this.active.get(projectId);
    if (ctrl) ctrl.abort();
  }

  async retryFailed(project: Project): Promise<void> {
    await db.init();
    const chapters = await db.getChapters(project.id);
    const failed = chapters.filter((c) => c.status === "failed");
    if (failed.length === 0) return;
    for (const c of failed) {
      await db.updateChapter(c.id, { status: "pending", errorMessage: undefined, retryCount: 0 });
    }
    await db.updateProject(project.id, { status: "idle", failedChapters: 0 });
    if (!this.runningProjects.has(project.id)) {
      await this.startProject(project);
    }
  }

  private async runLoop(project: Project, opts: DownloadOptions, signal: AbortSignal): Promise<void> {
    await storage.init();
    await db.init();

    const emitProgress = async () => {
      const stats = await db.getChapterStats(project.id);
      const pct = stats.total === 0 ? 0 : Math.round((stats.downloaded / stats.total) * 100);
      await db.updateProject(project.id, { progress: pct });
      this.emit({ type: "progress", projectId: project.id, progress: pct });
    };

    // --- RESUME: verify previously downloaded chapters exist on disk ---
    const chapters = await db.getChapters(project.id);
    for (const ch of chapters) {
      if (ch.status === "downloaded" && ch.filePath) {
        const size = await storage.fileSize(ch.filePath);
        if (size === null || (ch.fileSize !== undefined && size !== ch.fileSize)) {
          this.emit({ type: "log", projectId: project.id, message: `Kapitola ${ch.title}: soubor chybí nebo je neúplný, stahuji znovu` });
          await db.updateChapter(ch.id, { status: "pending", filePath: undefined, fileSize: undefined, checksum: undefined, errorMessage: undefined });
        }
      }
    }

    const updated = await db.getChapters(project.id);
    const pending = updated.filter((c) => c.status === "pending");
    const failed = updated.filter((c) => c.status === "failed");

    const all = [...pending, ...failed];
    if (all.length === 0) {
      await db.updateProject(project.id, { status: "completed", progress: 100 });
      this.emit({ type: "project-end", projectId: project.id, ok: true });
      this.emit({ type: "log", projectId: project.id, message: "Všechny kapitoly jsou stažené." });
      return;
    }

    await db.updateProject(project.id, {
      status: "downloading",
      totalChapters: updated.length,
      failedChapters: failed.length,
    });
    this.emit({ type: "project-start", projectId: project.id });

    const processOne = async (ch: Chapter): Promise<boolean> => {
      if (signal.aborted) return false;
      this.current.set(project.id, { chapterId: ch.id, title: ch.title });

      const attempt = async (): Promise<DownloadResult> => {
        try {
          const parsed = await parseChapter(ch.url, { signal });
          if (signal.aborted) return { chapterId: ch.id, success: false, error: "Přerušeno" };

          const xhtml = chapterToXhtml(parsed.title, parsed.html, project.title, project.author);
          const path = await storage.chapterPath(project.id, ch.id);
          await storage.writeFile(path, xhtml);
          const size = await storage.fileSize(path);
          const checksum = hashString(xhtml);
          await db.updateChapter(ch.id, {
            status: "downloaded",
            filePath: path,
            fileSize: size ?? undefined,
            checksum,
            wordCount: parsed.html.length,
            errorMessage: undefined,
            downloadedAt: new Date().toISOString(),
          });
          this.emit({ type: "log", projectId: project.id, message: `Staženo: ${parsed.title}` });
          await emitProgress();
          return { chapterId: ch.id, success: true, filePath: path, bytes: size ?? 0 };
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          this.emit({ type: "log", projectId: project.id, message: `Chyba u ${ch.title}: ${msg}` });
          return { chapterId: ch.id, success: false, error: msg };
        }
      };

      let result = await attempt();
      let retries = 0;
      while (!result.success && retries < opts.maxRetries && !signal.aborted) {
        retries++;
        await db.updateChapter(ch.id, { retryCount: retries, errorMessage: result.error });
        this.emit({ type: "log", projectId: project.id, message: `Opakování ${retries}/${opts.maxRetries}: ${ch.title}` });
        await SLEEP(opts.delayMs * (retries + 1));
        if (signal.aborted) break;
        result = await attempt();
      }

      if (!result.success) {
        await db.updateChapter(ch.id, { status: "failed", errorMessage: result.error, retryCount: retries });
      }
      this.current.delete(project.id);
      await emitProgress();
      return result.success;
    };

    // Process with concurrency + delay between starts.
    const queue = [...all];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < opts.concurrentRequests; w++) {
      workers.push((async () => {
        while (queue.length > 0 && !signal.aborted) {
          const ch = queue.shift()!;
          if (signal.aborted) break;
          await processOne(ch);
          if (opts.delayMs > 0) await SLEEP(opts.delayMs);
        }
      })());
    }
    await Promise.all(workers);

    if (signal.aborted) {
      await db.updateProject(project.id, { status: "paused" });
      this.emit({ type: "project-end", projectId: project.id, ok: false });
      this.emit({ type: "log", projectId: project.id, message: signal.reason?.toString?.() ?? "Stahování přerušeno." });
      return;
    }

    const final = await db.getChapters(project.id);
    const f = final.filter((c) => c.status === "failed").length;
    const d = final.filter((c) => c.status === "downloaded").length;
    await db.updateProject(project.id, {
      status: "completed",
      downloadedChapters: d,
      failedChapters: f,
    });
    this.emit({ type: "project-end", projectId: project.id, ok: f === 0 });
    this.emit({ type: "log", projectId: project.id, message: `Hotovo: ${d}/${final.length} kapitol${f > 0 ? `, ${f} selhalo` : ""}.` });
  }
}

function chapterToXhtml(title: string, bodyHtml: string, bookTitle: string, author: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="cs" lang="cs">
<head>
  <meta charset="UTF-8"/>
  <title>${esc(title)}</title>
  <link rel="stylesheet" type="text/css" href="../styles.css"/>
</head>
<body>
  <header class="chapter-header"><h1>${esc(title)}</h1><p class="meta">${esc(bookTitle)} — ${esc(author)}</p></header>
  <div class="chapter-body">${bodyHtml}</div>
</body>
</html>`;
}

export const downloadManager = new DownloadManager();

// Chapter as stored in DB (has projectId & status). DB rows come back as Chapter.
