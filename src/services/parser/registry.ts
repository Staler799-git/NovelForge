import { NovelParser } from "./base";
import type { NovelMetadata, ParserChapter } from "@/types";
import { GenericNovelParser } from "./generic";
import { WuxiaBoxParser } from "./wuxiabox";

const parsers: NovelParser[] = [new WuxiaBoxParser()];

export function registerParser(parser: NovelParser): void {
  parsers.push(parser);
}

export function getParser(url: string): NovelParser {
  const specific = parsers.find((p) => p.canHandle(url));
  if (specific) return specific;
  return genericParser;
}

const genericParser = new GenericNovelParser();

export async function parseMetadata(url: string, opts?: any): Promise<NovelMetadata> {
  return getParser(url).fetchMetadata(url, opts);
}

export async function parseChapterList(url: string, opts?: any): Promise<ParserChapter[]> {
  return getParser(url).fetchChapterList(url, opts);
}

export async function parseChapter(url: string, opts?: any): Promise<{ title: string; html: string }> {
  return getParser(url).fetchChapter(url, opts);
}

export { GenericNovelParser, WuxiaBoxParser };
export type { NovelMetadata, ParserChapter };
