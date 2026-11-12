import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { storage } from "./storage";
import { http, base64ToBytes } from "./http";

export interface CoverData {
  base64: string;
  mime: string;
}

const PLACEHOLDER_SVG = (title: string) => `
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">
  <rect width="600" height="800" fill="#141417"/>
  <rect x="30" y="30" width="540" height="740" rx="24" fill="none" stroke="url(#g)" stroke-width="6"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#9333ea"/></linearGradient></defs>
  <text x="300" y="380" font-family="Georgia, serif" font-size="40" fill="#ec4899" text-anchor="middle" font-weight="bold">${escapeXml(title)}</text>
  <text x="300" y="430" font-family="Georgia, serif" font-size="24" fill="#9333ea" text-anchor="middle">NovelForge</text>
</svg>
`.trim();

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime] ?? "jpg";
}

/**
 * Určí MIME typ obrázku z jeho SKUTEČNÉHO obsahu (magic bytes).
 * Přípona v URL ani hlavička Content-Type nejsou spolehlivé (CDN často
 * posílá WebP pod adresou končící .jpg).
 */
export function sniffImageMime(base64: string): string | null {
  let b: Uint8Array;
  try {
    b = base64ToBytes(base64.slice(0, 64));
  } catch {
    return null;
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  const head = String.fromCharCode(...b).trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

/**
 * Převede obrázek na JPEG přes <canvas> (jen ve WebView / prohlížeči).
 * WebP ani GIF nejsou v EPUB 3 základní typy obrázků – některé čtečky by
 * obálku nezobrazily. Když převod není možný, vrátí původní data.
 */
async function toJpeg(data: CoverData): Promise<CoverData> {
  if (typeof document === "undefined" || typeof Image === "undefined") return data;
  try {
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode"));
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
    img.src = `data:${data.mime};base64,${data.base64}`;
    await loaded;
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return data;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.9);
    const base64 = url.split(",")[1] ?? "";
    if (!base64 || sniffImageMime(base64) !== "image/jpeg") return data;
    return { base64, mime: "image/jpeg" };
  } catch {
    return data;
  }
}

/**
 * Stáhne obálku NATIVNÍ HTTP vrstvou (žádné CORS, vlastní Referer proti
 * hotlink ochraně) a ověří, že odpověď je opravdu obrázek.
 * Vyhodí chybu s konkrétním důvodem; volající ji může ukázat uživateli.
 */
export async function downloadCover(url: string, referer?: string, signal?: AbortSignal): Promise<CoverData> {
  const attempt = async (headers: Record<string, string>) => {
    const res = await http.getBinary(url, { headers, timeoutMs: 20000, signal });
    if (!res.ok) throw new Error(`Obálku se nepodařilo stáhnout (HTTP ${res.status})`);
    if (!res.base64) throw new Error("Server vrátil prázdnou obálku");
    const mime = sniffImageMime(res.base64);
    if (!mime) {
      const ct = res.contentType.split(";")[0].trim() || "neznámý typ";
      throw new Error(`Adresa obálky nevrací obrázek (${ct})`);
    }
    return { base64: res.base64, mime };
  };
  let data: CoverData;
  try {
    data = await attempt(referer ? { Referer: referer } : {});
  } catch (err: any) {
    if (err?.name === "AbortError" || !referer) throw err;
    data = await attempt({}); // některé CDN naopak cizí Referer odmítají
  }
  if (data.mime === "image/webp" || data.mime === "image/gif") data = await toJpeg(data);
  return data;
}

/** Uloží obálku BINÁRNĚ do Documents/NovelForge/covers a vrátí relativní cestu. */
export async function saveCover(data: CoverData): Promise<string> {
  await storage.init();
  const path = storage.coverPath(`cover-${crypto.randomUUID()}.${extForMime(data.mime)}`);
  await storage.writeBinary(path, data.base64);
  return path;
}

/** Načte uloženou obálku včetně skutečného MIME typu. */
export async function readCover(coverPath: string | undefined | null): Promise<CoverData | null> {
  if (!coverPath) return null;
  try {
    let base64 = await storage.readBinary(coverPath);
    if (!base64) return null;
    let mime = sniffImageMime(base64);
    if (!mime) {
      // Oprava obálek uložených starší verzí: soubor obsahuje base64 TEXT
      // místo obrázku. Dekódujeme o úroveň hlouběji.
      try {
        const inner = new TextDecoder().decode(base64ToBytes(base64)).trim();
        const innerMime = /^[A-Za-z0-9+/=\s]+$/.test(inner) ? sniffImageMime(inner) : null;
        if (innerMime) {
          base64 = inner.replace(/\s+/g, "");
          mime = innerMime;
        }
      } catch {
        /* není to base64 text */
      }
    }
    if (!mime) return null;
    return { base64, mime };
  } catch {
    return null;
  }
}

export async function generatePlaceholderCover(title: string, filename: string): Promise<string> {
  await storage.init();
  const path = storage.coverPath(filename);
  // SVG je text – zde je Encoding.UTF8 správně.
  await Filesystem.writeFile({
    path,
    data: PLACEHOLDER_SVG(title),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  return path;
}

/** Ruční výběr obálky z galerie. Vrací null, když uživatel výběr zruší. */
export async function pickCoverFromGallery(): Promise<{ path: string; base64: string; mime: string } | null> {
  let photo;
  try {
    photo = await Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: CameraResultType.Base64,
      source: CameraSource.Photos,
      width: 1600,
    });
  } catch {
    return null; // zrušeno nebo bez oprávnění
  }
  if (!photo.base64String) return null;
  const base64 = photo.base64String.replace(/\s+/g, "");
  const mime = sniffImageMime(base64) ?? "image/jpeg";
  const path = await saveCover({ base64, mime });
  return { path, base64, mime };
}

export function coverDataUri(base64: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Vrátí data: URI použitelné přímo v <img src>. Funguje shodně v prohlížeči i
 * v nativním WebView a nezávisí na schématu capacitor://.
 */
export async function coverSrc(coverPath: string | undefined | null): Promise<string | null> {
  const data = await readCover(coverPath);
  return data ? coverDataUri(data.base64, data.mime) : null;
}
