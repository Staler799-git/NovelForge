import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

const APP_DIR = "NovelForge";
const PROJECTS_DIR = "projects";
const COVERS_DIR = "covers";
const EPUBS_DIR = "exports";
const CACHE_DIR = "cache";

async function ensureDir(path: string): Promise<void> {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Documents, recursive: true });
  } catch {
    /* directory likely exists */
  }
}

export const storage = {
  async init(): Promise<void> {
    await ensureDir(APP_DIR);
    await ensureDir(`${APP_DIR}/${PROJECTS_DIR}`);
    await ensureDir(`${APP_DIR}/${COVERS_DIR}`);
    await ensureDir(`${APP_DIR}/${EPUBS_DIR}`);
    await ensureDir(`${APP_DIR}/${CACHE_DIR}`);
  },

  projectDir(projectId: string): string {
    return `${APP_DIR}/${PROJECTS_DIR}/${projectId}`;
  },

  async chapterPath(projectId: string, chapterId: string): Promise<string> {
    await ensureDir(this.projectDir(projectId));
    return `${this.projectDir(projectId)}/${chapterId}.html`;
  },

  async writeFile(path: string, data: string): Promise<void> {
    await Filesystem.writeFile({ path, data, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
  },

  /**
   * Zapíše BINÁRNÍ soubor z base64. Bez `encoding` plugin base64 dekóduje a
   * uloží skutečné bajty. (S Encoding.UTF8 by se uložil base64 TEXT – takový
   * "EPUB" nebo "obrázek" žádná aplikace neotevře.)
   */
  async writeBinary(path: string, base64: string): Promise<void> {
    await Filesystem.writeFile({ path, data: base64, directory: Directory.Documents, recursive: true });
  },

  /** Přečte soubor jako base64 (binárně). */
  async readBinary(path: string): Promise<string> {
    const res = await Filesystem.readFile({ path, directory: Directory.Documents });
    if (typeof res.data === "string") return res.data.replace(/\s+/g, "");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const r = String(reader.result ?? "");
        resolve(r.includes(",") ? r.split(",")[1] : r);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(res.data as Blob);
    });
  },

  async readFile(path: string): Promise<string> {
    const res = await Filesystem.readFile({ path, directory: Directory.Documents, encoding: Encoding.UTF8 });
    return typeof res.data === "string" ? res.data : "";
  },

  async deleteFile(path: string): Promise<void> {
    try {
      await Filesystem.deleteFile({ path, directory: Directory.Documents });
    } catch {
      /* ignore missing */
    }
  },

  async fileExists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path, directory: Directory.Documents });
      return true;
    } catch {
      return false;
    }
  },

  async fileSize(path: string): Promise<number | null> {
    try {
      const res = await Filesystem.stat({ path, directory: Directory.Documents });
      return res.size ?? null;
    } catch {
      return null;
    }
  },

  async listChapterFiles(projectId: string): Promise<string[]> {
    try {
      const res = await Filesystem.readdir({ path: this.projectDir(projectId), directory: Directory.Documents });
      return (res.files ?? []).map((f) => f.name).filter((f) => f.endsWith(".html"));
    } catch {
      return [];
    }
  },

  backupDir(name: string): string {
    return `${APP_DIR}/backups/${name}`;
  },

  /** Zkopíruje soubor (cílové složky se vytvoří). Existující cíl se nepřepisuje. */
  async copyFile(from: string, to: string): Promise<void> {
    const dir = to.split("/").slice(0, -1).join("/");
    if (dir) await ensureDir(dir);
    if (await this.fileExists(to)) return;
    await Filesystem.copy({ from, to, directory: Directory.Documents, toDirectory: Directory.Documents });
  },

  async listDir(path: string): Promise<string[]> {
    try {
      const res = await Filesystem.readdir({ path, directory: Directory.Documents });
      return (res.files ?? []).map((f) => f.name);
    } catch {
      return [];
    }
  },

  coverPath(filename: string): string {
    return `${APP_DIR}/${COVERS_DIR}/${filename}`;
  },

  epubPath(filename: string): string {
    return `${APP_DIR}/${EPUBS_DIR}/${filename}`;
  },

  cachePath(filename: string): string {
    return `${APP_DIR}/${CACHE_DIR}/${filename}`;
  },

  async shareFile(path: string, title?: string): Promise<void> {
    const uri = await Filesystem.getUri({ path, directory: Directory.Documents });
    await Haptics.impact({ style: ImpactStyle.Medium });
    await Share.share({ title, url: uri.uri, dialogTitle: title ?? "NovelForge" });
  },
};
