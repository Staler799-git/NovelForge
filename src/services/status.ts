/**
 * Jediný zdroj pravdy pro zobrazovaný stav projektu.
 *
 * Stav v databázi ("downloading") říká jen to, co platilo při posledním
 * zápisu. Skutečně běžící stahování zná pouze správce stahování. Každá
 * obrazovka proto musí stav odvozovat stejně – z obojího najednou.
 */
import type { Project } from "@/types";

export type StatusKey = "running" | "completed" | "failed" | "paused" | "interrupted" | "idle" | "waiting-auth" | "verification-required" | "rate-limited";

export interface ProjectStatusView {
  key: StatusKey;
  label: string;
  variant: "ok" | "warn" | "bad" | "muted";
}

export function projectStatus(
  p: Pick<Project, "status" | "totalChapters" | "downloadedChapters">,
  running: boolean,
): ProjectStatusView {
  if (running) return { key: "running", label: "Stahuje se", variant: "warn" };
  // "Dokončeno" jen když jsou opravdu stažené všechny vybrané kapitoly.
  const all = p.totalChapters > 0 && p.downloadedChapters >= p.totalChapters;
  switch (p.status) {
    case "completed":
      return all ? { key: "completed", label: "Dokončeno", variant: "ok" } : { key: "paused", label: "Pozastaveno", variant: "muted" };
    case "failed":
      return { key: "failed", label: "Dokončeno s chybami", variant: "bad" };
    case "paused":
      return { key: "paused", label: "Pozastaveno", variant: "muted" };
    case "waiting-auth":
      return { key: "waiting-auth", label: "Čeká na přihlášení", variant: "warn" };
    case "verification-required":
      return { key: "verification-required", label: "Vyžadováno ověření", variant: "warn" };
    case "rate-limited":
      return { key: "rate-limited", label: "Omezeno webem", variant: "warn" };
    case "downloading":
      // v databázi zůstalo "downloading", ale nic neběží (aplikace byla ukončena)
      return { key: "interrupted", label: "Pozastaveno", variant: "muted" };
    default:
      return p.downloadedChapters > 0 ? { key: "paused", label: "Pozastaveno", variant: "muted" } : { key: "idle", label: "Připraveno", variant: "muted" };
  }
}
