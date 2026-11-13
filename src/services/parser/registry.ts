import { NovelParser } from "./base";
import type { TranslationModeInfo, ModeProbe, SessionState } from "./base";
import type { NovelMetadata, ParserChapter, FetchOptions, CatalogResult } from "@/types";
import { GenericNovelParser } from "./generic";
import { WuxiaBoxParser } from "./wuxiabox";
import { WtrLabParser } from "./wtrlab";

const parsers: NovelParser[] = [new WuxiaBoxParser(), new WtrLabParser()];

export function registerParser(parser: NovelParser): void {
  parsers.push(parser);
}

export function getParser(url: string): NovelParser {
  const specific = parsers.find((p) => p.canHandle(url));
  if (specific) return specific;
  return genericParser;
}

const genericParser = new GenericNovelParser();

/** Údaje o parseru pro danou adresu (diagnostika, omezení souběžnosti). */
export function parserInfo(url: string): ParserInfo {
  const p = getParser(url);
  return {
    name: p.name,
    maxConcurrency: p.maxConcurrency,
    allowFast: p.allowFast,
    minIntervalMs: p.minIntervalMs,
    translationModes: p.translationModes(),
    legacyTranslationMode: p.legacyTranslationMode,
  };
}

export interface ParserInfo {
  name: string;
  maxConcurrency: number;
  allowFast: boolean;
  minIntervalMs: number;
  translationModes: TranslationModeInfo[];
  legacyTranslationMode?: string;
}

/** Ověří, které překlady zdroj pro danou kapitolu vydá (jeden běžný požadavek na překlad). */
export function probeTranslationModes(chapterUrl: string, opts?: FetchOptions): Promise<ModeProbe[]> {
  return getParser(chapterUrl).probeTranslationModes(chapterUrl, opts);
}

/** Stav přihlášení na zdroji, pokud ho lze bezpečně zjistit. */
export function checkSession(url: string, opts?: FetchOptions & { fresh?: boolean }): Promise<SessionState> {
  return getParser(url).checkSession(url, opts);
}

export async function parseMetadata(url: string, opts?: FetchOptions): Promise<NovelMetadata> {
  return getParser(url).fetchMetadata(url, opts);
}

export async function parseChapterList(url: string, opts?: FetchOptions): Promise<ParserChapter[]> {
  return getParser(url).fetchChapterList(url, opts);
}

/** Celý katalog včetně informací o úplnosti, s průběhem a možností zastavení. */
export async function parseCatalog(url: string, opts?: FetchOptions): Promise<CatalogResult> {
  return getParser(url).fetchCatalog(url, opts);
}

export async function parseChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string; translationMode?: string }> {
  return getParser(url).fetchChapter(url, opts);
}

export { GenericNovelParser, WuxiaBoxParser, WtrLabParser };
export type { NovelMetadata, ParserChapter };
