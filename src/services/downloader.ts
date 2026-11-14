import { storage } from "./storage";
import { db } from "./db";
import { parseChapter, parserInfo, type ParserInfo } from "./parser/registry";
import { accessKindOf, pauseMessage, statusForAccess, type AccessKind } from "./access";
import { AdaptivePace, RunStats, basePace, normalizeSpeedMode } from "./speed";
import { beginBackgroundWork, endBackgroundWork, unmetCondition } from "./device";
import { diag } from "./diag";
import { onMemoryWarning } from "./render";
import { normalizeLanguage } from "./parser/base";
import { assertChapterContent, contentHash, escapeXml, sanitizeToXhtml } from "./content";
import { stripBoilerplateXhtml } from "./clean";
import { isAbort } from "./http";
import type { Project, Chapter, DownloadResult, SpeedMode } from "@/types";

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
/** Kolik kapitol po sobě smí web odmítnout (HTTP 403), než se stahování zastaví. */
const MAX_CONSECUTIVE_FORBIDDEN = 2;
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
  private views = new Map<string, RunView>();
  private appActive = true;
  private backgroundedAt = 0;
  private activatedAt = 0;
  private activeWaiters: Array<() => void> = [];
  /** Základ čekání po HTTP 429 a interval kontroly podmínek (testy je zkracují). */
  rateLimitBackoffMs = 5000;
  conditionPollMs = 5000;

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
          await db.updateChapter(ch.id, { status: "pending", filePath: "", fileSize: 0, checksum: "", errorMessage: "", translationMode: "" });
          ch.status = "pending";
          ch.translationMode = undefined;
        }
      } else if (ch.status === "failed") {
        // nový běh = nový pokus
        await db.updateChapter(ch.id, { status: "pending", retryCount: 0 });
        ch.status = "pending";
      }
    }

    // Limity zdroje určuje parser podle adresy kapitol, ne jen nastavení projektu.
    const firstUrl = chapters.find((c) => c.status === "pending")?.url ?? chapters[0]?.url ?? project.sourceUrl ?? "";
    let info: ParserInfo = { name: "generic", maxConcurrency: Number.POSITIVE_INFINITY, allowFast: true, minIntervalMs: 0, translationModes: [] };
    try {
      info = { ...info, ...parserInfo(firstUrl) };
    } catch {
      /* neznámá adresa – bez omezení parseru */
    }
    const parserName = info.name;
    const site = siteLabel(firstUrl);
    const requestedSpeed = normalizeSpeedMode(project.settings?.speedMode);
    const pace = new AdaptivePace(basePace(requestedSpeed, { concurrentRequests: requested, delayMs: opts.delayMs }, info), this.rateLimitBackoffMs);
    opts.concurrentRequests = pace.base.concurrency;

    // --- Překlad: projekt používá právě jeden; nikdy se nemíchá automaticky ---
    let mode: string | undefined;
    if (info.translationModes.length > 0) {
      const known = (m: string | undefined) => (m && info.translationModes.some((x) => x.id === m) ? m : undefined);
      mode = known(project.settings?.translationMode);
      if (!mode) {
        // Projekt ze starší verze: ta stahovala jediný (výchozí) překlad.
        mode = known(info.legacyTranslationMode) ?? info.translationModes[0].id;
        await db.updateProject(project.id, { settings: { concurrentRequests: requested, delayMs: opts.delayMs, maxRetries: opts.maxRetries, translationMode: mode } });
        this.emit({ type: "log", projectId: project.id, message: `Projekt neměl evidovaný překlad – nastaven ${modeName(info, mode)} (ten stahovaly starší verze).` });
      }
      // Kapitoly stažené starší verzí nemají překlad evidovaný – doplní se výchozí.
      const legacy = known(info.legacyTranslationMode);
      if (legacy) {
        for (const ch of chapters) {
          if (ch.status === "downloaded" && !ch.translationMode) {
            await db.updateChapter(ch.id, { translationMode: legacy });
            ch.translationMode = legacy;
          }
        }
      }
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
      await saveProgress({ status: "completed", progress: 100, accessKind: "", accessMessage: "" });
      this.emit({ type: "log", projectId: project.id, message: "Všechny kapitoly jsou stažené." });
      this.emit({ type: "project-end", projectId: project.id, ok: true });
      return;
    }

    const stats = new RunStats();
    const view: RunView = {
      speedMode: requestedSpeed,
      effectiveSpeedMode: pace.base.mode,
      concurrency: pace.concurrency,
      delayMs: pace.delayMs,
      translationMode: mode,
      translationLabel: mode ? modeName(info, mode) : undefined,
      perMinute: 0,
      avgChapterMs: 0,
      etaMs: null,
      waiting: null,
      slowdowns: 0,
    };
    this.views.set(project.id, view);
    const refreshView = () => {
      view.concurrency = pace.concurrency;
      view.delayMs = pace.delayMs;
      view.perMinute = stats.perMinute();
      view.avgChapterMs = stats.avgChapterMs;
      view.etaMs = stats.etaMs(total - downloaded - failed);
      view.slowdowns = pace.slowdowns;
    };

    await saveProgress({ status: "downloading", accessKind: "", accessMessage: "" });
    this.emit({ type: "project-start", projectId: project.id });
    this.emit({ type: "log", projectId: project.id, message: `Stahuji ${queue.length} kapitol (${downloaded} už hotovo).` });
    if (pace.base.concurrency < requested && requestedSpeed !== "eco") {
      this.emit({ type: "log", projectId: project.id, message: `Tento web se stahuje po ${pace.base.concurrency === 1 ? "jedné kapitole" : `${pace.base.concurrency} kapitolách`} (nastaveno ${requested}) – kvůli stabilitě.` });
    }
    if (requestedSpeed === "fast" && pace.base.mode !== "fast") {
      this.emit({ type: "log", projectId: project.id, message: "Rychlý režim tento web nedovoluje – použije se vyvážený." });
    }
    if (mode) this.emit({ type: "log", projectId: project.id, message: `Překlad: ${modeName(info, mode)}.` });
    diag.log("queue", {
      project: project.id, parser: parserName, total, downloaded, pending: queue.length,
      concurrency: pace.concurrency, requested, delayMs: pace.delayMs, speed: pace.base.mode, translation: mode,
    });

    let consecutiveFailures = 0;
    let consecutiveForbidden = 0;
    let successesThisRun = 0;
    let fatal: string | null = null;
    let fatalStatus: Project["status"] = "paused";
    let fatalKind = "";
    const inner = new AbortController();
    const stop = () => inner.abort();
    signal.addEventListener("abort", stop, { once: true });
    const runSignal = inner.signal;
    const halt = (message: string, status: Project["status"] = "paused", kind = "") => {
      if (!fatal) {
        fatal = message;
        fatalStatus = status;
        fatalKind = kind;
      }
      stop();
    };

    const downloadOne = async (ch: Chapter): Promise<DownloadResult & { steps: StepTimes }> => {
      const t0 = Date.now();
      const parsed = await parseChapter(ch.url, { signal: runSignal, translationMode: mode });
      // Projekt eviduje jeden překlad – text v jiném se nikdy neuloží.
      if (mode && parsed.translationMode && parsed.translationMode !== mode) {
        throw Object.assign(new Error(`Zdroj vrátil jiný překlad (${parsed.translationMode}), než projekt používá (${mode}). Kapitola se neuložila.`), { retryable: false, kind: "parser" });
      }
      const t1 = Date.now();
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
      const t2 = Date.now();
      let path: string;
      let size: number | null;
      try {
        path = await storage.chapterPath(project.id, ch.id);
        await storage.writeFile(path, xhtml);
        size = await storage.fileSize(path);
      } catch (err) {
        throw Object.assign(new Error(`Kapitolu se nepodařilo uložit do úložiště: ${errorMessage(err)}`), { kind: "storage", retryable: false });
      }
      if (!size) throw Object.assign(new Error("Kapitolu se nepodařilo uložit do úložiště"), { kind: "storage", retryable: false });
      const t3 = Date.now();
      await db.updateChapter(ch.id, {
        status: "downloaded",
        title,
        filePath: path,
        fileSize: size,
        checksum: contentHash(body),
        wordCount: words,
        errorMessage: "",
        errorKind: "",
        translationMode: mode ?? "",
        downloadedAt: new Date().toISOString(),
      });
      const t4 = Date.now();
      return { chapterId: ch.id, success: true, filePath: path, bytes: size, steps: { fetch: t1 - t0, clean: t2 - t1, write: t3 - t2, db: t4 - t3 } };
    };

    const processOne = async (ch: Chapter, index: number): Promise<void> => {
      if (runSignal.aborted) return;
      this.current.set(project.id, { chapterId: ch.id, title: ch.title });
      this.emit({ type: "chapter-start", projectId: project.id, chapterId: ch.id, title: ch.title, index, total });

      let result: DownloadResult = { chapterId: ch.id, success: false, error: "Nespuštěno" };
      let kind: AccessKind | null = null;
      let steps: StepTimes = { fetch: 0, clean: 0, write: 0, db: 0 };
      let attempts = 0;
      const startedAt = Date.now();
      const endChapter = diag.begin("chapter", { project: project.id, parser: parserName, no: ch.url.match(/chapter[-_/](\d+)/i)?.[1] ?? String(ch.orderIndex + 1), index, translation: mode, url: ch.url });
      // Dokud v tomto běhu nic neprošlo, zkoušíme každou kapitolu jen krátce –
      // když web blokuje vše, dozví se to uživatel za pár sekund, ne za minuty.
      const maxRetries = () => (successesThisRun === 0 ? Math.min(1, opts.maxRetries) : opts.maxRetries);

      for (;;) {
        attempts++;
        let retryable = true;
        const attemptStart = Date.now();
        try {
          const r = await downloadOne(ch);
          steps = r.steps;
          result = r;
          kind = null;
        } catch (err: any) {
          if (isAbort(err) || runSignal.aborted) {
            endChapter({ ok: false, error: "pozastaveno" });
            return; // pozastaveno – kapitola zůstává ve frontě
          }
          kind = accessKindOf(err);
          const message = errorMessage(err);
          if (err?.critical === true) {
            // Kritická chyba (pád vykreslovacího procesu, nedostatek paměti): nepokračovat.
            endChapter({ ok: false, critical: true, error: message });
            halt(`Stahování pozastaveno kvůli kritické chybě: ${message}. Stažené kapitoly zůstaly uložené; pokračujte tlačítkem Pokračovat.`);
            return;
          }
          // Aplikace byla na pozadí (iOS přeruší síť) – není to chyba kapitoly.
          if (this.interruptedByBackground(attemptStart)) {
            attempts--;
            diag.log("chapter-retry-after-background", { project: project.id, error: message });
            await this.waitUntilActive(runSignal);
            if (runSignal.aborted) {
              endChapter({ ok: false, error: "pozastaveno" });
              return;
            }
            continue;
          }
          if (err?.stopSource === true || kind === "storage") {
            // Přístupová překážka nebo chyba úložiště: kapitola zůstává ve frontě
            // a na zdroj se neposílají žádné další požadavky.
            await db.updateChapter(ch.id, { errorMessage: message, errorKind: kind ?? "" });
            endChapter({ ok: false, blocked: kind ?? "stop", error: message });
            if (kind === "storage") halt(`Stahování pozastaveno: ${message}. Zkontrolujte volné místo v zařízení.`, "paused", "storage");
            else halt(pauseMessage(site, kind!, message), statusForAccess(kind!), kind!);
            return;
          }
          if (kind === "rate-limited") {
            const wait = pace.onRateLimit(err?.retryAfterMs);
            refreshView();
            if (wait === null) {
              await db.updateChapter(ch.id, { errorMessage: message, errorKind: kind });
              endChapter({ ok: false, blocked: kind, error: message });
              halt(pauseMessage(site, kind, message), "rate-limited", kind);
              return;
            }
            attempts--;
            this.emit({ type: "log", projectId: project.id, message: `${message} Čekám ${Math.ceil(wait / 1000)} s a zpomaluji.` });
            diag.log("rate-limit-wait", { project: project.id, waitMs: wait, retryAfterMs: err?.retryAfterMs, delayMs: pace.delayMs });
            view.waiting = "Web omezil počet požadavků – čeká se";
            await sleep(wait, runSignal);
            view.waiting = null;
            if (runSignal.aborted) {
              endChapter({ ok: false, error: "pozastaveno" });
              return;
            }
            continue;
          }
          retryable = err?.retryable !== false;
          result = { chapterId: ch.id, success: false, error: message };
        }
        if (result.success || !retryable || attempts > maxRetries()) break;
        await db.updateChapter(ch.id, { retryCount: attempts, errorMessage: result.error, errorKind: kind ?? "" });
        this.emit({ type: "log", projectId: project.id, message: `${ch.title}: ${result.error} – opakuji (${attempts}/${maxRetries()})` });
        await sleep(Math.min(10000, Math.max(500, opts.delayMs) * attempts), runSignal);
        if (runSignal.aborted) {
          endChapter({ ok: false, error: "pozastaveno" });
          return;
        }
      }
      endChapter({
        ok: result.success, attempts, bytes: result.bytes,
        fetchMs: result.success ? steps.fetch : undefined, cleanMs: result.success ? steps.clean : undefined,
        writeMs: result.success ? steps.write : undefined, dbMs: result.success ? steps.db : undefined,
        kind: result.success ? undefined : (kind ?? undefined), error: result.success ? undefined : result.error,
      });

      if (result.success) {
        downloaded++;
        successesThisRun++;
        consecutiveFailures = 0;
        consecutiveForbidden = 0;
        pace.onSuccess();
        stats.record(Date.now() - startedAt, steps);
        refreshView();
        await saveProgress({ lastDownloadedChapter: ch.title });
      } else {
        failed++;
        consecutiveFailures++;
        consecutiveForbidden = kind === "forbidden" ? consecutiveForbidden + 1 : 0;
        await db.updateChapter(ch.id, { status: "failed", errorMessage: result.error, errorKind: kind ?? "", retryCount: attempts - 1 });
        this.emit({ type: "log", projectId: project.id, message: `Chyba – ${ch.title}: ${result.error}` });
        refreshView();
        await saveProgress();
        if (consecutiveForbidden >= MAX_CONSECUTIVE_FORBIDDEN) {
          halt(pauseMessage(site, "forbidden", result.error ?? ""), "paused", "forbidden");
        } else if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          halt(`Stahování zastaveno: ${consecutiveFailures} kapitol po sobě selhalo. Důvod: ${result.error}`, "paused", kind ?? "");
        }
      }
      this.emit({ type: "chapter-end", projectId: project.id, chapterId: ch.id, result });
    };

    /** Podmínky projektu (Wi-Fi, nabíjení) a běh na pozadí – čeká, dokud nejsou splněné. */
    const waitForConditions = async (): Promise<void> => {
      for (;;) {
        if (runSignal.aborted) return;
        if (!this.appActive) {
          view.waiting = "Aplikace je na pozadí – iOS stahování pozastavil";
          this.emit({ type: "progress", projectId: project.id, progress: pct(), downloaded, failed, total });
          await this.waitUntilActive(runSignal);
          view.waiting = null;
          continue;
        }
        let reason: string | null = null;
        try {
          reason = await unmetCondition(project.settings);
        } catch {
          reason = null;
        }
        if (!reason) {
          if (view.waiting) {
            view.waiting = null;
            this.emit({ type: "log", projectId: project.id, message: "Podmínky splněny – pokračuji." });
          }
          return;
        }
        if (view.waiting !== reason) {
          view.waiting = reason;
          this.emit({ type: "log", projectId: project.id, message: `${reason} – čekám.` });
          diag.log("waiting-condition", { project: project.id, reason });
          this.emit({ type: "progress", projectId: project.id, progress: pct(), downloaded, failed, total });
        }
        await sleep(this.conditionPollMs, runSignal);
      }
    };

    let next = 0;
    const workers: Promise<void>[] = [];
    const maxWorkers = Math.min(pace.base.concurrency, queue.length);
    for (let w = 0; w < maxWorkers; w++) {
      workers.push(
        (async () => {
          // rozfázování startu, aby požadavky nepřišly ve stejný okamžik
          if (w > 0 && pace.delayMs > 0) await sleep((pace.delayMs / maxWorkers) * w, runSignal);
          let seenWarnings = this.recentMemoryWarnings();
          while (!runSignal.aborted) {
            // Adaptivní souběžnost: po zpomalení pracují jen první pracovníci.
            if (w >= pace.concurrency) {
              await sleep(1000, runSignal);
              continue;
            }
            // Kontrola paměti před každou kapitolou.
            const warnings = this.recentMemoryWarnings();
            if (warnings >= MEMORY_WARNINGS_TO_PAUSE) {
              halt("Stahování pozastaveno: systém opakovaně hlásí nedostatek paměti. Stažené kapitoly zůstaly uložené; zavřete jiné aplikace a pokračujte tlačítkem Pokračovat.");
              break;
            }
            if (warnings > seenWarnings) {
              this.emit({ type: "log", projectId: project.id, message: "Systém hlásí nedostatek paměti – krátká pauza před další kapitolou." });
              await sleep(MEMORY_COOLDOWN_MS, runSignal);
              if (runSignal.aborted) break;
            }
            seenWarnings = warnings;
            await waitForConditions();
            if (runSignal.aborted) break;
            const index = next++;
            if (index >= queue.length) break;
            const started = Date.now();
            try {
              await processOne(queue[index], index);
            } catch (err) {
              // Chyba mimo stažení kapitoly (databáze, úložiště): ostatní pracovníci se zastaví
              // a běh skončí řízeně pozastavením – žádná neobsloužená výjimka.
              diag.log("worker-error", { project: project.id, error: errorMessage(err) });
              halt(`Stahování pozastaveno: ${errorMessage(err)}`);
              break;
            }
            // Odstup se počítá od ZAČÁTKU kapitoly – doba požadavku se nepřičítá navíc.
            const wait = pace.delayMs - (Date.now() - started);
            if (wait > 0) await sleep(wait, runSignal);
          }
        })(),
      );
    }
    try {
      await Promise.all(workers);
    } finally {
      signal.removeEventListener("abort", stop);
      this.current.delete(project.id);
      view.waiting = null;
    }

    if (stats.completed > 0) {
      const n = stats.completed;
      diag.log("run-timing", {
        project: project.id, chapters: n, perMinute: Math.round(stats.perMinute() * 10) / 10, avgChapterMs: Math.round(stats.avgChapterMs),
        avgFetchMs: Math.round(stats.steps.fetch / n), avgCleanMs: Math.round(stats.steps.clean / n),
        avgWriteMs: Math.round(stats.steps.write / n), avgDbMs: Math.round(stats.steps.db / n),
        delayMs: pace.delayMs, concurrency: pace.concurrency, slowdowns: pace.slowdowns,
      });
    }

    if (fatal) {
      this.lastErrors.set(project.id, fatal);
      diag.log("run-paused", { project: project.id, reason: fatal, status: fatalStatus, kind: fatalKind, downloaded, total });
      await saveProgress({ status: fatalStatus, accessKind: fatalKind, accessMessage: fatal });
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
    const final = await db.getChapterStats(project.id);
    downloaded = final.downloaded;
    failed = final.failed;
    const allDone = final.downloaded === final.total;
    await saveProgress({ status: allDone ? "completed" : failed > 0 ? "failed" : "paused" });
    const summary = allDone
      ? `Hotovo: staženo všech ${final.total} kapitol.`
      : `Dokončeno s chybami: ${final.downloaded}/${final.total} kapitol, ${failed} selhalo.`;
    if (!allDone) this.lastErrors.set(project.id, summary);
    this.emit({ type: "log", projectId: project.id, message: summary });
    this.emit({ type: "project-end", projectId: project.id, ok: allDone, error: allDone ? undefined : summary });
  }

  // --- Běh na pozadí ---------------------------------------------------------

  /**
   * Aplikace přešla na pozadí / vrátila se. iOS po přechodu na pozadí běh
   * JavaScriptu brzy pozastaví; rozpracovaná kapitola se zkusí dokončit
   * (krátký čas od systému), další se nezačínají. Po návratu se pokračuje samo.
   */
  setAppActive(active: boolean): void {
    if (this.appActive === active) return;
    this.appActive = active;
    if (active) {
      this.activatedAt = Date.now();
      void endBackgroundWork();
      const waiters = this.activeWaiters;
      this.activeWaiters = [];
      waiters.forEach((w) => w());
    } else {
      this.backgroundedAt = Date.now();
      if (this.runningProjects.size > 0) void beginBackgroundWork();
    }
  }

  isAppActive(): boolean {
    return this.appActive;
  }

  private waitUntilActive(signal: AbortSignal): Promise<void> {
    if (this.appActive || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.activeWaiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Selhal pokus proto, že aplikace mezitím byla na pozadí (nebo se právě vrátila)? */
  private interruptedByBackground(attemptStart: number): boolean {
    if (!this.appActive) return true;
    return this.backgroundedAt >= attemptStart || (this.activatedAt >= attemptStart && Date.now() - this.activatedAt < 5000);
  }

  /** Živé údaje o běhu (rychlost, překlad, čekání) pro obrazovku Stahování. */
  getRunView(projectId: string): RunView | undefined {
    return this.runningProjects.has(projectId) ? this.views.get(projectId) : undefined;
  }
}

interface StepTimes {
  fetch: number;
  clean: number;
  write: number;
  db: number;
}

export interface RunView {
  speedMode: SpeedMode;
  effectiveSpeedMode: SpeedMode;
  concurrency: number;
  delayMs: number;
  translationMode?: string;
  translationLabel?: string;
  perMinute: number;
  avgChapterMs: number;
  etaMs: number | null;
  /** Důvod, proč se právě čeká (podmínky, pozadí, omezení webu), nebo null. */
  waiting: string | null;
  slowdowns: number;
}

function modeName(info: ParserInfo, mode: string): string {
  return info.translationModes.find((m) => m.id === mode)?.label ?? mode;
}

function siteLabel(url: string): string {
  const host = safeHost(url).replace(/^www\./, "");
  if (/(^|\.)wtr-lab\.com$/i.test(host)) return "WTR-LAB";
  return host || "Web";
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
