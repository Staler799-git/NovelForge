import { db } from "./services/db";
import type { Project } from "./types";

type Listener = () => void;

export function useProjectStore() {
  let projects: Project[] = [];
  const listeners = new Set<Listener>();

  const set = (ps: Project[]) => {
    projects = ps;
    listeners.forEach((l) => l());
  };

  const refresh = async () => {
    try {
      set(await db.getProjects());
    } catch {
      /* ignore */
    }
  };

  return {
    get projects() {
      return projects;
    },
    set,
    refresh,
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const projectStore = useProjectStore();
