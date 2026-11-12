export type ChapterStatus = "pending" | "downloaded" | "failed" | "skipped";
export type ProjectStatus = "idle" | "downloading" | "paused" | "completed" | "failed";
export type ExportFormat = "epub" | "txt" | "html";

export interface NovelMetadata {
  title: string;
  author: string;
  description?: string;
  language?: string;
  coverUrl?: string;
  sourceUrl: string;
  sourceDomain?: string;
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
  checksum?: string;
  wordCount?: number;
  errorMessage?: string;
  retryCount?: number;
  downloadedAt?: string;
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
  settings?: ProjectSettings;
}

export interface ProjectSettings {
  concurrentRequests: number;
  delayMs: number;
  maxRetries: number;
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
}

export interface FetchOptions {
  signal?: AbortSignal;
}
