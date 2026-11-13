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

// ---------------------------------------------------------------------------
// AVIF / HEIC
// ---------------------------------------------------------------------------
import { normalizeCover, pickCoverFromGallery } from "@/services/cover";
import { Camera } from "@capacitor/camera";
import { afterEach } from "vitest";

/** Hlavička ISO BMFF: box `ftyp` s hlavní značkou a kompatibilními značkami + výplň. */
function isoBmff(major: string, compatible: string[], pad = 64): string {
  const size = 16 + compatible.length * 4;
  const bytes = [0, 0, 0, size, ...[..."ftyp"].map((c) => c.charCodeAt(0)), ...[...major].map((c) => c.charCodeAt(0)), 0, 0, 0, 0];
  for (const b of compatible) bytes.push(...[...b].map((c) => c.charCodeAt(0)));
  return bytesToBase64(new Uint8Array([...bytes, ...new Array(pad).fill(7)]));
}
const AVIF = isoBmff("avif", ["avif", "mif1", "miaf", "MA1B"]);
const AVIF_MIF1 = isoBmff("mif1", ["mif1", "avif", "miaf"]); // obecná hlavní značka, AVIF až v kompatibilních
const AVIF_SEQ = isoBmff("avis", ["avis", "msf1", "iso8"]);
const HEIC = isoBmff("heic", ["mif1", "heic"]);
const MP4 = isoBmff("isom", ["isom", "iso2", "avc1", "mp41"]);
const CONVERTED = bytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9, 9, 9, 9, 9]));

/** Napodobí dekodér WKWebView: <img> + <canvas>. `decodes` určuje, které MIME typy „umí“. */
function fakeDecoder(decodes: (mime: string) => boolean, size = { w: 2400, h: 3200 }) {
  const drawn: Array<{ w: number; h: number }> = [];
  const sources: string[] = [];
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(v: string) {
      sources.push(v.slice(0, 40));
      const mime = v.slice(5, v.indexOf(";"));
      queueMicrotask(() => {
        if (decodes(mime)) {
          this.naturalWidth = size.w;
          this.naturalHeight = size.h;
          this.onload?.();
        } else this.onerror?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") return realCreate(tag);
    const canvas: any = { width: 0, height: 0 };
    canvas.getContext = () => ({ fillStyle: "", fillRect: () => {}, drawImage: () => drawn.push({ w: canvas.width, h: canvas.height }) });
    canvas.toDataURL = (type: string) => `data:${type};base64,${CONVERTED}`;
    return canvas;
  }) as any);
  return { drawn, sources };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AVIF a HEIC", () => {
  it("rozpozná AVIF podle struktury souboru (box ftyp a značky), ne podle přípony", () => {
    expect(sniffImageMime(AVIF)).toBe("image/avif");
    expect(sniffImageMime(AVIF_MIF1)).toBe("image/avif");
    expect(sniffImageMime(AVIF_SEQ)).toBe("image/avif");
    expect(sniffImageMime(HEIC)).toBe("image/heic");
    expect(sniffImageMime(MP4)).toBeNull(); // video není obálka
    expect(sniffImageMime(bytesToBase64(new TextEncoder().encode("xxxxftypavif")))).toBeNull(); // nesmyslná délka boxu
    expect(extForMime("image/avif")).toBe("avif");
  });

  it("AVIF z CDN s příponou .jpg a obecným Content-Type převede na JPEG", async () => {
    const dec = fakeDecoder(() => true);
    response = async () => ({ ok: true, status: 200, base64: AVIF, contentType: "application/octet-stream", url: "" });
    const cover = await downloadCover("https://img.example-cdn.test/covers/7898.jpg?w=400", "https://wtr-lab.com/en/novel/7898/x");
    expect(cover).toEqual({ base64: CONVERTED, mime: "image/jpeg" });
    expect(dec.sources[0]).toMatch(/^data:image\/avif;base64,/);
    expect(dec.drawn).toEqual([{ w: 1200, h: 1600 }]); // zmenšeno na max. 1600 px

    const path = await saveCover(cover);
    expect(path).toMatch(/^NovelForge\/covers\/cover-.*\.jpg$/);
    expect(written.at(-1)!.encoding).toBeUndefined(); // binární zápis
    expect(await readCover(path)).toEqual({ base64: CONVERTED, mime: "image/jpeg" });
  });

  it("server hlásí image/avif => už to není chyba „nevrací obrázek“", async () => {
    fakeDecoder(() => true);
    response = async () => ({ ok: true, status: 200, base64: AVIF_MIF1, contentType: "image/avif", url: "" });
    await expect(downloadCover("https://img.example-cdn.test/c")).resolves.toMatchObject({ mime: "image/jpeg" });
  });

  it("když zařízení AVIF nedekóduje, ohlásí konkrétní chybu (a nic neuloží jako AVIF)", async () => {
    fakeDecoder((mime) => mime !== "image/avif");
    response = async () => ({ ok: true, status: 200, base64: AVIF, contentType: "image/avif", url: "" });
    await expect(downloadCover("https://img.example-cdn.test/c.avif")).rejects.toThrow(/Obálku ve formátu AVIF se nepodařilo převést na JPEG \(systém obrázek nedekódoval\)/);
    expect(written).toEqual([]);
  });

  it("JPEG a PNG zůstávají beze změny, WebP se převede; nepřevoditelný WebP se ponechá", async () => {
    const dec = fakeDecoder(() => true);
    expect(await normalizeCover({ base64: JPEG, mime: "image/jpeg" })).toEqual({ base64: JPEG, mime: "image/jpeg" });
    expect(await normalizeCover({ base64: PNG, mime: "image/png" })).toEqual({ base64: PNG, mime: "image/png" });
    expect(dec.sources).toEqual([]); // nic se zbytečně nepřekódovává
    expect(await normalizeCover({ base64: WEBP, mime: "image/webp" })).toEqual({ base64: CONVERTED, mime: "image/jpeg" });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fakeDecoder(() => false);
    expect(await normalizeCover({ base64: WEBP, mime: "image/webp" })).toEqual({ base64: WEBP, mime: "image/webp" });
  });

  it("typ se určuje z obsahu i u CDN bez přípony a se špatným Content-Type", async () => {
    fakeDecoder(() => true);
    for (const [data, expected] of [[JPEG, "image/jpeg"], [PNG, "image/png"], [WEBP, "image/jpeg"], [AVIF, "image/jpeg"]] as const) {
      response = async () => ({ ok: true, status: 200, base64: data, contentType: "text/plain", url: "" });
      expect((await downloadCover("https://img.example-cdn.test/_next/image?url=%2Fcover&w=256")).mime).toBe(expected);
    }
  });

  it("obrázek z galerie ve formátu HEIC/AVIF se také převede", async () => {
    fakeDecoder(() => true);
    (Camera as any).getPhoto = vi.fn(async () => ({ base64String: HEIC }));
    const picked = await pickCoverFromGallery();
    expect(picked).toMatchObject({ mime: "image/jpeg", base64: CONVERTED });
    expect(picked!.path).toMatch(/\.jpg$/);
  });

  it("požadavek dává přednost JPEG/PNG před AVIF", async () => {
    const real = await vi.importActual<typeof import("@/services/http")>("@/services/http");
    const fetchSpy = vi.fn(async (..._a: any[]) => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await real.http.getBinary("https://img.example-cdn.test/c");
    const accept = (fetchSpy.mock.calls[0][1] as any).headers.Accept as string;
    expect(accept.indexOf("image/jpeg")).toBeLessThan(accept.indexOf("image/avif"));
    expect(accept).toContain("image/avif");
  });
});
