/**
 * Analýza katalogu kapitol: číslovací řady, duplicity, chybějící čísla.
 *
 * Zásady:
 *  - identita kapitoly = její URL (nikdy ne číslo v názvu),
 *  - pořadí = pořadí v katalogu webu,
 *  - čísla z názvů slouží jen ke KONTROLE (mezery, souběžné řady).
 */
import type { ParserChapter } from "@/types";
import { contentHash, htmlToText, storyAffinity, textSimilarity } from "./content";

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

/* ------------------------------------------------------------------------ */
/*  LOGICKÁ IDENTITA KAPITOL A ALTERNATIVNÍ VERZE                            */
/* ------------------------------------------------------------------------ */

export interface UrlNumber {
  num: number | null;
  /** Číslo přesně tak, jak je v adrese ("001"). */
  raw: string | null;
  padded: boolean;
}

/** Pořadové číslo kapitoly z adresy: …_001.html, …/chapter-12, …/123.html */
export function urlChapterNumber(url: string): UrlNumber {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* relativní nebo neplatná adresa – použije se celá */
  }
  const last = path.replace(/\/+$/, "").split("/").pop() ?? "";
  const m =
    last.match(/[_-](\d{1,6})(?:\.[a-z0-9]{2,5})?$/i) ??
    last.match(/^(?:chapter|chap|ch|c|ep|episode)[-_]?(\d{1,6})(?:\.[a-z0-9]{2,5})?$/i) ??
    last.match(/^(\d{1,6})(?:\.[a-z0-9]{2,5})?$/i);
  if (!m) return { num: null, raw: null, padded: false };
  return { num: parseInt(m[1], 10), raw: m[1], padded: m[1].length > 1 && m[1].startsWith("0") };
}

export type VariantId = "plain" | "padded";
export type VariantChoice = VariantId | "all";

export interface VariantInfo {
  id: VariantId;
  label: string;
  /** Kolik logických kapitol tato varianta pokrývá (jen tam, kde existuje alternativa). */
  count: number;
  first: number;
  last: number;
  samples: string[];
}

export interface LogicalAnalysis {
  /** Počet adres v katalogu. */
  urlCount: number;
  /** Počet skutečně různých (logických) kapitol. */
  uniqueCount: number;
  /** Logické kapitoly, které mají dvě adresy (alternativní verze). */
  alternatives: number;
  altRange: { first: number; last: number } | null;
  variants: VariantInfo[];
  /** Stejné číslo u více adres, které nelze rozlišit – nutné ruční rozhodnutí. */
  uncertain: Array<{ num: number; urls: string[]; titles: string[] }>;
  /** Kolik položek nemá rozpoznatelné číslo. */
  unnumbered: number;
  /** Lze kapitoly řadit podle čísla? (jinak platí pořadí katalogu) */
  orderByNumber: boolean;
}

type Item = Pick<ParserChapter, "url" | "title"> & { label?: string };

interface Numbered {
  index: number;
  num: number | null;
  padded: boolean;
}

function numberItems(chapters: Item[]): Numbered[] {
  return chapters.map((c, index) => {
    const u = urlChapterNumber(c.url);
    if (u.num !== null) return { index, num: u.num, padded: u.padded };
    const t = chapterNumbering(c);
    return { index, num: t.num, padded: t.padded };
  });
}

/**
 * Rozpozná logické kapitoly: "…_001.html" a "…_1.html" jsou táž kapitola 1 ve
 * dvou verzích. Identita se opírá o normalizované číslo z ADRESY (teprve když
 * v adrese není, o číslo v katalogu); název ani text k tomu nestačí.
 *
 * Nic se nemaže. Položky, které rozlišit nejde, se vrátí jako `uncertain`.
 */
