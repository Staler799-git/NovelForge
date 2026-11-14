/**
 * v1.3.0 – přístupová omezení WTR-LAB, překladové režimy, tempo a běh na pozadí.
 *
 * Správce stahování běží proti skutečnému parseru WTR-LAB; síť, databáze a
 * úložiště jsou nahrazené. Odpovědi webu jsou SYNTETICKÉ (živý web není z
 * vývojového prostředí dostupný) – napodobují chování popsané uživatelem:
 * AI překlad bez přihlášení jen u kapitol 1–10, poté „Requires Registration“.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  chapters: [] as any[],
  projectRow: {} as Record<string, any>,
  files: {} as Record<string, string>,
  diagFiles: {} as Record<string, string>,
  posts: [] as { body: any; at: number }[],
  gets: [] as string[],
  post: null as null | ((body: any) => Promise<any> | any),
  signedIn: false,
  network: { connected: true, connectionType: "wifi" },
  renders: 0,
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async ({ path }: any) => {
      if (!(path in h.diagFiles)) throw new Error("missing");
      return { size: h.diagFiles[path].length };
    }),
    appendFile: vi.fn(async ({ path, data }: any) => {
      h.diagFiles[path] = (h.diagFiles[path] ?? "") + data;
    }),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ({ data: "" })),
    deleteFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  },
}));
vi.mock("@capacitor/network", () => ({ Network: { getStatus: vi.fn(async () => ({ ...h.network })) } }));

vi.mock("@/services/db", () => ({
  db: {
    init: vi.fn(async () => {}),
    getProject: vi.fn(async () => ({ ...h.projectRow, settings: { ...h.projectRow.settings } })),
    getProjects: vi.fn(async () => [{ ...h.projectRow }]),
    getChapters: vi.fn(async () => h.chapters.map((c) => ({ ...c }))),
    getChapterStats: vi.fn(async () => {
      const cs = h.chapters.filter((c) => !c.excluded);
      return { total: cs.length, downloaded: cs.filter((c) => c.status === "downloaded").length, failed: cs.filter((c) => c.status === "failed").length };
    }),
    updateProject: vi.fn(async (_id: string, patch: any) => {
      const { settings, ...rest } = patch;
      Object.assign(h.projectRow, rest);
      if (settings) h.projectRow.settings = { ...h.projectRow.settings, ...settings };
    }),
    updateChapter: vi.fn(async (id: string, patch: any) => {
      const c = h.chapters.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    }),
  },
}));
vi.mock("@/services/storage", () => ({
  storage: {
    init: vi.fn(async () => {}),
    chapterPath: vi.fn(async (projectId: string, chapterId: string) => `NovelForge/projects/${projectId}/${chapterId}.html`),
    writeFile: vi.fn(async (path: string, data: string) => {
      h.files[path] = data;
    }),
    fileSize: vi.fn(async (path: string) => (path in h.files ? h.files[path].length : null)),
  },
}));
vi.mock("@/services/http", async (orig) => {
  const actual = await orig<typeof import("@/services/http")>();
  return {
    ...actual,
    http: {
      get: async (url: string) => {
        h.gets.push(url);
        if (url.endsWith("/api/auth/get-session")) return { ok: true, status: 200, url, headers: {}, data: JSON.stringify(h.signedIn ? { user: { id: 1 } } : {}) };
        return { ok: false, status: 404, url, headers: {}, data: "" };
      },
      postJson: async (url: string, body: any) => {
        h.posts.push({ body, at: Date.now() });
        const r = await h.post!(body);
        return { url, headers: {}, ...r };
      },
      getBinary: async () => {
        throw new Error("not used");
      },
    },
  };
});
vi.mock("@/services/render", () => ({
  renderPage: async () => {
    h.renders++;
    throw new Error("render must not be used for chapters");
  },
  renderHtml: async () => {
    h.renders++;
    throw new Error("render must not be used for chapters");
  },
  onMemoryWarning: () => () => {},
}));

import { downloadManager } from "@/services/downloader";
import { getParser, parserInfo, probeTranslationModes, checkSession } from "@/services/parser/registry";
import { diag, DIAG_FILE } from "@/services/diag";
import type { Project } from "@/types";

const NOVEL = "https://wtr-lab.com/en/novel/7898/i-created-the-longevity-club";
const chapterUrl = (n: number) => `${NOVEL}/chapter-${n}`;
const TEXT = (n: number, mode: string) => Array.from({ length: 8 }, (_, i) => `Synthetic ${mode} filler paragraph ${i + 1} of chapter ${n}, standing in for the text of the book.`);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({ ok: status >= 200 && status < 300, status, data: JSON.stringify(data), headers });
const okChapter = (b: any) => json({ success: true, chapter: { raw_id: b.raw_id, order: b.chapter_no, title: `${b.translate} title ${b.chapter_no}` }, data: { data: { title: "x", body: TEXT(b.chapter_no, b.translate) } } });
const LOCKED = json({ success: false, code: "CHAPTER_LOCKED", message: "AI Translation Requires Registration" }, 403);
const TURNSTILE = json({ requireTurnstile: true, message: "Security Check Required" }, 403);
const ENCRYPTED = json({ success: true, data: { data: { title: "x", body: "arr:AAAA:BBBB:CCCC" } } });

/** Web podle popisu uživatele: AI bez přihlášení jen kapitoly 1–10; Web v chráněné podobě; Web+ čitelný. */
const siteAsDescribed = (b: any) => {
  if (b.translate === "ai") return b.chapter_no <= 10 || h.signedIn ? okChapter(b) : LOCKED;
  if (b.translate === "web") return ENCRYPTED;
  return okChapter(b);
};

