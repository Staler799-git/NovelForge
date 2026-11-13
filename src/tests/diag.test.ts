import { describe, it, expect, vi, beforeEach } from "vitest";

const fs = vi.hoisted(() => ({ files: {} as Record<string, string> }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async ({ path }: any) => {
      if (!(path in fs.files)) throw new Error("missing");
      return { size: fs.files[path].length };
    }),
    appendFile: vi.fn(async ({ path, data }: any) => {
      fs.files[path] = (fs.files[path] ?? "") + data;
    }),
    writeFile: vi.fn(async ({ path, data }: any) => {
      fs.files[path] = data;
    }),
    readFile: vi.fn(async ({ path }: any) => {
      if (!(path in fs.files)) throw new Error("missing");
      return { data: fs.files[path] };
    }),
    deleteFile: vi.fn(async ({ path }: any) => {
      delete fs.files[path];
    }),
    rename: vi.fn(async ({ from, to }: any) => {
      fs.files[to] = fs.files[from];
      delete fs.files[from];
    }),
  },
}));

import { Filesystem } from "@capacitor/filesystem";
import { diag, analyzeSession, formatLine, redactText, redactUrl, installGlobalErrorLogging, DIAG_FILE, DIAG_OLD_FILE } from "@/services/diag";

beforeEach(async () => {
  await diag.clear();
  for (const k of Object.keys(fs.files)) delete fs.files[k];
});

describe("skrývání citlivých údajů", () => {
  it("adresa se ukládá bez hodnot parametrů, bez kotvy a bez dlouhých náhodných řetězců", () => {
    expect(redactUrl("https://wtr-lab.com/api/chapters/7898?start=1&end=500")).toBe("https://wtr-lab.com/api/chapters/7898?start&end");
    expect(redactUrl("https://x.com/a?token=abc123&page=2#frag")).toBe("https://x.com/a?…&page");
    expect(redactUrl("https://cdn.x.com/c/" + "a".repeat(40) + "/11.json?sig=zzz")).toBe("https://cdn.x.com/c/[skryto]/11.json?sig");
    expect(redactUrl("https://user:heslo@x.com/a")).toBe("https://x.com/a");
  });

  it("z textu chyb mizí cookies, tokeny, hesla a hodnoty parametrů", () => {
    const out = redactText("Failed https://x.com/p?session=SECRET1 Authorization: Bearer SECRET3 password=SECRET4 token: SECRET5 Cookie: cf_clearance=SECRET2; sid=SECRET6");
    for (let i = 1; i <= 6; i++) expect(out).not.toContain(`SECRET${i}`);
    expect(out).toContain("https://x.com/p");
    expect(redactText("id " + "Zm9v".repeat(12))).toBe("id [skryto]");
  });

  it("pole s citlivým názvem se nezapíše vůbec", () => {
    const line = formatLine(new Date(0), "http-end", { status: 200, cookie: "cf=1", authorization: "Bearer x", headers_token: "t", url: "https://x.com/a?k=v" });
    expect(line).toBe("1970-01-01T00:00:00.000Z http-end status=200 cookie=[skryto] authorization=[skryto] headers_token=[skryto] url=https://x.com/a?k");
  });
});

describe("trvalý záznam", () => {
  it("každý záznam se připíše do souboru; begin/end nese číslo operace a dobu", async () => {
    const end = diag.begin("http", { method: "GET", url: "https://x.com/a?b=1" });
    end({ status: 200, bytes: 10 });
    end({ status: 500 }); // druhé volání se ignoruje
    await diag.flush();
    const lines = fs.files[DIAG_FILE].trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\S+ http-start op=\d+ method="GET" url=https:\/\/x\.com\/a\?b$/);
    expect(lines[1]).toMatch(/^\S+ http-end op=\d+ ms=\d+ status=200 bytes=10$/);
  });

  it("selhání zápisu nikdy nevyhodí chybu a další zápisy pokračují", async () => {
    (Filesystem.appendFile as any).mockRejectedValueOnce(new Error("disk full"));
    expect(() => diag.log("a")).not.toThrow();
    diag.log("b");
    await expect(diag.flush()).resolves.toBeUndefined();
    expect(fs.files[DIAG_FILE]).toMatch(/ b\n$/);
  });

  it("velký soubor se přetočí do .old a export obsahuje obojí", async () => {
    fs.files[DIAG_FILE] = "2020-01-01T00:00:00.000Z old-line\n" + "x".repeat(400_100) + "\n";
    diag.log("new-line");
    await diag.flush();
    expect(fs.files[DIAG_OLD_FILE]).toContain("old-line");
    expect(fs.files[DIAG_FILE]).toMatch(/^\S+ new-line\n$/);
    const path = await diag.exportFile();
    expect(fs.files[path]).toContain("old-line");
    expect(fs.files[path]).toContain("new-line");
    expect(fs.files[path]).toContain("NovelForge – diagnostika");
  });
});

