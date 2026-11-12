/**
 * Analýza katalogu kapitol: číslovací řady, duplicity, chybějící čísla.
 *
 * Zásady:
 *  - identita kapitoly = její URL (nikdy ne číslo v názvu),
 *  - pořadí = pořadí v katalogu webu,
 *  - čísla z názvů slouží jen ke KONTROLE (mezery, souběžné řady).
 */
import type { ParserChapter } from "@/types";
import { contentHash, htmlToText, textSimilarity } from "./content";

export interface ChapterNumbering {
  num: number | null;
  /** Číslo je zapsané s úvodními nulami ("001"). */
  padded: boolean;
  /** Název je jen "Chapter N" bez vlastního pojmenování. */
  bare: boolean;
}

const CHAPTER_WORD = /(?:chapter|chap|ch|kapitola|kap|episode|ep|díl|dil|part|část|cast)\.?/i;

export function chapterNumbering(ch: Pick<ParserChapter, "title" | "label">): ChapterNumbering {
  const title = ch.title ?? "";
  const label = (ch.label ?? "").trim();
  let token: string | null = null;
  if (/^\d{1,6}$/.test(label)) token = label;
  const m = title.match(new RegExp(`${CHAPTER_WORD.source}\\s*(\\d{1,6})`, "i")) ?? title.match(/^\s*(\d{1,6})\b/);
  if (!token && m) token = m[1];
  const rest = title
    .replace(new RegExp(`${CHAPTER_WORD.source}\\s*\\d{1,6}`, "ig"), " ")
    .replace(/^\s*\d{1,6}\b/, " ")
    .replace(/[^\p{L}]+/gu, "");
  return {
    num: token ? parseInt(token, 10) : null,
    padded: !!token && token.length > 1 && token.startsWith("0"),
    bare: rest.length < 3,
  };
}

export interface SeriesInfo {
  id: string;
  /** Popis pro uživatele. */
  label: string;
  count: number;
  /** Ukázky názvů (první tři). */
  samples: string[];
  urls: string[];
}

export interface CatalogAnalysis {
  total: number;
  /** Dvě a více položek = katalog obsahuje souběžné číslovací řady. */
  series: SeriesInfo[];
  /** Počet čísel kapitol, která se v katalogu vyskytují u více různých URL. */
  duplicateNumbers: number;
}

/**
 * Rozpozná, zda katalog obsahuje dvě souběžné číslovací řady
 * (např. "001 Chapter 001" a "1 Chapter 1 – Název").
 *
 * Řady se NESLUČUJÍ ani nemažou – jen se pojmenují, aby si uživatel mohl
 * vybrat. Rozdělení se opírá o to, čím se dvojice se stejným číslem liší
 * (bez názvu × s názvem, s nulami × bez nul), a teprve když se neliší ničím,
 * o pořadí výskytu.
 */
export function analyzeCatalog(chapters: ParserChapter[]): CatalogAnalysis {
  const info = chapters.map((c) => chapterNumbering(c));
  const byNum = new Map<number, number[]>();
  info.forEach((n, i) => {
    if (n.num === null) return;
    const list = byNum.get(n.num) ?? [];
    list.push(i);
    byNum.set(n.num, list);
  });
  const dupGroups = [...byNum.values()].filter((g) => g.length >= 2);
  const single: CatalogAnalysis = { total: chapters.length, series: [], duplicateNumbers: dupGroups.length };
  if (dupGroups.length < Math.max(3, byNum.size * 0.1)) return single;

  let bareDiff = 0;
  let padDiff = 0;
  let bareFirst = 0;
  let padFirst = 0;
  for (const g of dupGroups) {
    const [a, b] = [info[g[0]], info[g[1]]];
    if (a.bare !== b.bare) {
      bareDiff++;
      if (a.bare) bareFirst++;
    }
    if (a.padded !== b.padded) {
      padDiff++;
      if (a.padded) padFirst++;
    }
  }
  type Feature = "bare" | "padded" | "order";
  const feature: Feature =
    bareDiff >= dupGroups.length * 0.6 ? "bare" : padDiff >= dupGroups.length * 0.6 ? "padded" : "order";

  // Která řada bývá v katalogu první (pro položky, které příznak nerozliší).
  const flaggedComesFirst = feature === "bare" ? bareFirst >= bareDiff / 2 : feature === "padded" ? padFirst >= padDiff / 2 : true;

  const assign = new Array<0 | 1>(chapters.length).fill(0);
  const occurrence = new Map<number, number>();
  info.forEach((n, i) => {
    const occ = n.num === null ? 0 : (occurrence.get(n.num) ?? 0);
    if (n.num !== null) occurrence.set(n.num, occ + 1);
    const byOrder: 0 | 1 = (occ === 0) === flaggedComesFirst ? 0 : 1;
    if (feature === "bare") {
      const group = n.num === null ? [] : (byNum.get(n.num) ?? []);
      const discriminates = group.length < 2 || group.some((j) => info[j].bare !== n.bare);
      assign[i] = discriminates ? (n.bare ? 0 : 1) : byOrder;
    } else if (feature === "padded") {
      // "100" nelze rozlišit podle nul – tam rozhodne pořadí výskytu
      const ambiguous = n.num !== null && String(n.num).length >= 3 && !n.padded;
      assign[i] = ambiguous ? byOrder : n.padded ? 0 : 1;
    } else {
      assign[i] = occ === 0 ? 0 : 1;
    }
  });

  const labels: Record<Feature, [string, string]> = {
    bare: ["Řada bez názvů kapitol", "Řada s názvy kapitol"],
    padded: ["Řada s čísly s nulami (001…)", "Řada s čísly bez nul (1…)"],
    order: ["První řada (první výskyt čísla)", "Druhá řada (opakovaný výskyt čísla)"],
  };
  const series: SeriesInfo[] = [0, 1].map((s) => {
    const items = chapters.filter((_, i) => assign[i] === s);
    return {
      id: s === 0 ? "A" : "B",
      label: labels[feature][s],
      count: items.length,
      samples: items.slice(0, 3).map((c) => (c.label ? `${c.label} · ${c.title}` : c.title)),
      urls: items.map((c) => c.url),
    };
  });
  if (series.some((s) => s.count < Math.max(3, chapters.length * 0.05))) return single;
  return { total: chapters.length, series, duplicateNumbers: dupGroups.length };
}

