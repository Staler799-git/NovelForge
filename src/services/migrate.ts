/**
 * Bezpečná oprava už existujícího projektu:
 *   - rozpozná alternativní verze kapitol a přepočítá počet unikátních kapitol,
 *   - vyčistí už stažené kapitoly od reklam a navigace Z LOKÁLNÍCH SOUBORŮ,
 *   - nic nestahuje znovu a žádný soubor nemaže.
 *
 * Před jakoukoli změnou se vytvoří záloha (řádky databáze + každý soubor,
 * který se má přepsat), ze které lze stav vrátit funkcí `restoreBackup`.
 *
 * Omezení, které nejde obejít: aplikace si neukládá původní HTML stránky,
 * jen už vyčištěný text. Odstranit lze proto jen to, co je v uloženém textu
 * bezpečně rozpoznatelné. Kapitoly, kde zůstane podezřelý obsah, se vrátí
 * v seznamu `suspicious` a lze je cíleně stáhnout znovu.
 */
import { db } from "./db";
import { storage } from "./storage";
import { analyzeLogical, selectVariant, type LogicalAnalysis, type VariantChoice } from "./catalog";
import { stripBoilerplateXhtml } from "./clean";
import { chapterBodyFromFile } from "./epub";
import { chapterToXhtml } from "./downloader";
import { contentHash, htmlToText, MIN_CHAPTER_TEXT } from "./content";
import type { Chapter, Project } from "@/types";

export interface BackupManifest {
  version: 1;
  createdAt: string;
  project: Project;
  chapters: Chapter[];
  /** Zálohované soubory: původní cesta -> cesta v záloze. */
  files: Record<string, string>;
}

export interface RepairOptions {
  /** Kterou verzi alternativních kapitol ponechat. */
  variant: VariantChoice;
  /** Vyčistit stažené soubory od reklam a navigace. */
  cleanFiles: boolean;
  onProgress?: (done: number, total: number, phase: string) => void;
}

export interface RepairReport {
  backupDir: string;
  analysis: LogicalAnalysis;
  urlCount: number;
  uniqueCount: number;
  excluded: number;
  /** Kolik souborů bylo vyčištěno (a zálohováno). */
  cleanedFiles: number;
  removedItems: number;
  /** Kapitoly, kde zůstal podezřelý obsah nebo po vyčištění skoro žádný text. */
  suspicious: Array<{ id: string; title: string; reason: string }>;
  /** Stažené kapitoly, jejichž soubor nejde přečíst. */
  unreadable: Array<{ id: string; title: string }>;
  warnings: string[];
}

function siteNames(project: Project): string[] {
  const host = (project.sourceDomain ?? "").replace(/^www\./, "");
  return host ? [host, host.replace(/\.[a-z]{2,6}$/i, "")] : [];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeManifest(dir: string, m: BackupManifest): Promise<void> {
  await storage.writeFile(`${dir}/backup.json`, JSON.stringify(m));
}

/** Jen analýza – nic nemění. */
export async function analyzeProject(projectId: string): Promise<{ chapters: Chapter[]; analysis: LogicalAnalysis }> {
  const chapters = await db.getChapters(projectId);
  return { chapters, analysis: analyzeLogical(chapters) };
}

export async function repairProject(project: Project, opts: RepairOptions): Promise<RepairReport> {
  await storage.init();
  await db.init();
  const chapters = (await db.getChapters(project.id)).slice().sort((a, b) => a.orderIndex - b.orderIndex);
  const fresh = (await db.getProject(project.id)) ?? project;

  // 1) ZÁLOHA databáze – dřív než se cokoli změní
  const backupDir = storage.backupDir(`${project.id.slice(0, 8)}-${stamp()}`);
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), project: fresh, chapters, files: {} };
  await writeManifest(backupDir, manifest);

  // 2) logické kapitoly a zvolená verze
  const analysis = analyzeLogical(chapters);
  const selection = selectVariant(chapters, opts.variant, analysis);
  const byUrl = new Map(selection.chapters.map((c) => [c.url, c]));
  const patches = chapters
    .map((c) => ({ c, s: byUrl.get(c.url)! }))
    .filter(({ c, s }) => s && (s.orderIndex !== c.orderIndex || s.excluded !== !!c.excluded))
    .map(({ c, s }) => ({ id: c.id, orderIndex: s.orderIndex, excluded: s.excluded }));
  if (patches.length > 0) await db.reorderChapters(patches);

  // 3) vyčištění stažených souborů (jen lokálně)
  const report: RepairReport = {
    backupDir,
    analysis,
    urlCount: chapters.length,
    uniqueCount: analysis.uniqueCount,
    excluded: selection.excluded,
    cleanedFiles: 0,
    removedItems: 0,
    suspicious: [],
    unreadable: [],
    warnings: selection.warnings.slice(),
  };
  const downloaded = chapters.filter((c) => c.status === "downloaded" && c.filePath);
  if (opts.cleanFiles) {
    const names = siteNames(fresh);
    for (let i = 0; i < downloaded.length; i++) {
      const ch = downloaded[i];
      opts.onProgress?.(i + 1, downloaded.length, "Kontroluji stažené kapitoly");
      let raw: string;
      try {
        raw = await storage.readFile(ch.filePath!);
      } catch {
        report.unreadable.push({ id: ch.id, title: ch.title });
        continue;
      }
      const body = chapterBodyFromFile(raw, false);
      if (!body.trim()) {
        report.unreadable.push({ id: ch.id, title: ch.title });
        continue;
      }
      const res = stripBoilerplateXhtml(body, { siteNames: names });
      const textLen = htmlToText(res.html).length;
      if (res.removed.length > 0 && textLen >= MIN_CHAPTER_TEXT) {
        const copy = `${backupDir}/files/${ch.filePath!.split("/").pop()}`;
        await storage.copyFile(ch.filePath!, copy);
        manifest.files[ch.filePath!] = copy;
        await writeManifest(backupDir, manifest); // průběžně – záloha platí i při přerušení
        await storage.writeFile(ch.filePath!, chapterToXhtml(ch.title, res.html, fresh.title, fresh.author, fresh.language));
        const size = await storage.fileSize(ch.filePath!);
        await db.updateChapter(ch.id, { fileSize: size ?? 0, checksum: contentHash(res.html), wordCount: htmlToText(res.html).split(" ").length });
        report.cleanedFiles++;
        report.removedItems += res.removed.length;
      }
      if (textLen < MIN_CHAPTER_TEXT) {
        report.suspicious.push({ id: ch.id, title: ch.title, reason: "po odstranění reklam nezbyl skoro žádný text" });
      } else if (res.suspicious.length > 0) {
        report.suspicious.push({ id: ch.id, title: ch.title, reason: `zůstal text „${res.suspicious[0]}“ uvnitř odstavce` });
      }
    }
  }

  // 4) přepočet stavu projektu podle skutečných (nevyřazených) kapitol
  const stats = await db.getChapterStats(project.id);
  const allDone = stats.total > 0 && stats.downloaded === stats.total;
  await db.updateProject(project.id, {
    totalChapters: stats.total,
    downloadedChapters: stats.downloaded,
    failedChapters: stats.failed,
    progress: stats.total === 0 ? 0 : Math.floor((stats.downloaded / stats.total) * 100),
    status: allDone ? "completed" : fresh.status === "completed" || fresh.status === "downloading" ? "paused" : fresh.status,
  });
  return report;
}