describe("rozpoznání nečekaného ukončení", () => {
  const T = "2026-11-12T10:00:00.000Z";
  it("běh bez konce a s rozpracovaným vykreslením = přerušeno, známe poslední operaci", () => {
    const s = analyzeSession([
      `${T} session-start version="1.2.2"`,
      `${T} run-start op=1 project="p1"`,
      `${T} chapter-start op=2 no="11" url=https://wtr-lab.com/x/chapter-11`,
      `${T} http-start op=3 method="POST" url=https://wtr-lab.com/api/reader/get`,
      `${T} http-end op=3 ms=120 status=200`,
      `${T} render-start op=4 url=https://wtr-lab.com/x/chapter-11`,
    ]);
    expect(s.interrupted).toBe(true);
    expect(s.openOperations.map((l) => l.split(" ")[1])).toEqual(["run-start", "chapter-start", "render-start"]);
    expect(s.lastCompleted).toContain("http-end op=3");
  });

  it("řádně pozastavený běh není přerušení", () => {
    const s = analyzeSession([`${T} session-start`, `${T} run-start op=1`, `${T} chapter-start op=2`, `${T} chapter-end op=2 ms=5 ok=true`, `${T} run-end op=1 ms=9 ok=true`]);
    expect(s.interrupted).toBe(false);
    expect(s.openOperations).toEqual([]);
  });

  it("ukončení na pozadí (iOS) se nepočítá jako pád", () => {
    const s = analyzeSession([`${T} session-start`, `${T} run-start op=1`, `${T} chapter-end op=2 ms=5 ok=true`, `${T} app-background`]);
    expect(s.interrupted).toBe(false);
  });

  it("hodnotí jen poslední spuštění", () => {
    const s = analyzeSession([`${T} session-start`, `${T} run-start op=1`, `${T} session-start`, `${T} run-start op=1`, `${T} run-end op=1 ms=1 ok=true`]);
    expect(s.interrupted).toBe(false);
  });

  it("startSession po pádu: ohlásí přerušení a zapíše nový začátek", async () => {
    fs.files[DIAG_FILE] = [`${T} session-start`, `${T} run-start op=1 project="p1"`, `${T} render-start op=2 url=https://wtr-lab.com/x/chapter-11`].join("\n") + "\n";
    const prev = await diag.startSession();
    expect(prev.interrupted).toBe(true);
    expect(diag.previousSession()?.openOperations.at(-1)).toContain("render-start");
    const text = fs.files[DIAG_FILE];
    expect(text).toMatch(/ session-start version=/);
    expect(text).toMatch(/ previous-session-interrupted open=2 /);
    const path = await diag.exportFile();
    expect(fs.files[path]).toContain("Minulé spuštění skončilo nečekaně");
    expect(fs.files[path]).toContain("nedokončeno: ");
  });

  it("první spuštění bez souboru", async () => {
    const prev = await diag.startSession();
    expect(prev).toMatchObject({ interrupted: false, openOperations: [] });
  });
});

describe("globální zachycení chyb", () => {
  it("neobsloužená Promise a chyba skriptu se zapíší do záznamu", async () => {
    const handlers: Record<string, (e: any) => void> = {};
    installGlobalErrorLogging({ addEventListener: ((name: string, cb: any) => { handlers[name] = cb; }) as any });
    const preventDefault = vi.fn();
    handlers.unhandledrejection({ reason: new Error("boom token=abc"), preventDefault });
    handlers.error({ message: "ReferenceError: x", filename: "capacitor://localhost/assets/index-abc.js", lineno: 7 });
    await diag.flush();
    expect(preventDefault).toHaveBeenCalled();
    expect(fs.files[DIAG_FILE]).toMatch(/ unhandled-rejection error="boom token=\[skryto\]"/);
    expect(fs.files[DIAG_FILE]).toMatch(/ script-error error="ReferenceError: x" where="index-abc\.js:7"/);
  });
});
