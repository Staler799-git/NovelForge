import { describe, it, expect, vi, beforeEach } from "vitest";
import { bytesToBase64, base64ToBytes } from "@/services/http";

const written: Array<{ path: string; data: string; encoding?: string }> = [];
let response: any;

vi.mock("@capacitor/camera", () => ({ Camera: {}, CameraResultType: { Base64: "base64" }, CameraSource: { Photos: "PHOTOS" } }));
vi.mock("@capacitor/share", () => ({ Share: {} }));
vi.mock("@capacitor/haptics", () => ({ Haptics: {}, ImpactStyle: {} }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (o: any) => {
      written.push({ path: o.path, data: o.data, encoding: o.encoding });
    }),
    readFile: vi.fn(async (o: any) => {
      const f = written.find((w) => w.path === o.path);
      if (!f) throw new Error("File does not exist");
      return { data: f.data };
    }),
  },
}));
vi.mock("@/services/http", async (orig) => {
  const real = await orig<typeof import("@/services/http")>();
  return { ...real, http: { ...real.http, getBinary: vi.fn(async (...a: any[]) => response(...a)) } };
});
import { http } from "@/services/http";
import { sniffImageMime, extForMime, downloadCover, saveCover, readCover, coverDataUri } from "@/services/cover";

const b64 = (bytes: number[]) => bytesToBase64(new Uint8Array([...bytes, ...new Array(24).fill(0)]));
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const HTML = bytesToBase64(new TextEncoder().encode("<!DOCTYPE html><html><body>403 Forbidden</body></html>"));

beforeEach(() => {
  written.length = 0;
  vi.clearAllMocks();
});

describe("typ obrázku podle skutečného obsahu", () => {
  it("rozpozná JPEG, PNG, GIF a WebP podle magic bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("HTML stránku ani nesmysl za obrázek nepovažuje", () => {
    expect(sniffImageMime(HTML)).toBeNull();
    expect(sniffImageMime("")).toBeNull();
    expect(sniffImageMime("@@@not-base64@@@")).toBeNull();
  });
  it("přípona odpovídá MIME typu", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/webp")).toBe("webp");
    expect(extForMime("image/jpeg")).toBe("jpg");
  });
});

describe("stažení a uložení obálky", () => {
  it("stahuje nativní HTTP vrstvou s Refererem a typ určí z obsahu, ne z přípony", async () => {
    response = async () => ({ ok: true, status: 200, base64: PNG, contentType: "image/jpeg" });
    const data = await downloadCover("https://cdn.example/covers/book.jpg", "https://www.example.com/novel/book.html");
    expect(data).toEqual({ base64: PNG, mime: "image/png" });
    expect(http.getBinary).toHaveBeenCalledWith(
      "https://cdn.example/covers/book.jpg",
      expect.objectContaining({ headers: { Referer: "https://www.example.com/novel/book.html" } }),
    );
  });

  it("když server s Refererem odmítne, zkusí to bez něj", async () => {
    response = async (_u: string, o: any) =>
      o.headers.Referer ? { ok: false, status: 403, base64: "", contentType: "text/html" } : { ok: true, status: 200, base64: JPEG, contentType: "image/jpeg" };
    const data = await downloadCover("https://cdn.example/c.jpg", "https://www.example.com/");
    expect(data.mime).toBe("image/jpeg");
    expect(http.getBinary).toHaveBeenCalledTimes(2);
  });

  it("HTML chybovou stránku jako obálku odmítne s konkrétním důvodem", async () => {
    response = async () => ({ ok: true, status: 200, base64: HTML, contentType: "text/html; charset=utf-8" });
    await expect(downloadCover("https://cdn.example/c.jpg")).rejects.toThrow(/nevrací obrázek \(text\/html\)/);
    response = async () => ({ ok: false, status: 404, base64: "", contentType: "" });
    await expect(downloadCover("https://cdn.example/c.jpg")).rejects.toThrow(/HTTP 404/);
  });

  it("ukládá binárně – bez Encoding.UTF8 – a se správnou příponou", async () => {
    const path = await saveCover({ base64: PNG, mime: "image/png" });
    expect(path).toMatch(/^NovelForge\/covers\/cover-[0-9a-f-]+\.png$/);
    expect(written).toHaveLength(1);
    expect(written[0].encoding).toBeUndefined();
    expect(written[0].data).toBe(PNG);
    expect(Array.from(base64ToBytes(written[0].data).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("načte uloženou obálku se skutečným typem a sestaví data URI pro zobrazení", async () => {
    const path = await saveCover({ base64: JPEG, mime: "image/jpeg" });
    const cover = await readCover(path);
    expect(cover).toEqual({ base64: JPEG, mime: "image/jpeg" });
    expect(coverDataUri(cover!.base64, cover!.mime)).toBe(`data:image/jpeg;base64,${JPEG}`);
    expect(await readCover(undefined)).toBeNull();
    expect(await readCover("NovelForge/covers/missing.jpg")).toBeNull();
  });

  it("opraví obálku, kterou starší verze uložila jako base64 TEXT", async () => {
    // v1.1.1 zapisovala base64 s Encoding.UTF8 => soubor obsahuje text base64;
    // binární čtení ho tedy vrátí zakódovaný podruhé
    const path = "NovelForge/covers/legacy.jpg";
    written.push({ path, data: bytesToBase64(new TextEncoder().encode(PNG)) });
    const cover = await readCover(path);
    expect(cover).toEqual({ base64: PNG, mime: "image/png" });
  });
});