export interface GapReport {
  /** Je číslování dost spolehlivé na to, aby kontrola dávala smysl? */
  reliable: boolean;
  missing: number[];
  missingCount: number;
  first: number | null;
  last: number | null;
}

/** Najde chybějící čísla kapitol v souvislé řadě (kontrola úplnosti). */
export function findGaps(chapters: ParserChapter[]): GapReport {
  const nums = chapters.map((c) => chapterNumbering(c).num).filter((n): n is number => n !== null);
  if (chapters.length === 0 || nums.length < chapters.length * 0.8) {
    return { reliable: false, missing: [], missingCount: 0, first: null, last: null };
  }
  const set = new Set(nums);
  const first = Math.min(...nums);
  const last = Math.max(...nums);
  // Řada s obrovskými skoky (např. ID místo čísel) není číslování kapitol.
  if (last - first > chapters.length * 3) {
    return { reliable: false, missing: [], missingCount: 0, first, last };
  }
  const missing: number[] = [];
  let missingCount = 0;
  for (let n = first; n <= last; n++) {
    if (!set.has(n)) {
      missingCount++;
      if (missing.length < 20) missing.push(n);
    }
  }
  return { reliable: true, missing, missingCount, first, last };
}

export type SeriesVerdict = "identical" | "similar" | "different" | "unknown";

export interface SeriesComparison {
  verdict: SeriesVerdict;
  /** Průměrná podobnost textu 0–1. */
  similarity: number;
  pairs: Array<{ number: number; a: string; b: string; similarity: number; identical: boolean }>;
  message: string;
}

/**
 * Stáhne několik dvojic kapitol se stejným číslem z obou řad a porovná jejich
 * NORMALIZOVANÝ text (otisk + podobnost). Odpovídá na otázku, zda jsou řady
 * duplicitní obsah, nebo dvě různé verze.
 */
export async function compareSeries(
  chapters: ParserChapter[],
  a: SeriesInfo,
  b: SeriesInfo,
  fetchChapter: (url: string) => Promise<{ html: string }>,
  samples = 2,
): Promise<SeriesComparison> {
  const numOf = (urls: string[]) => {
    const set = new Set(urls);
    const map = new Map<number, ParserChapter>();
    for (const c of chapters) {
      if (!set.has(c.url)) continue;
      const n = chapterNumbering(c).num;
      if (n !== null && !map.has(n)) map.set(n, c);
    }
    return map;
  };
  const ma = numOf(a.urls);
  const mb = numOf(b.urls);
  const common = [...ma.keys()].filter((n) => mb.has(n)).sort((x, y) => x - y);
  if (common.length === 0) {
    return { verdict: "unknown", similarity: 0, pairs: [], message: "Řady nemají společná čísla kapitol – nelze je porovnat." };
  }
  const picks = [...new Set([common[0], common[Math.floor(common.length / 2)], common[common.length - 1]])].slice(0, samples);
  const pairs: SeriesComparison["pairs"] = [];
  for (const n of picks) {
    const ca = ma.get(n)!;
    const cb = mb.get(n)!;
    const [ha, hb] = await Promise.all([fetchChapter(ca.url), fetchChapter(cb.url)]);
    const identical = contentHash(ha.html) === contentHash(hb.html);
    const similarity = identical ? 1 : textSimilarity(htmlToText(ha.html), htmlToText(hb.html));
    pairs.push({ number: n, a: ca.title, b: cb.title, similarity, identical });
  }
  const avg = pairs.reduce((s, p) => s + p.similarity, 0) / pairs.length;
  let verdict: SeriesVerdict;
  let message: string;
  if (pairs.every((p) => p.identical || p.similarity >= 0.9)) {
    verdict = "identical";
    message = "Obě řady mají u porovnaných kapitol stejný text – jde o duplicitní obsah. Stačí stáhnout jednu řadu.";
  } else if (avg >= 0.2) {
    verdict = "similar";
    message = `Texty se shodují jen částečně (${Math.round(avg * 100)} %) – pravděpodobně dvě úpravy téhož textu. Vyberte jednu řadu.`;
  } else {
    verdict = "different";
    message = `Texty se liší (shoda ${Math.round(avg * 100)} %) – jde o jiný překlad nebo o různé kapitoly. Řady nemíchejte; vyberte jednu, nebo stáhněte vše v pořadí katalogu.`;
  }
  return { verdict, similarity: avg, pairs, message };
}
