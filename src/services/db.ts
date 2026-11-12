import { CapacitorSQLite } from "@capacitor-community/sqlite";
import type { Project, Chapter, ProjectSettings, ChapterStatus, ProjectStatus } from "@/types";
import { hash64 } from "./content";

const DB_NAME = "novelforge";

const DEFAULT_SETTINGS: ProjectSettings = {
  concurrentRequests: 3,
  delayMs: 1500,
  maxRetries: 5,
};

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'cs',
    description TEXT,
    source_url TEXT NOT NULL,
    source_domain TEXT,
    cover_path TEXT,
    total_chapters INTEGER NOT NULL DEFAULT 0,
    downloaded_chapters INTEGER NOT NULL DEFAULT 0,
    failed_chapters INTEGER NOT NULL DEFAULT 0,
    last_downloaded_chapter TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    progress INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_check_at TEXT,
    epub_path TEXT,
    concurrent_requests INTEGER NOT NULL DEFAULT 3,
    delay_ms INTEGER NOT NULL DEFAULT 1500,
    max_retries INTEGER NOT NULL DEFAULT 5
  );`,
  `CREATE TABLE IF NOT EXISTS chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    file_path TEXT,
    file_size INTEGER,
    checksum TEXT,
    word_count INTEGER,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    downloaded_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_chapters_project ON chapters(project_id);
   CREATE INDEX IF NOT EXISTS idx_chapters_status ON chapters(status);
   CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT);`,
];

export interface Database {
  init(): Promise<void>;
  getProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(project: Omit<Project, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Project>;
  updateProject(id: string, patch: Partial<Project> & { settings?: ProjectSettings }): Promise<void>;
  deleteProject(id: string): Promise<void>;
  getChapters(projectId: string): Promise<Chapter[]>;
  getChapter(id: string): Promise<Chapter | null>;
  upsertChapters(projectId: string, chapters: Array<Pick<Chapter, "title" | "url" | "orderIndex">>): Promise<void>;
  updateChapter(id: string, patch: Partial<Chapter>): Promise<void>;
  deleteChapters(projectId: string): Promise<void>;
  getChapterStats(projectId: string): Promise<{ total: number; downloaded: number; failed: number }>;
  close(): Promise<void>;
}

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    title: String(row.title),
    author: String(row.author ?? ""),
    language: String(row.language || "en"),
    description: row.description ? String(row.description) : undefined,
    sourceUrl: String(row.source_url),
    sourceDomain: row.source_domain ? String(row.source_domain) : undefined,
    coverPath: row.cover_path ? String(row.cover_path) : undefined,
    totalChapters: Number(row.total_chapters ?? 0),
    downloadedChapters: Number(row.downloaded_chapters ?? 0),
    failedChapters: Number(row.failed_chapters ?? 0),
    lastDownloadedChapter: row.last_downloaded_chapter ? String(row.last_downloaded_chapter) : undefined,
    status: (row.status ?? "idle") as ProjectStatus,
    progress: Number(row.progress ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastCheckAt: row.last_check_at ? String(row.last_check_at) : undefined,
    epubPath: row.epub_path ? String(row.epub_path) : undefined,
    settings: {
      concurrentRequests: Number(row.concurrent_requests ?? DEFAULT_SETTINGS.concurrentRequests),
      delayMs: Number(row.delay_ms ?? DEFAULT_SETTINGS.delayMs),
      maxRetries: Number(row.max_retries ?? DEFAULT_SETTINGS.maxRetries),
    },
  };
}

function rowToChapter(row: Record<string, unknown>): Chapter {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    url: String(row.url),
    orderIndex: Number(row.order_index ?? 0),
    status: (row.status ?? "pending") as ChapterStatus,
    filePath: row.file_path ? String(row.file_path) : undefined,
    fileSize: row.file_size ? Number(row.file_size) : undefined,
    checksum: row.checksum ? String(row.checksum) : undefined,
    wordCount: row.word_count ? Number(row.word_count) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    retryCount: row.retry_count ? Number(row.retry_count) : 0,
    downloadedAt: row.downloaded_at ? String(row.downloaded_at) : undefined,
  };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/**
 * ID kapitoly = projekt + otisk URL.
 *
 * Dřív bylo ID jen 32bitový otisk URL. Stejná novela přidaná podruhé tak
 * dostala STEJNÁ ID kapitol jako první projekt – `ON CONFLICT(id)` řádky jen
 * přepsal a nechal je patřit starému projektu, takže nový projekt neměl žádné
 * kapitoly. Navíc hrozily kolize 32bitového otisku u tisíců kapitol.
 */
export function chapterId(projectId: string, url: string): string {
  return `${projectId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}-${hash64(url)}`;
}

async function exec(statements: string): Promise<void> {
  await CapacitorSQLite.execute({ database: DB_NAME, statements, transaction: false });
}

/** Zápis (INSERT/UPDATE/DELETE). Chyba SQL se propaguje jako výjimka s textem chyby. */
async function run(sql: string, values: unknown[] = []): Promise<void> {
  await CapacitorSQLite.run({ database: DB_NAME, statement: sql, values, transaction: false });
}

/**
 * Čtení. Na iOS vrací plugin jako PRVNÍ prvek pomocný záznam
 * `{ ios_columns: [...] }` (pořadí sloupců) – ten není datový řádek a musí se
 * odfiltrovat, jinak vznikne "prázdný" projekt/kapitola a počty jsou NaN.
 */
async function query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await CapacitorSQLite.query({ database: DB_NAME, statement: sql, values });
  const rows = (res.values ?? []) as Array<Record<string, unknown>>;
  return rows.filter((r) => r && !Object.prototype.hasOwnProperty.call(r, "ios_columns")) as T[];
}

export class CapacitorDatabase implements Database {
  private ready: Promise<void> | null = null;

  /**
   * Otevře databázi. Volání je IDEMPOTENTNÍ – lze ho volat opakovaně.
   *
   * Nativní `createConnection` při druhém volání vyhodí "Connection novelforge
   * already exists". Dřív se init() volal při startu aplikace a ZNOVU před
   * každým stahováním, takže druhé volání vždy spadlo a stahování se nikdy
   * nerozběhlo (průběh zůstal na 0 %).
   */
  init(): Promise<void> {
    if (!this.ready) {
      this.ready = this.open().catch((err) => {
        this.ready = null; // příští volání to zkusí znovu
        throw err;
      });
    }
    return this.ready;
  }

  private async open(): Promise<void> {
    try {
      await CapacitorSQLite.createConnection({
        database: DB_NAME,
        encrypted: false,
        mode: "no-encryption",
        version: 1,
        readonly: false,
      });
    } catch (err: any) {
      // Spojení přežilo z předchozího načtení WebView – to není chyba.
      if (!/already exists/i.test(String(err?.message ?? err))) throw err;
    }
    await CapacitorSQLite.open({ database: DB_NAME, readonly: false });
    for (const stmt of MIGRATIONS) {
      await exec(stmt);
    }
  }

  async getProjects(): Promise<Project[]> {
    const rows = await query("SELECT * FROM projects ORDER BY updated_at DESC");
    return rows.map(rowToProject);
  }

  async getProject(id: string): Promise<Project | null> {
    const rows = await query("SELECT * FROM projects WHERE id = ?", [id]);
    if (!rows.length) return null;
    return rowToProject(rows[0]);
  }

  async createProject(project: Omit<Project, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Project> {
    const id = project.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const s = project.settings ?? DEFAULT_SETTINGS;
    await run(
      `INSERT INTO projects (id, title, author, language, description, source_url, source_domain,
        cover_path, total_chapters, downloaded_chapters, failed_chapters, last_downloaded_chapter,
        status, progress, created_at, updated_at, last_check_at, epub_path,
        concurrent_requests, delay_ms, max_retries)
       VALUES (${placeholders(21)})`,
      [
        id,
        project.title,
        project.author,
        project.language,
        project.description ?? null,
        project.sourceUrl,
        project.sourceDomain ?? null,
        project.coverPath ?? null,
        project.totalChapters,
        project.downloadedChapters,
        project.failedChapters,
        project.lastDownloadedChapter ?? null,
        project.status,
        project.progress,
        now,
        now,
        project.lastCheckAt ?? null,
        project.epubPath ?? null,
        s.concurrentRequests,
        s.delayMs,
        s.maxRetries,
      ]
    );
    return { id, ...project, createdAt: now, updatedAt: now, settings: s } as Project;
  }

  async updateProject(id: string, patch: Partial<Project> & { settings?: ProjectSettings }): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (key: string, value: unknown) => {
      fields.push(`${key} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.author !== undefined) set("author", patch.author);
    if (patch.language !== undefined) set("language", patch.language);
    if (patch.description !== undefined) set("description", patch.description ?? null);
    if (patch.sourceUrl !== undefined) set("source_url", patch.sourceUrl);
    if (patch.sourceDomain !== undefined) set("source_domain", patch.sourceDomain ?? null);
    if (patch.coverPath !== undefined) set("cover_path", patch.coverPath ?? null);
    if (patch.totalChapters !== undefined) set("total_chapters", patch.totalChapters);
    if (patch.downloadedChapters !== undefined) set("downloaded_chapters", patch.downloadedChapters);
    if (patch.failedChapters !== undefined) set("failed_chapters", patch.failedChapters);
    if (patch.lastDownloadedChapter !== undefined)
      set("last_downloaded_chapter", patch.lastDownloadedChapter ?? null);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.progress !== undefined) set("progress", patch.progress);
    if (patch.lastCheckAt !== undefined) set("last_check_at", patch.lastCheckAt ?? null);
    if (patch.epubPath !== undefined) set("epub_path", patch.epubPath ?? null);
    if (patch.settings) {
      set("concurrent_requests", patch.settings.concurrentRequests);
      set("delay_ms", patch.settings.delayMs);
      set("max_retries", patch.settings.maxRetries);
    }
    if (!fields.length) return;
    set("updated_at", new Date().toISOString());
    values.push(id);
    await run(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  async deleteProject(id: string): Promise<void> {
    // Kapitoly mažeme výslovně – ON DELETE CASCADE platí jen se zapnutými cizími klíči.
    await run("DELETE FROM chapters WHERE project_id = ?", [id]);
    await run("DELETE FROM projects WHERE id = ?", [id]);
  }

  async getChapters(projectId: string): Promise<Chapter[]> {
    const rows = await query(
      "SELECT * FROM chapters WHERE project_id = ? ORDER BY order_index ASC, id ASC",
      [projectId]
    );
    return rows.map(rowToChapter);
  }

  async getChapter(id: string): Promise<Chapter | null> {
    const rows = await query("SELECT * FROM chapters WHERE id = ?", [id]);
    if (!rows.length) return null;
    return rowToChapter(rows[0]);
  }

  /**
   * Vloží kapitoly projektu po dávkách (jeden INSERT na 80 řádků).
   * Tisíce kapitol by po jedné znamenaly tisíce volání nativního mostu.
   * Stav už stažených kapitol se při opakovaném vložení NEMĚNÍ.
   */
  async upsertChapters(
    projectId: string,
    chapters: Array<Pick<Chapter, "title" | "url" | "orderIndex">>
  ): Promise<void> {
    const BATCH = 80;
    for (let i = 0; i < chapters.length; i += BATCH) {
      const batch = chapters.slice(i, i + BATCH);
      const values: unknown[] = [];
      for (const ch of batch) {
        values.push(chapterId(projectId, ch.url), projectId, ch.title, ch.url, ch.orderIndex);
      }
      await run(
        `INSERT INTO chapters (id, project_id, title, url, order_index, status)
         VALUES ${batch.map(() => "(?,?,?,?,?,'pending')").join(",")}
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, order_index=excluded.order_index`,
        values
      );
    }
  }

  async updateChapter(id: string, patch: Partial<Chapter>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (key: string, value: unknown) => {
      fields.push(`${key} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) set("title", patch.title);
    if (patch.url !== undefined) set("url", patch.url);
    if (patch.orderIndex !== undefined) set("order_index", patch.orderIndex);
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.filePath !== undefined) set("file_path", patch.filePath ?? null);
    if (patch.fileSize !== undefined) set("file_size", patch.fileSize ?? null);
    if (patch.checksum !== undefined) set("checksum", patch.checksum ?? null);
    if (patch.wordCount !== undefined) set("word_count", patch.wordCount ?? null);
    if (patch.errorMessage !== undefined) set("error_message", patch.errorMessage ?? null);
    if (patch.retryCount !== undefined) set("retry_count", patch.retryCount);
    if (patch.downloadedAt !== undefined) set("downloaded_at", patch.downloadedAt ?? null);
    if (!fields.length) return;
    values.push(id);
    await run(`UPDATE chapters SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  async deleteChapters(projectId: string): Promise<void> {
    await run("DELETE FROM chapters WHERE project_id = ?", [projectId]);
  }

  async getChapterStats(projectId: string): Promise<{ total: number; downloaded: number; failed: number }> {
    const rows = await query(
      `SELECT status, COUNT(*) as c FROM chapters WHERE project_id = ? GROUP BY status`,
      [projectId]
    );
    let total = 0,
      downloaded = 0,
      failed = 0;
    for (const r of rows) {
      const c = Number(r.c);
      total += c;
      if (r.status === "downloaded") downloaded += c;
      else if (r.status === "failed") failed += c;
    }
    return { total, downloaded, failed };
  }

  async close(): Promise<void> {
    try {
      await CapacitorSQLite.close({ database: DB_NAME });
    } catch {
      /* ignore */
    }
    try {
      await CapacitorSQLite.closeConnection({ database: DB_NAME });
    } catch {
      /* ignore */
    }
    this.ready = null;
  }
}

export const db = new CapacitorDatabase();
