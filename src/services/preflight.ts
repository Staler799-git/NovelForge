/**
 * Kontrola před exportem: duplicity, chybějící kapitoly, posloupnost,
 * alternativní verze a obálka. Pracuje jen s údaji z databáze (je okamžitá);
 * obsah souborů – reklamy a čitelnost – kontroluje až samotný export, který
 * je stejně musí přečíst.
 */
import { analyzeLogical, urlChapterNumber } from "./catalog";
import type { Chapter } from "@/types";

export type IssueLevel = "info" | "warn";

export interface PreflightIssue {
  level: IssueLevel;
  code: "incomplete" | "duplicates" | "gaps" | "variants" | "cover" | "failed" | "uncertain" | "ok";
  message: string;
}

export interface Preflight {
  /** Kapitoly, které do knihy patří (bez vyřazených alternativ). */
  total: number;
  downloaded: number;
  duplicates: number;
  /** Která verze alternativních kapitol v knize bude. */
  variantLabel: string | null;
  issues: PreflightIssue[];
}

type Row = Pick<Chapter, "url" | "title" | "status" | "orderIndex" | "checksum" | "excluded">;

export function preflight(chapters: Row[], hasCover: boolean): Preflight {
  const issues: PreflightIssue[] = [];
  const active = chapters.filter((c) => !c.excluded).sort((a, b) => a.orderIndex - b.orderIndex);
  const done = active.filter((c) => c.status === "downloaded");
  const failed = active.filter((c) => c.status === "failed").length;

  if (done.length < active.length) {
    issues.push({ level: "warn", code: "incomplete", message: `Kniha je NEÚPLNÁ: staženo ${done.length} z ${active.length} kapitol. Export obsahuje jen stažené.` });
  }
  if (failed > 0) issues.push({ level: "warn", code: "failed", message: `${failed} kapitol se nepodařilo stáhnout.` });

  // duplicity podle otisku obsahu (jen plnohodnotný 16znakový otisk)
  const seen = new Set<string>();
  let duplicates = 0;
  for (const c of done) {
    if (!c.checksum || c.checksum.length !== 16) continue;
    if (seen.has(c.checksum)) duplicates++;
    else seen.add(c.checksum);
  }
  if (duplicates > 0) issues.push({ level: "warn", code: "duplicates", message: `${duplicates} stažených kapitol má stejný text jako jiná kapitola.` });

  // posloupnost: díry mezi první a poslední staženou kapitolou
  const nums = done.map((c) => urlChapterNumber(c.url).num);
  if (done.length > 1 && nums.every((n) => n !== null)) {
    const set = new Set(nums as number[]);
    const first = Math.min(...(nums as number[]));
    const last = Math.max(...(nums as number[]));
    const missing: number[] = [];
    if (last - first < done.length * 3) for (let n = first; n <= last && missing.length < 500; n++) if (!set.has(n)) missing.push(n);
    if (missing.length > 0) {
      issues.push({
        level: "warn",
        code: "gaps",
        message: `Mezi staženými kapitolami ${first}–${last} chybí ${missing.length}${missing.length >= 500 ? "+" : ""} (např. ${missing.slice(0, 6).join(", ")}). Děj v knize na těch místech přeskočí.`,
      });
    }
    let outOfOrder = 0;
    for (let i = 1; i < nums.length; i++) if ((nums[i] as number) < (nums[i - 1] as number)) outOfOrder++;
    if (outOfOrder > 0) issues.push({ level: "warn", code: "gaps", message: `Pořadí ${outOfOrder} kapitol neodpovídá jejich číslům – spusťte „Zálohovat a opravit“ v detailu projektu.` });
  }

  // alternativní verze
  const all = analyzeLogical(chapters);
  const act = analyzeLogical(active);
  let variantLabel: string | null = null;
  if (all.alternatives > 0 && all.altRange) {
    const range = `${all.altRange.first}–${all.altRange.last}`;
    if (act.alternatives > 0) {
      variantLabel = "obě verze";
      issues.push({ level: "warn", code: "variants", message: `Kapitoly ${range} budou v knize dvakrát (obě verze). Jednu verzi vyberte v detailu projektu.` });
    } else {
      const paddedKept = active.some((c) => urlChapterNumber(c.url).padded);
      variantLabel = paddedKept ? "alternativní řada (adresy …_001)" : "hlavní řada (adresy …_1)";
      issues.push({
        level: paddedKept ? "warn" : "info",
        code: "variants",
        message: paddedKept
          ? `Kapitoly ${range} pocházejí z alternativní řady, zbytek z hlavní – za kapitolou ${all.altRange.last} se změní překlad.`
          : `Kapitoly ${range} mají na webu dvě verze; kniha obsahuje hlavní řadu.`,
      });
    }
  }
  if (act.uncertain.length > 0) {
    issues.push({ level: "warn", code: "uncertain", message: `U ${act.uncertain.length} čísel kapitol je více adres, které nejde rozlišit – v knize budou všechny.` });
  }
  if (!hasCover) issues.push({ level: "warn", code: "cover", message: "Kniha nemá obálku. Vyberte ji z galerie, jinak bude EPUB bez obálky." });
  if (issues.every((i) => i.level === "info")) issues.push({ level: "info", code: "ok", message: "Kontrola neodhalila žádný problém." });
  return { total: active.length, downloaded: done.length, duplicates, variantLabel, issues };
}
