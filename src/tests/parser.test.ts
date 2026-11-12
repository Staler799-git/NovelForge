import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseMetadata,
  parseChapterList,
  parseChapter,
  getParser,
  GenericNovelParser,
  WuxiaBoxParser,
} from "@/services/parser/registry";

const FIXTURE = join(__dirname, "fixtures");

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURE, name), "utf8");
}

const WUXIABOX_NOVEL = "https://www.wuxiabox.com/novel/i-created-the-longevity-club.html";
const GENERIC_NOVEL = "https://example.com/novel/cizi-novela.html";
const GENERIC_CH1 = "https://example.com/novel/cizi-novela/kapitola-1.html";

vi.mock("@/services/http", async (orig) => ({
  ...(await orig<typeof import("@/services/http")>()),
  http: {
    get: vi.fn(async (url: string) => {
      if (url === GENERIC_NOVEL) {
        return { url, status: 200, ok: true, data: await fixture("generic-novel.html"), headers: {} };
      }
      if (url === GENERIC_CH1) {
        return { url, status: 200, ok: true, data: await fixture("generic-chapter.html"), headers: {} };
      }
      return { url, status: 404, ok: false, data: "", headers: {} };
    }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parser registry", () => {
  it("přesune wuxiabox.com na specifický adaptér, ostatní na generický", () => {
    expect(getParser(WUXIABOX_NOVEL)).toBeInstanceOf(WuxiaBoxParser);
    expect(getParser(GENERIC_NOVEL)).toBeInstanceOf(GenericNovelParser);
    expect(getParser("https://jiny-web.cz/kniha")).toBeInstanceOf(GenericNovelParser);
  });
});

describe("generic parser", () => {
  it("detekuje metadata a seznam kapitol obecné stránky", async () => {
    const meta = await parseMetadata(GENERIC_NOVEL);
    expect(meta.title).toBe("Cizí novela");
    expect(meta.author).toBe("Neznámý autor");

    const chapters = await parseChapterList(GENERIC_NOVEL);
    expect(chapters.length).toBe(4);
    expect(chapters.map((c) => c.title)).toEqual(["Kapitola 1", "Kapitola 2", "Kapitola 3", "Kapitola 5"]);
    expect(chapters.map((c) => c.orderIndex)).toEqual([0, 1, 2, 3]);
    expect(chapters.some((c) => c.url.includes("/contact"))).toBe(false);
    expect(chapters.some((c) => c.url.includes("/search"))).toBe(false);
  });

  it("stáhne a vyčistí obecnou kapitolu", async () => {
    const ch = await parseChapter(GENERIC_CH1);
    expect(ch.title).toBe("Chapter 1");
    expect(ch.html).toContain("Generic chapter content here");
    expect(ch.html).not.toContain("Sidebar");
    expect(ch.html).not.toContain("Comments");
  });
});