/** Označí vybrané kapitoly k novému stažení. Původní soubor se nejdřív zálohuje; nic se nemaže. */
export async function markForRedownload(project: Project, chapterIds: string[], backupDir?: string): Promise<number> {
  const chapters = await db.getChapters(project.id);
  const wanted = new Set(chapterIds);
  let n = 0;
  for (const ch of chapters) {
    if (!wanted.has(ch.id)) continue;
    if (ch.filePath && backupDir) {
      try {
        await storage.copyFile(ch.filePath, `${backupDir}/files/${ch.filePath.split("/").pop()}`);
      } catch {
        /* soubor už neexistuje – není co zálohovat */
      }
    }
    await db.updateChapter(ch.id, { status: "pending", errorMessage: "", retryCount: 0 });
    n++;
  }
  if (n > 0) await db.updateProject(project.id, { status: "paused" });
  return n;
}

/** Seznam záloh projektu (nejnovější první). */
export async function listBackups(projectId: string): Promise<string[]> {
  const prefix = `${projectId.slice(0, 8)}-`;
  const names = await storage.listDir(storage.backupDir("").replace(/\/$/, ""));
  return names.filter((n) => n.startsWith(prefix)).sort().reverse().map((n) => storage.backupDir(n));
}

/** Vrátí projekt do stavu ze zálohy: řádky databáze i přepsané soubory. */
export async function restoreBackup(backupDir: string): Promise<{ chapters: number; files: number }> {
  const m = JSON.parse(await storage.readFile(`${backupDir}/backup.json`)) as BackupManifest;
  if (m?.version !== 1 || !m.project?.id) throw new Error("Záloha je poškozená nebo má neznámý formát.");
  let files = 0;
  for (const [original, copy] of Object.entries(m.files ?? {})) {
    const content = await storage.readFile(copy);
    await storage.writeFile(original, content);
    files++;
  }
  await db.reorderChapters(m.chapters.map((c) => ({ id: c.id, orderIndex: c.orderIndex, excluded: !!c.excluded })));
  for (const c of m.chapters) {
    if (c.status !== "downloaded") continue;
    await db.updateChapter(c.id, { status: c.status, filePath: c.filePath ?? "", fileSize: c.fileSize ?? 0, checksum: c.checksum ?? "", wordCount: c.wordCount ?? 0 });
  }
  const p = m.project;
  await db.updateProject(p.id, {
    totalChapters: p.totalChapters,
    downloadedChapters: p.downloadedChapters,
    failedChapters: p.failedChapters,
    progress: p.progress,
    status: p.status === "downloading" ? "paused" : p.status,
  });
  return { chapters: m.chapters.length, files };
}