export function analyzeLogical(chapters: Item[]): LogicalAnalysis {
  const items = numberItems(chapters);
  const groups = new Map<number, Numbered[]>();
  let unnumbered = 0;
  for (const it of items) {
    if (it.num === null) {
      unnumbered++;
      continue;
    }
    const g = groups.get(it.num) ?? [];
    g.push(it);
    groups.set(it.num, g);
  }

  const altNums: number[] = [];
  const uncertain: LogicalAnalysis["uncertain"] = [];
  for (const [num, g] of groups) {
    if (g.length < 2) continue;
    const padded = g.filter((x) => x.padded).length;
    if (g.length === 2 && padded === 1) altNums.push(num);
    else uncertain.push({ num, urls: g.map((x) => chapters[x.index].url), titles: g.map((x) => chapters[x.index].title) });
  }
  altNums.sort((a, b) => a - b);
  uncertain.sort((a, b) => a.num - b.num);

  const variants: VariantInfo[] = [];
  if (altNums.length > 0) {
    const sample = (wantPadded: boolean) =>
      altNums.slice(0, 3).map((n) => {
        const it = groups.get(n)!.find((x) => x.padded === wantPadded)!;
        const c = chapters[it.index];
        return `${c.title} · ${c.url.split("/").pop()}`;
      });
    const first = altNums[0];
    const last = altNums[altNums.length - 1];
    variants.push(
      { id: "plain", label: "Hlavní řada (adresy bez nul: …_1, …_2)", count: altNums.length, first, last, samples: sample(false) },
      { id: "padded", label: "Alternativní řada (adresy s nulami: …_001, …_002)", count: altNums.length, first, last, samples: sample(true) },
    );
  }

  // Řadit podle čísla lze jen tehdy, když čísla v katalogu opravdu rostou.
  let violations = 0;
  let pairs = 0;
  let prev: number | null = null;
  for (const it of items) {
    if (it.num === null) continue;
    if (prev !== null) {
      pairs++;
      if (it.num < prev) violations++;
    }
    prev = it.num;
  }
  const numbered = chapters.length - unnumbered;
  const orderByNumber = numbered >= chapters.length * 0.9 && numbered > 0 && violations <= Math.max(2, pairs * 0.02);

  return {
    urlCount: chapters.length,
    uniqueCount: groups.size + unnumbered,
    alternatives: altNums.length,
    altRange: altNums.length ? { first: altNums[0], last: altNums[altNums.length - 1] } : null,
    variants,
    uncertain,
    unnumbered,
    orderByNumber,
  };
}

export interface SelectedChapter {
  url: string;
  /** Nové pořadí (0…n-1) přes VŠECHNY adresy, i vyřazené. */
  orderIndex: number;
  /** true = alternativní verze, která se nestahuje ani neexportuje (adresa zůstává uložená). */
  excluded: boolean;
  num: number | null;
}

export interface VariantSelection {
  chapters: SelectedChapter[];
  included: number;
  excluded: number;
  /** Výběr skládá knihu ze dvou řad (jiný překlad na začátku než ve zbytku). */
  mixed: boolean;
  warnings: string[];
}

/**
 * Sestaví pořadí kapitol pro zvolenou variantu. Žádná adresa se nezahazuje –
 * nevybraná verze se jen označí jako vyřazená.
 */
export function selectVariant(chapters: Item[], choice: VariantChoice, analysis = analyzeLogical(chapters)): VariantSelection {
  const items = numberItems(chapters);
  const altSet = new Set<number>();
  if (analysis.altRange) {
    const groups = new Map<number, Numbered[]>();
    for (const it of items) if (it.num !== null) groups.set(it.num, [...(groups.get(it.num) ?? []), it]);
    for (const [n, g] of groups) if (g.length === 2 && g.filter((x) => x.padded).length === 1) altSet.add(n);
  }

  let order = items.map((it) => it.index);
  if (analysis.orderByNumber) {
    // položky bez čísla zůstanou za svou předchozí očíslovanou sousedkou
    const key = new Array<number>(items.length);
    let last = -1;
    items.forEach((it, i) => {
      if (it.num !== null) last = it.num;
      key[i] = it.num !== null ? it.num : last + 0.5;
    });
    order = order.slice().sort((a, b) => key[a] - key[b] || Number(items[b].padded) - Number(items[a].padded) || a - b);
  }

  const warnings: string[] = [];
  const out: SelectedChapter[] = order.map((idx, pos) => {
    const it = items[idx];
    const hasAlt = it.num !== null && altSet.has(it.num);
    const excluded = hasAlt && choice !== "all" && (choice === "plain" ? it.padded : !it.padded);
    return { url: chapters[idx].url, orderIndex: pos, excluded, num: it.num };
  });
  const included = out.filter((c) => !c.excluded).length;

  let mixed = false;
  if (analysis.altRange && choice === "padded" && analysis.alternatives < analysis.uniqueCount) {
    mixed = true;
    warnings.push(
      `Alternativní řada pokrývá jen kapitoly ${analysis.altRange.first}–${analysis.altRange.last}. Zbytek knihy pochází z hlavní řady, takže se za kapitolou ${analysis.altRange.last} změní překlad.`,
    );
  }
  if (analysis.altRange && choice === "all") {
    mixed = true;
    warnings.push(
      `Kapitoly ${analysis.altRange.first}–${analysis.altRange.last} budou v knize DVAKRÁT (obě verze za sebou). Pro čtení vyberte jednu řadu.`,
    );
  }
  if (analysis.uncertain.length > 0) {
    warnings.push(
      `U ${analysis.uncertain.length} čísel kapitol je více adres, které nejde rozlišit (např. kapitola ${analysis.uncertain[0].num}). Zůstávají všechny – zkontrolujte je ručně.`,
    );
  }
  return { chapters: out, included, excluded: out.length - included, mixed, warnings };
}

