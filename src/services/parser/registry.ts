import { NovelParser } from "./base";
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

export async function parseChapter(url: string, opts?: FetchOptions): Promise<{ title: string; html: string }> {
  return getParser(url).fetchChapter(url, opts);
}

export { GenericNovelParser, WuxiaBoxParser, WtrLabParser };
export type { NovelMetadata, ParserChapter };