const events: any[] = [];
downloadManager.on((e: any) => events.push(e));
const lastEnd = () => events.filter((e) => e.type === "project-end").at(-1);
const logs = () => events.filter((e) => e.type === "log").map((e) => e.message as string);
const count = (status: string) => h.chapters.filter((c) => c.status === status).length;

function seed(total: number, done: number, doneMode?: string) {
  for (let n = 1; n <= total; n++) {
    const c: any = { id: `c${n}`, projectId: "p1", title: `Chapter ${n}`, url: chapterUrl(n), orderIndex: n - 1, status: "pending" };
    if (n <= done) {
      const path = `NovelForge/projects/p1/c${n}.html`;
      h.files[path] = `<html>original ${n}</html>`;
      Object.assign(c, { status: "downloaded", filePath: path, fileSize: h.files[path].length, checksum: `orig${n}`, translationMode: doneMode });
    }
    h.chapters.push(c);
  }
}
const project = () => ({ ...h.projectRow, settings: { ...h.projectRow.settings } }) as unknown as Project;

beforeEach(async () => {
  await diag.flush();
  h.chapters.length = 0;
  for (const k of Object.keys(h.projectRow)) delete h.projectRow[k];
  Object.assign(h.projectRow, {
    id: "p1", title: "Sample Club", author: "Author", language: "en", sourceUrl: NOVEL, status: "paused", progress: 0,
    totalChapters: 0, downloadedChapters: 0, failedChapters: 0, settings: { concurrentRequests: 3, delayMs: 0, maxRetries: 0 },
  });
  for (const k of Object.keys(h.files)) delete h.files[k];
  for (const k of Object.keys(h.diagFiles)) delete h.diagFiles[k];
  h.posts.length = 0;
  h.gets.length = 0;
  h.post = siteAsDescribed;
  h.signedIn = false;
  h.network = { connected: true, connectionType: "wifi" };
  h.renders = 0;
  events.length = 0;
  const p = getParser(NOVEL) as any;
  p.chapterIntervalMs = 0;
  p.catalogDelayMs = 0;
  p.lastChapterAt = 0;
  p.sessionCache = null;
  downloadManager.rateLimitBackoffMs = 20;
  downloadManager.conditionPollMs = 10;
  downloadManager.setAppActive(true);
});

describe("WTR-LAB: zdroj a jeho limity", () => {
  it("nabízí překlady Web, Web+ a AI; rychlý režim nedovoluje; jede po jedné kapitole", () => {
    const info = parserInfo(NOVEL);
    expect(info.translationModes).toEqual([{ id: "web", label: "Web" }, { id: "webplus", label: "Web+" }, { id: "ai", label: "AI" }]);
    expect(info).toMatchObject({ name: "wtrlab", maxConcurrency: 1, allowFast: false, legacyTranslationMode: "ai" });
    expect(parserInfo("https://www.wuxiabox.com/novel/x_1.html")).toMatchObject({ translationModes: [], allowFast: true });
  });

  it("stav přihlášení se zjistí dotazem na relaci a nic se z něj neukládá", async () => {
    expect(await checkSession(NOVEL, { fresh: true })).toBe("signed-out");
    h.signedIn = true;
    expect(await checkSession(NOVEL)).toBe("signed-out"); // krátce se pamatuje
    expect(await checkSession(NOVEL, { fresh: true })).toBe("signed-in");
  });
});

