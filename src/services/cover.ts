import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { storage } from "./storage";

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

export async function generatePlaceholderCover(title: string, filename: string): Promise<string> {
  await storage.init();
  const path = storage.coverPath(filename);
  await Filesystem.writeFile({
    path,
    data: PLACEHOLDER_SVG(title),
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
  return path;
}

export async function pickCoverFromGallery(): Promise<{ path: string; base64: string } | null> {
  try {
    const photo = await Camera.getPhoto({
      quality: 90,
      allowEditing: true,
      resultType: CameraResultType.Base64,
      source: CameraSource.Photos,
      width: 1200,
    });
    if (!photo.base64String) return null;
    const filename = `cover-${crypto.randomUUID()}.jpg`;
    const path = storage.coverPath(filename);
    // POZOR: base64String z Camera API je binární JPEG zakódovaný do base64.
    // Bez `encoding` zapíše Filesystem plugin skutečná binární data; s
    // Encoding.UTF8 by se zapsal base64 TEXT a soubor by nebyl platný obrázek.
    await Filesystem.writeFile({
      path,
      data: photo.base64String,
      directory: Directory.Documents,
    });
    return { path, base64: photo.base64String };
  } catch (err) {
    // User cancelled or no permission
    return null;
  }
}

export async function saveCoverBase64(base64: string, filename: string): Promise<string> {
  await storage.init();
  const path = storage.coverPath(filename);
  // Binární zápis – viz komentář výše (base64 → skutečné bajty JPEG).
  await Filesystem.writeFile({
    path,
    data: base64,
    directory: Directory.Documents,
  });
  return path;
}

export function coverDataUri(base64: string, mime = "image/jpeg"): string {
  return `data:${mime};base64,${base64}`;
}

/**
 * Vrátí URL použitelnou přímo v <img src>.
 *
 * POZOR: dřívější kód skládal `capacitor://${coverPath}`. To je neplatná URL –
 * coverPath je RELATIVNÍ cesta v Documents (např. "NovelForge/covers/x.jpg"),
 * takže vzniklo `capacitor://NovelForge/covers/x.jpg`, kde "NovelForge" je
 * hostname. WKWebView soubor nenašel a obálka se nezobrazila (prázdný rám).
 *
 * Správně: přečíst soubor přes Filesystem a vrátit data: URI. Funguje to
 * shodně v prohlížeči i v nativním WebView a nezávisí na allowNavigation.
 */
export async function coverSrc(coverPath: string | undefined | null): Promise<string | null> {
  if (!coverPath) return null;
  try {
    const res = await Filesystem.readFile({
      path: coverPath,
      directory: Directory.Documents,
    });
    const data = typeof res.data === "string" ? res.data : await blobToBase64(res.data);
    if (!data) return null;
    const mime = coverPath.toLowerCase().endsWith(".svg")
      ? "image/svg+xml"
      : coverPath.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg";
    return `data:${mime};base64,${data}`;
  } catch {
    return null;
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
