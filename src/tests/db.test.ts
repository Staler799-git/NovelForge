import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ method: string; arg: any }> = [];
let connectionExists = false;
let queryRows: any[] = [];

vi.mock("@capacitor-community/sqlite", () => {
  const rec = (method: string, impl?: (a: any) => any) =>
    vi.fn(async (arg: any) => {
      calls.push({ method, arg });
      return impl ? impl(arg) : {};
    });
  return {
    CapacitorSQLite: {
      // chová se jako nativní iOS plugin: druhé createConnection vyhodí chybu
      createConnection: rec("createConnection", () => {
        if (connectionExists) throw new Error("CreateConnection: Connection novelforge already exists");
        connectionExists = true;
      }),
      open: rec("open"),
      execute: rec("execute"),
      run: rec("run", () => ({ changes: { changes: 1 } })),
      query: rec("query", () => ({ values: queryRows })),
      close: rec("close"),
      closeConnection: rec("closeConnection", () => {
        connectionExists = false;
      }),
    },
  };
});

import { CapacitorDatabase, chapterId } from "@/services/db";

const of = (m: string) => calls.filter((c) => c.method === m);

beforeEach(() => {
  calls.length = 0;
  connectionExists = false;
  queryRows = [];
});

describe("databáze", () => {
  it("init() je idempotentní – opakované volání nespadne a neotvírá spojení znovu", async () => {
    const db = new CapacitorDatabase();
    await db.init();
    await db.init();
    await Promise.all([db.init(), db.init()]);
    expect(of("createConnection")).toHaveLength(1);
    expect(of("open")).toHaveLength(1);
  });

  it("přežije spojení, které už existuje (znovunačtení WebView)", async () => {
    connectionExists = true;
    const db = new CapacitorDatabase();
    await expect(db.init()).resolves.toBeUndefined();
    expect(of("open")).toHaveLength(1);
  });

  it("po neúspěšném init() to další volání zkusí znovu", async () => {
    const { CapacitorSQLite } = await import("@capacitor-community/sqlite");
    (CapacitorSQLite.open as any).mockRejectedValueOnce(new Error("disk I/O error"));
    const db = new CapacitorDatabase();
    await expect(db.init()).rejects.toThrow("disk I/O error");
    await expect(db.init()).resolves.toBeUndefined();
  });

  it("zápisy jdou přes run(), ne přes query()", async () => {
    const db = new CapacitorDatabase();
    await db.init();
    calls.length = 0;
    await db.updateChapter("c1", { status: "downloaded", filePath: "a/b.html", fileSize: 10, checksum: "0123456789abcdef" });
    await db.updateProject("p1", { status: "downloading", progress: 5 });
    expect(of("query")).toHaveLength(0);
    expect(of("run")).toHaveLength(2);
    expect(of("run")[0].arg.statement).toMatch(/^UPDATE chapters SET status = \?, file_path = \?, file_size = \?, checksum = \? WHERE id = \?$/);
    expect(of("run")[0].arg.values).toEqual(["downloaded", "a/b.html", 10, "0123456789abcdef", "c1"]);
  });

  it("odfiltruje pomocný iOS záznam ios_columns", async () => {
    const db = new CapacitorDatabase();
    await db.init();
    queryRows = [
      { ios_columns: ["status", "c"] },
      { status: "downloaded", c: 7 },
      { status: "failed", c: 2 },
      { status: "pending", c: 91 },
    ];
    expect(await db.getChapterStats("p1")).toEqual({ total: 100, downloaded: 7, failed: 2 });

    queryRows = [{ ios_columns: ["id"] }];
    expect(await db.getProject("nope")).toBeNull();
    expect(await db.getChapters("p1")).toEqual([]);

    queryRows = [
      { ios_columns: ["id"] },
      { id: "x", project_id: "p1", title: "T", url: "https://e/1", order_index: 4, status: "downloaded", file_path: "f", file_size: 9, checksum: "abc", retry_count: 0 },
    ];
    const [ch] = await db.getChapters("p1");
    expect(ch).toMatchObject({ id: "x", orderIndex: 4, status: "downloaded", filePath: "f", fileSize: 9, checksum: "abc" });
  });

  it("vloží 3 138 kapitol po dávkách a ve správném pořadí", async () => {
    const db = new CapacitorDatabase();
    await db.init();
    calls.length = 0;
    const list = Array.from({ length: 3138 }, (_, i) => ({ title: `Chapter ${i + 1}`, url: `https://e/${i + 1}.html`, orderIndex: i }));
    await db.upsertChapters("project-1", list);
    const runs = of("run");
    expect(runs).toHaveLength(Math.ceil(3138 / 80));
    const values = runs.flatMap((r) => r.arg.values as unknown[]);
    expect(values).toHaveLength(3138 * 5);
    const ids = new Set<string>();
    for (let i = 0; i < 3138; i++) {
      ids.add(values[i * 5] as string);
      expect(values[i * 5 + 4]).toBe(i);
    }
    expect(ids.size).toBe(3138);
    // stav už stažených kapitol se opakovaným vložením nemění
    expect(runs[0].arg.statement).not.toMatch(/status\s*=\s*excluded/);
  });

  it("ID kapitoly je vázané na projekt – stejná novela podruhé nepřepíše první", () => {
    const a = chapterId("11111111-aaaa", "https://e/1.html");
    const b = chapterId("22222222-bbbb", "https://e/1.html");
    expect(a).not.toBe(b);
    expect(chapterId("11111111-aaaa", "https://e/1.html")).toBe(a);
    expect(chapterId("11111111-aaaa", "https://e/2.html")).not.toBe(a);
  });

  it("smazání projektu smaže i jeho kapitoly", async () => {
    const db = new CapacitorDatabase();
    await db.init();
    calls.length = 0;
    await db.deleteProject("p1");
    expect(of("run").map((r) => r.arg.statement)).toEqual(["DELETE FROM chapters WHERE project_id = ?", "DELETE FROM projects WHERE id = ?"]);
  });
});
