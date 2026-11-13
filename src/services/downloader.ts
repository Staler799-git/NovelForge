import { storage } from "./storage";
import { db } from "./db";
import { parseChapter, parserInfo } from "./parser/registry";
import { diag } from "./diag";
import { onMemoryWarning } from "./render";
import { normalizeLanguage } from "./parser/base";
import { assertChapterContent, contentHash, escapeXml, sanitizeToXhtml } from "./content";
import { stripBoilerplateXhtml } from "./clean";
import { isAbort } from "./http";
import type { Project, Chapter, DownloadResult } from "@/types";

/** Čekání, které se při přerušení (Pause) okamžitě ukončí. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export type DownloadEvent =
  | { type: "project-start"; projectId: string }
  | { type: "project-end"; projectId: string; ok: boolean; error?: string }
  | { type: "chapter-start"; projectId: string; chapterId: string; title: string; index: number; total: number }
  | { type: "chapter-end"; projectId: string; chapterId: string; result: DownloadResult }
  | { type: "progress"; projectId: string; progress: number; downloaded: number; failed: number; total: number }
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

/** Kolik kapitol po sobě smí selhat, než se stahování zastaví s chybou. */
const MAX_CONSECUTIVE_FAILURES = 5;
/** Kolik upozornění systému na nedostatek paměti během okna vede k pozastavení. */
const MEMORY_WARNINGS_TO_PAUSE = 2;
const MEMORY_WINDOW_MS = 120_000;
/** Pauza po upozornění na paměť, než se pokračuje další kapitolou. */
const MEMORY_COOLDOWN_MS = 8000;
/** Nejkratší odstup zápisů průběhu projektu do databáze (kapitoly se ukládají vždy hned). */
const PROGRESS_SAVE_INTERVAL_MS = 2000;

/** Nejvyšší souběžnost, kterou smí stahování dané adresy použít. */
export function effectiveConcurrency(requested: number | undefined, url: string): number {
  const wanted = Math.max(1, Math.floor(requested ?? 1));
  let limit = Number.POSITIVE_INFINITY;
  try {
    limit = parserInfo(url).maxConcurrency;
  } catch {
    /* neznámá adresa – bez omezení parseru */
  }
  return Math.max(1, Math.min(wanted, limit, 4));
}

