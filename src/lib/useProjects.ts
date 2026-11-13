import { useEffect, useState } from "react";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { projectStore } from "@/store";
import type { Project } from "@/types";

/**
 * Seznam projektů udržovaný v souladu se skutečným stahováním.
 * Používají ho všechny přehledové obrazovky, aby ukazovaly stejný stav.
 */
export function useProjects(): { projects: Project[]; loading: boolean; reload: () => Promise<void> } {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const ps = await db.getProjects();
        if (mounted) setProjects(ps);
      } catch {
        /* databáze není dostupná (webový náhled) */
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    const unsubStore = projectStore.subscribe(() => void load());
    const unsubDl = downloadManager.on((e) => {
      if (!mounted) return;
      if (e.type === "progress") {
        setProjects((ps) =>
          ps.map((p) =>
            p.id === e.projectId ? { ...p, progress: e.progress, downloadedChapters: e.downloaded, failedChapters: e.failed, totalChapters: e.total } : p,
          ),
        );
      } else if (e.type === "project-start" || e.type === "project-end") {
        setTick((t) => t + 1);
        void load();
      }
    });
    return () => {
      mounted = false;
      unsubStore();
      unsubDl();
    };
  }, []);

  return {
    projects,
    loading,
    reload: async () => {
      try {
        setProjects(await db.getProjects());
      } catch {
        /* ignore */
      }
    },
  };
}
