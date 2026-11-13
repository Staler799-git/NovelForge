export type ChapterStatus = "pending" | "downloaded" | "failed" | "skipped";
export type ProjectStatus =
  | "idle"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  /** Zdroj vyžaduje přihlášení nebo odemčení překladu. */
  | "waiting-auth"
  /** Zdroj vyžaduje bezpečnostní ověření (Cloudflare, CAPTCHA). */
  | "verification-required"
  /** Zdroj opakovaně omezuje počet požadavků. */
  | "rate-limited";
/** Překladová varianta zdroje (WTR-LAB: web, webplus, ai). */
export type TranslationMode = string;
export type SpeedMode = "eco" | "balanced" | "fast";
export type ExportFormat = "epub" | "txt" | "html";

export interface NovelMetadata {
  title: string;
  author: string;
  description?: string;
  language?: string;
  coverUrl?: string;
  sourceUrl: string;
  sourceDomain?: string;
  /** Počet kapitol, který uvádí sám web (pokud ho stránka obsahuje). */
  declaredChapters?: number;
}

export interface Chapter {
  id: string;
  projectId: string;
  title: string;
  url: string;
  orderIndex: number;
  status: ChapterStatus;
  filePath?: string;
  fileSize?: number;
  /** Otisk NORMALIZOVANÉHO textu kapitoly – slouží k rozpoznání duplicitního obsahu. */
  checksum?: string;
  wordCount?: number;
  errorMessage?: string;
  retryCount?: number;
  downloadedAt?: string;
  /** Překladová varianta, ve které je uložený text (jen u zdrojů s více překlady). */
  translationMode?: TranslationMode;
  /** Druh poslední chyby (viz services/access.ts). */
  errorKind?: string;
  /**
   * true = alternativní verze kapitoly, kterou uživatel nevybral. Adresa i
   * případný stažený soubor zůstávají, ale kapitola se nestahuje, nepočítá a
   * neexportuje.
   */
  excluded?: boolean;
}

export interface Project {
  id: string;
  title: string;
  author: string;
  language: string;
  description?: string;
  sourceUrl: string;
  sourceDomain?: string;
  coverPath?: string;
  totalChapters: number;
  downloadedChapters: number;
  failedChapters: number;
  lastDownloadedChapter?: string;
  status: ProjectStatus;
  progress: number; // 0-100
  createdAt: string;
  updatedAt: string;
  lastCheckAt?: string;
  epubPath?: string;
  /** Poslední přístupová překážka (druh + zpráva); prázdné = žádná. */
  accessKind?: string;
  accessMessage?: string;
  settings?: ProjectSettings;
}

export interface ProjectSettings {
  concurrentRequests: number;
  delayMs: number;
  maxRetries: number;
  /** Překlad, který projekt používá. Bez potvrzení uživatele se nemění. */
  translationMode?: TranslationMode;
  speedMode?: SpeedMode;
  /** Stahovat jen přes Wi-Fi. */
  wifiOnly?: boolean;
  /** Stahovat jen při nabíjení. */
  chargingOnly?: boolean;
}

export interface DownloadResult {
  chapterId: string;
  success: boolean;
  filePath?: string;
  error?: string;
  bytes?: number;
}

export interface ParserChapter {
  title: string;
  url: string;
  orderIndex: number;
  /** Pořadové číslo, které u položky zobrazuje katalog (např. "001" nebo "1"). */
  label?: string;
  /** Stránka katalogu, na které byla položka nalezena. */
  page?: number;
}

export interface CatalogProgress {
  pagesLoaded: number;
  /** Známý počet stránek (z odkazů stránkování), pokud jde zjistit. */
  pagesTotal?: number;
  chaptersFound: number;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Překlad, který se má stáhnout (jen u zdrojů s více překlady). */
  translationMode?: TranslationMode;
  onProgress?: (p: CatalogProgress) => void;
}

/** Výsledek načtení celého katalogu kapitol. */
export interface CatalogResult {
  chapters: ParserChapter[];
  pagesLoaded: number;
  declaredTotal?: number;
  /** false = katalog prokazatelně není celý (selhala stránka, přerušeno, nesedí počet). */
  complete: boolean;
  /** true = detekci zastavil uživatel. */
  aborted: boolean;
  warnings: string[];
}