function safeHost(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

function errorMessage(err: unknown): string {
  const msg = (err as any)?.message ?? String(err);
  return msg && msg !== "undefined" ? msg : "Neznámá chyba";
}

export class DownloadManager {
  private listeners = new Set<(e: DownloadEvent) => void>();
  private active = new Map<string, AbortController>();
  private runningProjects = new Set<string>();
  private current = new Map<string, CurrentChapter>();
  private lastErrors = new Map<string, string>();
  /** Časy upozornění systému na nedostatek paměti. */
  private memoryWarnings: number[] = [];
  private memoryListener: (() => void) | null = null;

  /** Systém ohlásil nedostatek paměti (volá nativní modul; testy přímo). */
  notifyMemoryWarning(): void {
    const now = Date.now();
    this.memoryWarnings = this.memoryWarnings.filter((t) => now - t < MEMORY_WINDOW_MS);
    this.memoryWarnings.push(now);
    diag.log("memory-warning", { count: this.memoryWarnings.length, running: this.runningProjects.size });
  }

  private recentMemoryWarnings(): number {
    const now = Date.now();
    return this.memoryWarnings.filter((t) => now - t < MEMORY_WINDOW_MS).length;
  }

  on(event: (e: DownloadEvent) => void): () => void {
    this.listeners.add(event);
    return () => this.listeners.delete(event);
  }

  private emit(e: DownloadEvent): void {
    this.listeners.forEach((cb) => {
      try {
        cb(e);
      } catch (err) {
        console.error("Download listener failed", err);
      }
    });
  }

  isDownloading(projectId: string): boolean {
    return this.runningProjects.has(projectId);
  }

  getCurrentChapter(projectId: string): CurrentChapter | undefined {
    return this.current.get(projectId);
  }

  /** Důvod, proč se poslední běh projektu zastavil (pokud skončil chybou). */
  getLastError(projectId: string): string | undefined {
    return this.lastErrors.get(projectId);
  }

  /**
   * Spustí / obnoví stahování projektu. Promise se vyřeší až po skončení běhu;
   * UI na ni čekat NEMÁ (průběh hlásí události).
   * Chyba mimo jednotlivé kapitoly (databáze, úložiště) se nezahodí – projekt
   * se pozastaví a důvod se ohlásí událostí project-end.
   */
  async startProject(project: Project): Promise<void> {
    if (this.runningProjects.has(project.id)) return;
    const controller = new AbortController();
    this.active.set(project.id, controller);
    this.runningProjects.add(project.id);
    this.lastErrors.delete(project.id);
    this.memoryWarnings = [];
    if (!this.memoryListener) {
      try {
        this.memoryListener = onMemoryWarning(() => this.notifyMemoryWarning());
      } catch {
        this.memoryListener = () => {};
      }
    }
    const endRun = diag.begin("run", { project: project.id, source: safeHost(project.sourceUrl) });

    try {
      await this.runLoop(project, controller.signal);
      endRun({ ok: true });
    } catch (err) {
      const msg = `Stahování selhalo: ${errorMessage(err)}`;
      endRun({ ok: false, error: errorMessage(err) });
      this.lastErrors.set(project.id, msg);
      try {
        await db.updateProject(project.id, { status: "paused" });
      } catch {
        /* databáze nedostupná – stav zůstane, chybu ale ohlásíme */
      }
      this.emit({ type: "log", projectId: project.id, message: msg });
      this.emit({ type: "project-end", projectId: project.id, ok: false, error: msg });
    } finally {
      this.current.delete(project.id);
      this.runningProjects.delete(project.id);
      this.active.delete(project.id);
    }
  }

  pauseProject(projectId: string): void {
    this.active.get(projectId)?.abort();
  }

  cancelProject(projectId: string): void {
    this.active.get(projectId)?.abort();
  }

  /** Vrátí selhané kapitoly do fronty a spustí stahování. Stažené kapitoly zůstávají. */
  async retryFailed(project: Project): Promise<void> {
    await db.init();
    const chapters = await db.getChapters(project.id);
    for (const c of chapters.filter((c) => c.status === "failed" && !c.excluded)) {
      await db.updateChapter(c.id, { status: "pending", errorMessage: "", retryCount: 0 });
    }
    await db.updateProject(project.id, { status: "idle", failedChapters: 0 });
    if (!this.runningProjects.has(project.id)) {
      await this.startProject(project);
    }
  }

  /**
   * Po restartu aplikace: projekty, které v databázi zůstaly ve stavu
   * "downloading", ve skutečnosti neběží. Označí se jako pozastavené, aby je
   * šlo tlačítkem obnovit – stažené kapitoly se nestahují znovu.
   */
  async recoverInterrupted(): Promise<void> {
    const projects = await db.getProjects();
    for (const p of projects) {
      if (p.status === "downloading" && !this.runningProjects.has(p.id)) {
        // Počty se berou z uložených kapitol – průběh projektu se zapisuje s odstupem
        // a při nečekaném ukončení mohl o kapitolu zaostat.
        const patch: Partial<Project> = { status: "paused" };
        try {
          const stats = await db.getChapterStats(p.id);
          if (stats.total > 0) {
            patch.downloadedChapters = stats.downloaded;
            patch.progress = Math.floor((stats.downloaded / stats.total) * 100);
          }
        } catch {
          /* počty zůstanou, stav se přesto opraví */
        }
        await db.updateProject(p.id, patch);
        diag.log("recovered-interrupted", { project: p.id, downloaded: patch.downloadedChapters });
      }
    }
  }

  private async runLoop(initial: Project, signal: AbortSignal): Promise<void> {
    await storage.init();
    await db.init();

    // Čerstvá metadata (jazyk a název mohl uživatel mezitím upravit).
    const project = (await db.getProject(initial.id)) ?? initial;
    const requested = Math.max(1, project.settings?.concurrentRequests ?? 3);
    const opts: DownloadOptions = {
      concurrentRequests: requested,
      delayMs: Math.max(0, project.settings?.delayMs ?? 1500),
      maxRetries: Math.max(0, project.settings?.maxRetries ?? 5),
    };
    const lang = normalizeLanguage(project.language, "en");

    // --- RESUME: stažené kapitoly musí opravdu existovat na disku ---
    // Vyřazené alternativní verze se nestahují ani nepočítají.
    const chapters = (await db.getChapters(project.id)).filter((c) => !c.excluded);
    for (const ch of chapters) {
      if (signal.aborted) break;
      if (ch.status === "downloaded") {
        const size = ch.filePath ? await storage.fileSize(ch.filePath) : null;
        if (size === null || size === 0 || (ch.fileSize !== undefined && size !== ch.fileSize)) {
          this.emit({ type: "log", projectId: project.id, message: `${ch.title}: soubor chybí nebo je neúplný, stáhne se znovu` });
          await db.updateChapter(ch.id, { status: "pending", filePath: "", fileSize: 0, checksum: "", errorMessage: "" });
          ch.status = "pending";
        }
      } else if (ch.status === "failed") {
        // nový běh = nový pokus
        await db.updateChapter(ch.id, { status: "pending", retryCount: 0 });
        ch.status = "pending";
      }
    }

    // Souběžnost omezuje parser (WTR-LAB: 1). Rozhoduje adresa kapitol, ne jen nastavení projektu.
    const firstUrl = chapters.find((c) => c.status === "pending")?.url ?? chapters[0]?.url ?? project.sourceUrl ?? "";
    opts.concurrentRequests = effectiveConcurrency(requested, firstUrl);
    let parserName = "generic";
    try {
      parserName = parserInfo(firstUrl).name;
    } catch {
      /* neznámá adresa */
    }

    const total = chapters.length;
    let downloaded = chapters.filter((c) => c.status === "downloaded").length;
    let failed = 0;
    const queue = chapters.filter((c) => c.status === "pending");

    const pct = () => (total === 0 ? 0 : Math.floor((downloaded / total) * 100));
    let lastSave = 0;
    let pendingExtra: Partial<Project> = {};
    // Průběh projektu se do databáze zapisuje nejvýše jednou za PROGRESS_SAVE_INTERVAL_MS;
    // změna stavu se zapíše vždy hned. Jednotlivé kapitoly se ukládají okamžitě jinde,
    // takže po pádu se nic neztratí – počty se při dalším spuštění přepočítají z kapitol.
    const saveProgress = async (extra: Partial<Project> = {}) => {
      pendingExtra = { ...pendingExtra, ...extra };
      const now = Date.now();
      if (extra.status !== undefined || now - lastSave >= PROGRESS_SAVE_INTERVAL_MS) {
        lastSave = now;
        const data = pendingExtra;
        pendingExtra = {};
        await db.updateProject(project.id, {
          totalChapters: total,
          downloadedChapters: downloaded,
          failedChapters: failed,
          progress: pct(),
          ...data,
        });
      }
      this.emit({ type: "progress", projectId: project.id, progress: pct(), downloaded, failed, total });
    };

    if (total === 0) {
      throw new Error("Projekt neobsahuje žádné kapitoly ke stažení");
    }

    if (queue.length === 0) {
      await saveProgress({ status: "completed", progress: 100 });
      this.emit({ type: "log", projectId: project.id, message: "Všechny kapitoly jsou stažené." });
      this.emit({ type: "project-end", projectId: project.id, ok: true });
      return;
    }

    await saveProgress({ status: "downloading" });
    this.emit({ type: "project-start", projectId: project.id });
    this.emit({ type: "log", projectId: project.id, message: `Stahuji ${queue.length} kapitol (${downloaded} už hotovo).` });
    if (opts.concurrentRequests < requested) {
      this.emit({ type: "log", projectId: project.id, message: `Tento web se stahuje po ${opts.concurrentRequests === 1 ? "jedné kapitole" : `${opts.concurrentRequests} kapitolách`} (nastaveno ${requested}) – kvůli stabilitě.` });
    }
    diag.log("queue", { project: project.id, parser: parserName, total, downloaded, pending: queue.length, concurrency: opts.concurrentRequests, requested, delayMs: opts.delayMs });

    let consecutiveFailures = 0;
    let successesThisRun = 0;
    let fatal: string | null = null;
    const inner = new AbortController();
    const stop = () => inner.abort();
    signal.addEventListener("abort", stop, { once: true });
    const runSignal = inner.signal;

    const downloadOne = async (ch: Chapter): Promise<DownloadResult> => {
      const parsed = await parseChapter(ch.url, { signal: runSignal });
      // Obsah se ověřuje i zde, nezávisle na parseru: blokace, CAPTCHA ani
      // prázdná stránka se nikdy neuloží jako stažená kapitola.
      const body = stripBoilerplateXhtml(sanitizeToXhtml(parsed.html)).html;
      const { words } = assertChapterContent(body);
      // Katalog odvozený jen z počtu kapitol zná pouze "Chapter N" – skutečný
      // název se doplní ze stránky kapitoly.
      const placeholder = /^(chapter|kapitola)\s*\d+$/i.test(ch.title.trim());
      const better = placeholder && parsed.title && parsed.title.trim().length > ch.title.trim().length && parsed.title.length <= 200;
      const title = better ? parsed.title.trim() : ch.title || parsed.title;
      if (better) ch.title = title;
      const xhtml = chapterToXhtml(title, body, project.title, project.author, lang);
      const path = await storage.chapterPath(project.id, ch.id);
      await storage.writeFile(path, xhtml);
      const size = await storage.fileSize(path);
      if (!size) throw new Error("Kapitolu se nepodařilo uložit do úložiště");
      await db.updateChapter(ch.id, {
        status: "downloaded",
        title,
        filePath: path,
        fileSize: size,
        checksum: contentHash(body),
        wordCount: words,
        errorMessage: "",
        downloadedAt: new Date().toISOString(),
      });
      return { chapterId: ch.id, success: true, filePath: path, bytes: size };
    };

    const processOne = async (ch: Chapter, index: number): Promise<void> => {
      if (runSignal.aborted) return;
      this.current.set(project.id, { chapterId: ch.id, title: ch.title });
      this.emit({ type: "chapter-start", projectId: project.id, chapterId: ch.id, title: ch.title, index, total });

      let result: DownloadResult = { chapterId: ch.id, success: false, error: "Nespuštěno" };
      let attempts = 0;
      const endChapter = diag.begin("chapter", { project: project.id, parser: parserName, no: ch.url.match(/chapter[-_/](\d+)/i)?.[1] ?? String(ch.orderIndex + 1), index, url: ch.url });
      // Dokud v tomto běhu nic neprošlo, zkoušíme každou kapitolu jen krátce –
      // když web blokuje vše, dozví se to uživatel za pár sekund, ne za minuty.
      const maxRetries = () => (successesThisRun === 0 ? Math.min(1, opts.maxRetries) : opts.maxRetries);

      for (;;) {
        attempts++;
        let retryable = true;
        try {
          result = await downloadOne(ch);
        } catch (err: any) {
          if (isAbort(err) || runSignal.aborted) {
            endChapter({ ok: false, error: "pozastaveno" });
            return; // pozastaveno – kapitola zůstává ve frontě
          }
          if (err?.critical === true) {
            // Kritická chyba (pád vykreslovacího procesu, nedostatek paměti): nepokračovat.
            // Kapitola zůstává ve frontě; stažené kapitoly se nemění.
            endChapter({ ok: false, critical: true, error: errorMessage(err) });
            if (!fatal) fatal = `Stahování pozastaveno kvůli kritické chybě: ${errorMessage(err)}. Stažené kapitoly zůstaly uložené; pokračujte tlačítkem Pokračovat.`;
            stop();
            return;
          }
          retryable = err?.retryable !== false;
          result = { chapterId: ch.id, success: false, error: errorMessage(err) };
        }
        if (result.success || !retryable || attempts > maxRetries()) break;
        await db.updateChapter(ch.id, { retryCount: attempts, errorMessage: result.error });
        this.emit({ type: "log", projectId: project.id, message: `${ch.title}: ${result.error} – opakuji (${attempts}/${maxRetries()})` });
        await sleep(Math.min(10000, Math.max(500, opts.delayMs) * attempts), runSignal);
        if (runSignal.aborted) {
          endChapter({ ok: false, error: "pozastaveno" });
          return;
        }
      }
      endChapter({ ok: result.success, attempts, bytes: result.bytes, error: result.success ? undefined : result.error });

      if (result.success) {
        downloaded++;
        successesThisRun++;
        consecutiveFailures = 0;
        await saveProgress({ lastDownloadedChapter: ch.title });
      } else {
        failed++;
        consecutiveFailures++;
        await db.updateChapter(ch.id, { status: "failed", errorMessage: result.error, retryCount: attempts - 1 });
        this.emit({ type: "log", projectId: project.id, message: `Chyba – ${ch.title}: ${result.error}` });
        await saveProgress();
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !fatal) {
          fatal = `Stahování zastaveno: ${consecutiveFailures} kapitol po sobě selhalo. Důvod: ${result.error}`;
          stop();
        }
      }
      this.emit({ type: "chapter-end", projectId: project.id, chapterId: ch.id, result });
    };

    let next = 0;
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(opts.concurrentRequests, queue.length); w++) {
      workers.push(
        (async () => {
          // rozfázování startu, aby požadavky nepřišly ve stejný okamžik
          if (w > 0 && opts.delayMs > 0) await sleep((opts.delayMs / opts.concurrentRequests) * w, runSignal);
          let seenWarnings = this.recentMemoryWarnings();
          while (!runSignal.aborted) {
            // Kontrola paměti před každou kapitolou.
            const warnings = this.recentMemoryWarnings();
            if (warnings >= MEMORY_WARNINGS_TO_PAUSE) {
              if (!fatal) fatal = "Stahování pozastaveno: systém opakovaně hlásí nedostatek paměti. Stažené kapitoly zůstaly uložené; zavřete jiné aplikace a pokračujte tlačítkem Pokračovat.";
              stop();
              break;
            }
            if (warnings > seenWarnings) {
              this.emit({ type: "log", projectId: project.id, message: "Systém hlásí nedostatek paměti – krátká pauza před další kapitolou." });
              await sleep(MEMORY_COOLDOWN_MS, runSignal);
              if (runSignal.aborted) break;
            }
            seenWarnings = warnings;
            const index = next++;
            if (index >= queue.length) break;
            try {
              await processOne(queue[index], index);
            } catch (err) {
              // Chyba mimo stažení kapitoly (databáze, úložiště): ostatní pracovníci se zastaví
              // a běh skončí řízeně pozastavením – žádná neobsloužená výjimka.
              diag.log("worker-error", { project: project.id, error: errorMessage(err) });
              if (!fatal) fatal = `Stahování pozastaveno: ${errorMessage(err)}`;
              stop();
              break;
            }
            if (opts.delayMs > 0) await sleep(opts.delayMs, runSignal);
          }
        })(),
      );
    }
    try {
      await Promise.all(workers);
    } finally {
      signal.removeEventListener("abort", stop);
      this.current.delete(project.id);
    }

    if (fatal) {
      this.lastErrors.set(project.id, fatal);
      diag.log("run-paused", { project: project.id, reason: fatal, downloaded, total });
      await saveProgress({ status: "paused" });
      this.emit({ type: "log", projectId: project.id, message: fatal });
      this.emit({ type: "project-end", projectId: project.id, ok: false, error: fatal });
      return;
    }

    if (signal.aborted) {
      await saveProgress({ status: "paused" });
      this.emit({ type: "log", projectId: project.id, message: `Pozastaveno – staženo ${downloaded} z ${total} kapitol.` });
      this.emit({ type: "project-end", projectId: project.id, ok: false });
      return;
    }

    // Projekt je "dokončený" jen tehdy, když jsou stažené VŠECHNY kapitoly.
    const stats = await db.getChapterStats(project.id);
    downloaded = stats.downloaded;
    failed = stats.failed;
    const allDone = stats.downloaded === stats.total;
    await saveProgress({ status: allDone ? "completed" : failed > 0 ? "failed" : "paused" });
    const summary = allDone
      ? `Hotovo: staženo všech ${stats.total} kapitol.`
      : `Dokončeno s chybami: ${stats.downloaded}/${stats.total} kapitol, ${failed} selhalo.`;
    if (!allDone) this.lastErrors.set(project.id, summary);
    this.emit({ type: "log", projectId: project.id, message: summary });
    this.emit({ type: "project-end", projectId: project.id, ok: allDone, error: allDone ? undefined : summary });
  }
}

/** Uložený soubor kapitoly: well-formed XHTML s jazykem projektu. */
export function chapterToXhtml(title: string, bodyXhtml: string, bookTitle: string, author: string, lang: string): string {
  const l = escapeXml(normalizeLanguage(lang, "en"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${l}" lang="${l}">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="../styles.css"/>
</head>
<body>
  <header class="chapter-header"><h1>${escapeXml(title)}</h1><p class="meta">${escapeXml(bookTitle)}${author ? ` — ${escapeXml(author)}` : ""}</p></header>
  <div class="chapter-body">
${bodyXhtml}
  </div>
</body>
</html>`;
}

export const downloadManager = new DownloadManager();
