/** Jednotný stav projektu pro všechny obrazovky + kontrola před exportem. */
import { describe, it, expect } from "vitest";
import { projectStatus } from "@/services/status";
import { preflight } from "@/services/preflight";
import type { Chapter } from "@/types";

const p = (status: string, downloaded: number, total = 100) => ({ status, totalChapters: total, downloadedChapters: downloaded }) as any;

describe("projectStatus", () => {
  it("běžící stahování má přednost před stavem v databázi", () => {
    for (const s of ["idle", "paused", "downloading", "failed", "completed"]) expect(projectStatus(p(s, 10), true).label).toBe("Stahuje se");
  });
  it("„downloading“ v databázi, ale nic neběží (po restartu aplikace) => Pozastaveno", () => {
    expect(projectStatus(p("downloading", 57, 3237), false)).toMatchObject({ key: "interrupted", label: "Pozastaveno" });
  });
  it("Dokončeno jen když jsou stažené všechny vybrané kapitoly", () => {
    expect(projectStatus(p("completed", 100), false).label).toBe("Dokončeno");
    expect(projectStatus(p("completed", 99), false).label).toBe("Pozastaveno");
    expect(projectStatus(p("completed", 0, 0), false).label).toBe("Pozastaveno");
  });
  it("ostatní stavy", () => {
    expect(projectStatus(p("failed", 90), false).label).toBe("Dokončeno s chybami");
    expect(projectStatus(p("paused", 5), false).label).toBe("Pozastaveno");
    expect(projectStatus(p("idle", 0), false).label).toBe("Připraveno");
    expect(projectStatus(p("idle", 5), false).label).toBe("Pozastaveno");
  });
  it("stejný vstup dává stejný popisek – obrazovky se nemohou rozejít", () => {
    const a = projectStatus(p("downloading", 57, 3237), false);
    const b = projectStatus(p("downloading", 57, 3237), false);
    expect(a).toEqual(b);
  });
});

describe("kontrola před exportem", () => {
  const row = (suffix: string, order: number, o: Partial<Chapter> = {}) =>
    ({ url: `https://www.wuxiabox.com/novel/sample_${suffix}.html`, title: `Chapter ${suffix}`, status: "downloaded", orderIndex: order, checksum: `aaaaaaaaaaaa${String(order).padStart(4, "0")}`, ...o }) as Chapter;

  it("úplná kniha s obálkou je bez varování", () => {
    const r = preflight(Array.from({ length: 20 }, (_, i) => row(String(i + 1), i)), true);
    expect(r.issues.filter((i) => i.level === "warn")).toEqual([]);
    expect(r).toMatchObject({ total: 20, downloaded: 20, duplicates: 0, variantLabel: null });
  });
  it("hlásí chybějící kapitoly uprostřed a neúplnost", () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(String(i + 1), i, i === 7 || i === 8 ? { status: "pending", checksum: undefined } : {}));
    const r = preflight(rows, true);
    expect(r.issues.find((i) => i.code === "incomplete")?.message).toMatch(/staženo 18 z 20/);
    expect(r.issues.find((i) => i.code === "gaps")?.message).toMatch(/chybí 2 \(např\. 8, 9\)/);
  });
  it("hlásí stejný text u dvou kapitol, selhané kapitoly a chybějící obálku", () => {
    const rows = [row("1", 0), row("2", 1, { checksum: "aaaaaaaaaaaa0000" }), row("3", 2, { status: "failed", checksum: undefined })];
    const r = preflight(rows, false);
    expect(r.duplicates).toBe(1);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["duplicates", "failed", "cover", "incomplete"]));
  });
  it("hlásí špatné pořadí", () => {
    const r = preflight([row("1", 0), row("3", 1), row("2", 2), row("4", 3)], true);
    expect(r.issues.some((i) => /Pořadí 1 kapitol neodpovídá/.test(i.message))).toBe(true);
  });
  it("obě verze v knize => varování; vyřazená verze se nepočítá", () => {
    const both = [row("001", 0), row("1", 1), row("002", 2), row("2", 3), row("3", 4)];
    const r1 = preflight(both, true);
    expect(r1.variantLabel).toBe("obě verze");
    expect(r1.issues.find((i) => i.code === "variants")).toMatchObject({ level: "warn" });
    const r2 = preflight(both.map((c) => (/_0/.test(c.url) ? { ...c, excluded: true } : c)), true);
    expect(r2.total).toBe(3);
    expect(r2.variantLabel).toMatch(/hlavní řada/);
    expect(r2.issues.find((i) => i.code === "variants")).toMatchObject({ level: "info" });
    const r3 = preflight(both.map((c) => (/_[12]\.html/.test(c.url) ? { ...c, excluded: true } : c)), true);
    expect(r3.variantLabel).toMatch(/alternativní řada/);
    expect(r3.issues.find((i) => i.code === "variants")?.message).toMatch(/změní překlad/);
  });
});
