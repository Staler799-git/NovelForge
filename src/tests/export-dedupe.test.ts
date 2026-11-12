import { describe, it, expect, vi } from "vitest";

vi.mock("@capacitor/camera", () => ({ Camera: {}, CameraResultType: {}, CameraSource: {} }));
import { dedupeByContent } from "@/pages/EpubExport";

describe("vynechání duplicitního obsahu při exportu", () => {
  it("vynechá jen kapitoly se shodným otiskem obsahu a zachová pořadí", () => {
    const a = "aaaaaaaaaaaaaaaa";
    const b = "bbbbbbbbbbbbbbbb";
    const out = dedupeByContent([
      { orderIndex: 3, checksum: a, title: "1 Chapter 1 Named" },
      { orderIndex: 0, checksum: a, title: "001 Chapter 001" },
      { orderIndex: 1, checksum: b, title: "002 Chapter 002" },
      { orderIndex: 2, checksum: undefined, title: "no checksum" },
      { orderIndex: 4, checksum: "1234abcd", title: "legacy 8-char checksum" },
      { orderIndex: 5, checksum: "1234abcd", title: "legacy 8-char checksum again" },
    ]);
    expect(out.map((c) => c.orderIndex)).toEqual([0, 1, 2, 4, 5]);
  });

  it("stejné číslo v názvu samo o sobě duplicitou není", () => {
    const out = dedupeByContent([
      { orderIndex: 0, checksum: "1111111111111111", title: "Chapter 1" },
      { orderIndex: 1, checksum: "2222222222222222", title: "Chapter 1" },
    ]);
    expect(out).toHaveLength(2);
  });
});