export type AlternativeVerdict = "duplicate" | "translation" | "uncertain";

export interface AlternativeCheck {
  verdict: AlternativeVerdict;
  /** Sedí číslování obou řad na sebe (kapitola N alternativní = kapitola N hlavní)? */
  aligned: boolean | null;
  pairs: Array<{ number: number; similarity: number; affinity: number; identical: boolean }>;
  message: string;
}

/**
 * Ověří na vzorku (první, prostřední a poslední dvojice), co alternativní
 * verze jsou: stejný text, jiný překlad téže části, nebo to nelze potvrdit.
 * Navíc zkontroluje návaznost: poslední alternativní kapitola má odpovídat
 * stejnému číslu hlavní řady, ne kapitole následující.
 */
export async function verifyAlternatives(
  chapters: Item[],
  fetchChapter: (url: string) => Promise<{ html: string }>,
): Promise<AlternativeCheck> {
  const items = numberItems(chapters);
  const byNum = new Map<number, { plain?: string; padded?: string }>();
  for (const it of items) {
    if (it.num === null) continue;
    const e = byNum.get(it.num) ?? {};
    if (it.padded) e.padded ??= chapters[it.index].url;
    else e.plain ??= chapters[it.index].url;
    byNum.set(it.num, e);
  }
  const nums = [...byNum.entries()].filter(([, e]) => e.plain && e.padded).map(([n]) => n).sort((a, b) => a - b);
  if (nums.length === 0) {
    return { verdict: "uncertain", aligned: null, pairs: [], message: "Katalog neobsahuje alternativní verze kapitol." };
  }
  const picks = [...new Set([nums[0], nums[Math.floor(nums.length / 2)], nums[nums.length - 1]])];
  const cache = new Map<string, string>();
  const text = async (url: string) => {
    if (!cache.has(url)) cache.set(url, htmlToText((await fetchChapter(url)).html));
    return cache.get(url)!;
  };
  const pairs: AlternativeCheck["pairs"] = [];
  for (const n of picks) {
    const e = byNum.get(n)!;
    const [a, b] = [await text(e.padded!), await text(e.plain!)];
    const identical = contentHash(a) === contentHash(b);
    pairs.push({ number: n, identical, similarity: identical ? 1 : textSimilarity(a, b), affinity: identical ? 1 : storyAffinity(a, b) });
  }

  // návaznost: poslední alternativní kapitola vs. stejné a následující číslo hlavní řady
  let aligned: boolean | null = null;
  const lastN = nums[nums.length - 1];
  const next = byNum.get(lastN + 1)?.plain;
  if (next) {
    const alt = await text(byNum.get(lastN)!.padded!);
    const same = storyAffinity(alt, await text(byNum.get(lastN)!.plain!));
    const following = storyAffinity(alt, await text(next));
    if (same > 0 || following > 0) aligned = same >= following;
  }

  const range = `${nums[0]}–${lastN}`;
  const avgAff = pairs.reduce((s, p) => s + p.affinity, 0) / pairs.length;
  if (pairs.every((p) => p.identical || p.similarity >= 0.9)) {
    return { verdict: "duplicate", aligned: true, pairs, message: `Kapitoly ${range} mají v obou řadách stejný text – jde o duplicitu. Stačí hlavní řada.` };
  }
  if (avgAff >= 0.3 && pairs.every((p) => p.affinity >= 0.15) && aligned !== false) {
    return {
      verdict: "translation",
      aligned,
      pairs,
      message: `Kapitoly ${range} existují ve dvou zněních se stejnými jmény a čísly – pravděpodobně jde o dva překlady téže části příběhu. Vyberte jednu řadu; druhá zůstane uložená jen jako adresy.`,
    };
  }
  return {
    verdict: "uncertain",
    aligned,
    pairs,
    message:
      aligned === false
        ? `Číslování obou řad na sebe nesedí (alternativní kapitola ${lastN} odpovídá spíš následující kapitole hlavní řady). Nelze spolehlivě říct, kde alternativní řada navazuje – rozhodněte ručně.`
        : `Nepodařilo se potvrdit, že obě verze kapitol ${range} vyprávějí totéž. Rozhodněte ručně: bezpečná volba je hlavní řada, která pokrývá celou knihu.`,
  };
}