describe("kapitoly 1–10 a hranice AI překladu", () => {
  it("nový projekt: kapitoly 1–10 se stáhnou v AI, u kapitoly 11 se stahování ZASTAVÍ po jediném požadavku", async () => {
    seed(3138, 0);
    await downloadManager.startProject(project());

    expect(count("downloaded")).toBe(10);
    expect(h.chapters.slice(0, 10).every((c) => c.translationMode === "ai")).toBe(true);
    expect(h.files["NovelForge/projects/p1/c3.html"]).toContain("Synthetic ai filler paragraph 1 of chapter 3");
    // jediný požadavek na kapitolu 11, žádný na 12+, žádný v jiném překladu, žádné vykreslování
    expect(h.posts.map((p) => p.body.chapter_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(h.posts.map((p) => p.body.translate))).toEqual(new Set(["ai"]));
    expect(h.renders).toBe(0);
    // kapitola 11 NENÍ chybná – čeká; nic neselhalo
    expect(h.chapters[10]).toMatchObject({ status: "pending", errorKind: "login-required" });
    expect(count("failed")).toBe(0);
    expect(count("pending")).toBe(3128);
    expect(h.projectRow).toMatchObject({ status: "waiting-auth", accessKind: "login-required", downloadedChapters: 10, failedChapters: 0, totalChapters: 3138 });
    expect(h.projectRow.settings.translationMode).toBe("ai");
    expect(h.projectRow.accessMessage).toMatch(/WTR-LAB vyžaduje přihlášení\. Stahování bylo pozastaveno a hotové kapitoly zůstaly uložené\./);
    expect(h.projectRow.accessMessage).toMatch(/Překlad AI kapitoly 11 .*jen přihlášeným/);
    expect(lastEnd()).toMatchObject({ ok: false, error: expect.stringMatching(/vyžaduje přihlášení/) });
    // text hlášky ani zamčená odpověď se nikdy neuloží jako kapitola
    expect(Object.keys(h.files)).toHaveLength(10);
    expect(Object.values(h.files).some((f) => /Requires Registration|CHAPTER_LOCKED/.test(f))).toBe(false);
  }, 30000);

  it("stav z telefonu (10 stažených, kapitoly 11–13 selhané, bez evidovaného překladu): nic se neztratí, počítadla sedí", async () => {
    seed(3138, 10);
    for (const n of [11, 12, 13]) Object.assign(h.chapters[n - 1], { status: "failed", errorMessage: "Text kapitoly se nepodařilo načíst", retryCount: 1 });
    Object.assign(h.projectRow, { status: "failed", downloadedChapters: 10, failedChapters: 3, totalChapters: 3138 });
    const before = { ...h.files };
    await downloadManager.startProject(project());

    expect(logs()).toContain("Stahuji 3128 kapitol (10 už hotovo).");
    expect(logs().some((m) => /neměl evidovaný překlad – nastaven AI/.test(m))).toBe(true);
    expect(h.posts).toHaveLength(1); // jen kapitola 11, dřív desítky pokusů
    expect(h.files).toEqual(before);
    for (let n = 1; n <= 10; n++) expect(h.chapters[n - 1]).toMatchObject({ status: "downloaded", checksum: `orig${n}`, translationMode: "ai" });
    expect(h.projectRow).toMatchObject({ status: "waiting-auth", downloadedChapters: 10, failedChapters: 0, totalChapters: 3138 });
    expect(count("failed")).toBe(0);
    expect(count("pending")).toBe(3128);
  }, 30000);

  it("přihlášený účet a přesto zamčeno => „zamčený překlad“, ne výzva k přihlášení", async () => {
    seed(12, 10, "ai");
    h.signedIn = true;
    h.post = (b) => (b.chapter_no > 10 ? json({ code: "CHAPTER_LOCKED" }, 403) : okChapter(b));
    await downloadManager.startProject(project());
    expect(h.projectRow).toMatchObject({ status: "waiting-auth", accessKind: "translation-locked" });
    expect(h.projectRow.accessMessage).toMatch(/zamčený.*Aplikace zamčený obsah nezískává/);
    expect(h.posts).toHaveLength(1);
  });
});

describe("kapitola 11 v režimech Web, Web+ a AI", () => {
  it("ověření dostupnosti: každý překlad dostane právě jeden běžný požadavek a vlastní důvod", async () => {
    const probes = await probeTranslationModes(chapterUrl(11));
    expect(probes.map((p) => [p.mode, p.state])).toEqual([["web", "mode-unsupported"], ["webplus", "available"], ["ai", "login-required"]]);
    expect(probes[0].message).toMatch(/chráněné podobě.*nedešifruje/);
    expect(probes[2].message).toMatch(/jen přihlášeným/);
    expect(h.posts.map((p) => p.body.translate)).toEqual(["web", "webplus", "ai"]);
    expect(h.posts.every((p) => p.body.chapter_no === 11 && p.body.raw_id === 7898)).toBe(true);
  });

  it("při bezpečnostním ověření se další překlady nezkouší", async () => {
    h.post = () => TURNSTILE;
    const probes = await probeTranslationModes(chapterUrl(11));
    expect(probes.map((p) => p.state)).toEqual(["challenge", "unknown", "unknown"]);
    expect(h.posts).toHaveLength(1);
  });

  it("Web v chráněné podobě: stahování se zastaví, nic se nedešifruje ani neukládá", async () => {
    seed(20, 0);
    h.projectRow.settings.translationMode = "web";
    await downloadManager.startProject(project());
    expect(h.posts).toHaveLength(1);
    expect(h.projectRow).toMatchObject({ status: "paused", accessKind: "mode-unsupported" });
    expect(h.projectRow.accessMessage).toMatch(/v podobě, kterou aplikace nečte.*Zvolte jiný překlad/);
    expect(Object.keys(h.files)).toHaveLength(0);
    expect(count("failed")).toBe(0);
  });

  it("uživatel přepne projekt na Web+: další kapitoly jdou ve Web+, hotové AI kapitoly zůstávají beze změny", async () => {
    seed(3138, 10, "ai");
    const before = { ...h.files };
    h.projectRow.settings.translationMode = "webplus";
    let served = 0;
    h.post = (b) => {
      if (++served === 100) downloadManager.pauseProject("p1");
      return siteAsDescribed(b);
    };
    await downloadManager.startProject(project());

    expect(new Set(h.posts.map((p) => p.body.translate))).toEqual(new Set(["webplus"]));
    expect(h.posts[0].body.chapter_no).toBe(11);
    expect(count("downloaded")).toBe(110); // 100 kapitol v jednom běhu bez chyby
    expect(count("failed")).toBe(0);
    for (let n = 1; n <= 10; n++) {
      expect(h.chapters[n - 1]).toMatchObject({ translationMode: "ai", checksum: `orig${n}` });
      expect(h.files[`NovelForge/projects/p1/c${n}.html`]).toBe(before[`NovelForge/projects/p1/c${n}.html`]);
    }
    expect(h.chapters.slice(10, 110).every((c) => c.translationMode === "webplus")).toBe(true);
    expect(h.files["NovelForge/projects/p1/c11.html"]).toContain("Synthetic webplus filler");
    expect(h.projectRow).toMatchObject({ status: "paused", downloadedChapters: 110 });
  }, 60000);
});

describe("bezpečnostní ověření a obnovení", () => {
  it("Turnstile: stav „vyžadováno ověření“, jediný požadavek, nic se neobchází", async () => {
    seed(3138, 10, "ai");
    h.post = () => TURNSTILE;
    await downloadManager.startProject(project());
    expect(h.posts).toHaveLength(1);
    expect(h.renders).toBe(0);
    expect(h.projectRow).toMatchObject({ status: "verification-required", accessKind: "challenge", downloadedChapters: 10 });
    expect(h.projectRow.accessMessage).toMatch(/WTR-LAB vyžaduje bezpečnostní ověření\. Stahování bylo pozastaveno a hotové kapitoly zůstaly uložené\..*proveďte sami/);
    expect(h.chapters[10]).toMatchObject({ status: "pending", errorKind: "challenge" });
    expect(count("failed")).toBe(0);
    // požadavek neobsahuje žádný ověřovací token
    expect(Object.keys(h.posts[0].body).sort()).toEqual(["chapter_no", "force_retry", "language", "raw_id", "retry", "translate"]);
  });

  it("ověřovací stránka Cloudflare (HTML) místo JSON se pozná stejně", async () => {
    seed(30, 10, "ai");
    h.post = () => ({ ok: false, status: 403, headers: { "cf-mitigated": "challenge" }, data: "<html><head><title>Just a moment...</title></head><body></body></html>" });
    await downloadManager.startProject(project());
    expect(h.projectRow.status).toBe("verification-required");
    expect(h.posts).toHaveLength(1);
  });

  it("po přihlášení (provedl uživatel) pokračuje od kapitoly 11; stav překážky se smaže", async () => {
    seed(40, 10, "ai");
    await downloadManager.startProject(project());
    expect(h.projectRow.status).toBe("waiting-auth");

    h.signedIn = true; // uživatel se přihlásil ve webovém okně
    h.posts.length = 0;
    await downloadManager.startProject(project());
    expect(h.posts.map((p) => p.body.chapter_no)).toEqual(Array.from({ length: 30 }, (_, i) => 11 + i));
    expect(h.projectRow).toMatchObject({ status: "completed", downloadedChapters: 40, accessKind: "", accessMessage: "" });
    expect(h.chapters.every((c) => c.translationMode === "ai" && c.status === "downloaded")).toBe(true);
    expect(h.chapters[10].errorKind).toBe("");
  });
});

describe("omezení počtu požadavků a odmítnutý přístup", () => {
  it("HTTP 429 s Retry-After: počká, zpomalí, kapitolu neoznačí za chybnou a pokračuje", async () => {
    seed(14, 10, "ai");
    h.signedIn = true;
    let limited = 0;
    h.post = (b) => {
      if (b.chapter_no === 12 && limited < 2) {
        limited++;
        return json({ message: "Too Many Requests" }, 429, { "Retry-After": "0.08" });
      }
      return okChapter(b);
    };
    await downloadManager.startProject(project());
    const twelve = h.posts.filter((p) => p.body.chapter_no === 12);
    expect(twelve).toHaveLength(3);
    expect(twelve[1].at - twelve[0].at).toBeGreaterThanOrEqual(75); // Retry-After 80 ms > backoff 20 ms
    expect(h.projectRow).toMatchObject({ status: "completed", failedChapters: 0 });
    expect(logs().some((m) => /HTTP 429.*Čekám .* a zpomaluji/.test(m))).toBe(true);
  });

  it("trvalé HTTP 429: po čtyřech čekáních stav „omezeno webem“, žádné stovky pokusů", async () => {
    seed(3138, 10, "ai");
    h.signedIn = true;
    h.post = () => json({}, 429);
    await downloadManager.startProject(project());
    expect(h.posts).toHaveLength(5);
    expect(new Set(h.posts.map((p) => p.body.chapter_no))).toEqual(new Set([11]));
    expect(h.projectRow).toMatchObject({ status: "rate-limited", accessKind: "rate-limited", downloadedChapters: 10 });
    expect(h.chapters[10].status).toBe("pending");
    expect(count("failed")).toBe(0);
  });

  it("HTTP 403 dvakrát po sobě: stahování se zastaví s důvodem „přístup odmítnut“", async () => {
    seed(3138, 10, "ai");
    h.post = () => json({ message: "Forbidden" }, 403);
    await downloadManager.startProject(project());
    expect(h.posts).toHaveLength(2);
    expect(count("failed")).toBe(2);
    expect(h.chapters[10]).toMatchObject({ status: "failed", errorKind: "forbidden" });
    expect(h.projectRow).toMatchObject({ status: "paused", accessKind: "forbidden" });
  });

  it("neexistující kapitola (404) je chyba jedné kapitoly, další se stahují", async () => {
    seed(14, 10, "ai");
    h.signedIn = true;
    h.post = (b) => (b.chapter_no === 12 ? json({ message: "Not found" }, 404) : okChapter(b));
    await downloadManager.startProject(project());
    expect(h.chapters[11]).toMatchObject({ status: "failed", errorKind: "unavailable" });
    expect(count("downloaded")).toBe(13);
    expect(h.projectRow.status).toBe("failed");
  });

  it("chyba ukládání souboru zastaví stahování hned (ne chyba kapitoly)", async () => {
    seed(30, 10, "ai");
    h.signedIn = true;
    const { storage } = await import("@/services/storage");
    (storage.writeFile as any).mockImplementationOnce(async () => {
      throw new Error("No space left on device");
    });
    await downloadManager.startProject(project());
    expect(h.posts).toHaveLength(1);
    expect(h.projectRow).toMatchObject({ status: "paused", accessKind: "storage" });
    expect(h.projectRow.accessMessage).toMatch(/nepodařilo uložit.*No space left/);
    expect(h.chapters[10]).toMatchObject({ status: "pending", errorKind: "storage" });
  });

  it("výpadek internetu: chyba sítě, po pěti kapitolách pozastaveno; po obnovení dokončí", async () => {
    seed(30, 10, "ai");
    h.signedIn = true;
    h.post = () => {
      throw new Error("The Internet connection appears to be offline.");
    };
    await downloadManager.startProject(project());
    expect(h.projectRow.status).toBe("paused");
    expect(count("failed")).toBe(5);
    expect(h.chapters[10].errorKind).toBe("network");
    h.post = siteAsDescribed;
    await downloadManager.startProject(project());
    expect(h.projectRow).toMatchObject({ status: "completed", downloadedChapters: 30, failedChapters: 0 });
  });
});

describe("běh na pozadí, podmínky a statistika", () => {
  it("zamčení telefonu / přepnutí aplikace: nová kapitola se nezačne, přerušený požadavek není chyba, po návratu pokračuje", async () => {
    seed(16, 10, "ai");
    h.signedIn = true;
    let n = 0;
    h.post = async (b) => {
      n++;
      if (n === 2) {
        // aplikace jde na pozadí uprostřed požadavku a iOS přeruší síť
        downloadManager.setAppActive(false);
        setTimeout(() => downloadManager.setAppActive(true), 60);
        throw new Error("The network connection was lost.");
      }
      return okChapter(b);
    };
    await downloadManager.startProject(project());
    expect(downloadManager.isAppActive()).toBe(true);
    expect(h.posts.map((p) => p.body.chapter_no)).toEqual([11, 12, 12, 13, 14, 15, 16]);
    expect(h.posts[2].at - h.posts[1].at).toBeGreaterThanOrEqual(50); // čekalo se na návrat
    expect(h.projectRow).toMatchObject({ status: "completed", failedChapters: 0 });
    expect(count("failed")).toBe(0);
  });

  it("jen přes Wi-Fi: na mobilních datech čeká a po připojení k Wi-Fi pokračuje samo", async () => {
    seed(13, 10, "ai");
    h.signedIn = true;
    h.projectRow.settings.wifiOnly = true;
    h.network = { connected: true, connectionType: "cellular" };
    setTimeout(() => (h.network = { connected: true, connectionType: "wifi" }), 60);
    await downloadManager.startProject(project());
    expect(logs().some((m) => /není na Wi-Fi.*čekám/.test(m))).toBe(true);
    expect(logs()).toContain("Podmínky splněny – pokračuji.");
    expect(h.projectRow.status).toBe("completed");
  });

  it("úsporný režim a rychlý režim: WTR-LAB zůstává u jedné kapitoly; rychlý se nepoužije", async () => {
    seed(12, 10, "ai");
    h.signedIn = true;
    h.projectRow.settings.speedMode = "fast";
    await downloadManager.startProject(project());
    expect(logs()).toContain("Rychlý režim tento web nedovoluje – použije se vyvážený.");
    expect(h.projectRow.status).toBe("completed");
  });

  it("živé údaje: kapitoly za minutu, průměr, odhad, překlad; měření kroků v diagnostice", async () => {
    seed(60, 10, "ai");
    h.signedIn = true;
    let view: any;
    let served = 0;
    h.post = (b) => {
      if (++served === 40) view = { ...downloadManager.getRunView("p1") };
      return okChapter(b);
    };
    await downloadManager.startProject(project());
    expect(view).toMatchObject({ speedMode: "balanced", effectiveSpeedMode: "balanced", concurrency: 1, translationMode: "ai", translationLabel: "AI", waiting: null });
    expect(view.perMinute).toBeGreaterThan(0);
    expect(view.avgChapterMs).toBeGreaterThanOrEqual(0);
    expect(view.etaMs).toBeGreaterThan(0);
    expect(downloadManager.getRunView("p1")).toBeUndefined(); // po skončení běhu
    await diag.flush();
    const text = h.diagFiles[DIAG_FILE];
    expect(text).toMatch(/ run-timing project="p1" chapters=50 perMinute=[\d.]+ avgChapterMs=\d+ avgFetchMs=\d+ avgCleanMs=\d+ avgWriteMs=\d+ avgDbMs=\d+ delayMs=0 concurrency=1 slowdowns=0/);
    expect(text).not.toMatch(/Synthetic ai filler|cookie|token/i);
  });
});
