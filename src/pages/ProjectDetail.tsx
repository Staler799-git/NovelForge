import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { pickCoverFromGallery } from "@/services/cover";
import { projectStore } from "@/store";
import type { Project, Chapter } from "@/types";
import { Card, SectionTitle, Button, Badge, ProgressBar, Cover } from "@/components/ui";
import { List, Pause, Play, RefreshCw, Share2, AlertTriangle, Image as ImageIcon } from "lucide-react";

const PAGE_SIZE = 200;

export function projectStatusLabel(p: Pick<Project, "status" | "failedChapters">, running: boolean): string {
  if (running) return "Stahuje se";
  switch (p.status) {
    case "completed": return "Dokončeno";
    case "failed": return "Dokončeno s chybami";
    case "paused": return "Pozastaveno";
    case "downloading": return "Přerušeno";
    default: return "Připraveno";
  }
}

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [log, setLog] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | undefined>(id ? downloadManager.getLastError(id) : undefined);
  const [, setTick] = useState(0);
  const lastChapterLoad = useRef(0);
  const pendingReload = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadProject = useCallback(async () => {
    if (!id) return;
    setProject((await db.getProject(id)) ?? null);
  }, [id]);

  const loadChapters = useCallback(async () => {
    if (!id) return;
    lastChapterLoad.current = Date.now();
    setChapters(await db.getChapters(id));
  }, [id]);

  const loadAll = useCallback(async () => {
    try {
      await Promise.all([loadProject(), loadChapters()]);
    } catch (err: any) {
      setRunError(`Projekt se nepodařilo načíst: ${err?.message ?? "neznámá chyba"}`);
    } finally {
      setLoading(false);
    }
  }, [loadProject, loadChapters]);

  useEffect(() => {
    let mounted = true;
    loadAll();
    const unsub = projectStore.subscribe(loadAll);
    const sub = downloadManager.on((e) => {
      if (!mounted || e.projectId !== id) return;
      if (e.type === "log") setLog((prev) => [e.message, ...prev].slice(0, 8));
      if (e.type === "project-start") setRunError(undefined);
      if (e.type === "progress") {
        // Počty jdou přímo z události – bez čtení databáze při každé kapitole.
        setProject((p) => (p ? { ...p, progress: e.progress, downloadedChapters: e.downloaded, failedChapters: e.failed, totalChapters: e.total } : p));
        // Seznam tisíců kapitol se z databáze obnovuje nejvýš jednou za 4 s.
        if (!pendingReload.current) {
          const wait = Math.max(0, 4000 - (Date.now() - lastChapterLoad.current));
          pendingReload.current = setTimeout(() => {
            pendingReload.current = null;
            if (mounted) void loadChapters();
          }, wait);
        }
      }
      if (e.type === "chapter-start") setTick((t) => t + 1);
      if (e.type === "project-end") {
        setRunError(e.error);
        void loadAll();
      }
    });
    return () => {
      mounted = false;
      unsub();
      sub();
      if (pendingReload.current) clearTimeout(pendingReload.current);
      pendingReload.current = null;
    };
  }, [id, loadAll, loadChapters]);

  if (loading) return <div className="p-4 text-white/40">Načítá se…</div>;
  if (!project) return <div className="p-4 text-red-400">Projekt nenalezen.{runError ? ` ${runError}` : ""}</div>;

  const isDownloading = downloadManager.isDownloading(project.id);
  const current = downloadManager.getCurrentChapter(project.id);
  const total = chapters.length || project.totalChapters;
  const downloaded = isDownloading ? project.downloadedChapters : chapters.filter((c) => c.status === "downloaded").length;
  const failedList = chapters.filter((c) => c.status === "failed");
  const failed = isDownloading ? project.failedChapters : failedList.length;
  const pending = Math.max(0, total - downloaded - failed);
  const pct = total === 0 ? 0 : Math.floor((downloaded / total) * 100);

  const start = () => {
    setRunError(undefined);
    void downloadManager.startProject(project);
    setTick((t) => t + 1);
  };
  const retry = () => {
    setRunError(undefined);
    void downloadManager.retryFailed(project);
    setTimeout(() => setTick((t) => t + 1), 300);
  };
  const changeCover = async () => {
    const picked = await pickCoverFromGallery();
    if (!picked) return;
    await db.updateProject(project.id, { coverPath: picked.path });
    await loadProject();
  };

  let host = project.sourceUrl;
  try {
    host = new URL(project.sourceUrl).hostname.replace("www.", "");
  } catch {
    /* ponecháme celou adresu */
  }

  return (
    <div className="p-4 space-y-5 max-w-[700px] mx-auto">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <List size={18} /> Zpět
        </Button>
        <Badge variant={project.status === "completed" && !isDownloading ? "ok" : isDownloading ? "warn" : "muted"}>
          {projectStatusLabel(project, isDownloading)}
        </Badge>
      </div>

      <Card>
        <div className="flex gap-4">
          <div className="flex-shrink-0 space-y-2">
            {project.coverPath ? (
              <Cover coverPath={project.coverPath} className="w-28 h-40 rounded-2xl" />
            ) : (
              <div className="w-28 h-40 rounded-2xl bg-white/5 flex items-center justify-center text-white/20">
                <List size={28} />
              </div>
            )}
            <button type="button" onClick={changeCover} className="w-28 text-[11px] text-pink-400 flex items-center justify-center gap-1 py-1">
              <ImageIcon size={12} /> Změnit obálku
            </button>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-[20px] font-bold tracking-tight text-white leading-snug line-clamp-3">{project.title}</h1>
            <p className="text-white/60">{project.author}</p>
            <p className="mt-2 text-white/50 text-sm line-clamp-4">{project.description ?? "Bez popisu."}</p>
            <div className="mt-2 text-xs text-white/40">{host} · jazyk {project.language}</div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          <div className="p-3 rounded-xl bg-white/5 border border-white/5">
            <div className="text-white/40 text-xs">Staženo</div>
            <div className="text-xl font-bold text-white" data-testid="count-downloaded">{downloaded}</div>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/5">
            <div className="text-white/40 text-xs">Čeká</div>
            <div className="text-xl font-bold text-white">{pending}</div>
          </div>
          <div className="p-3 rounded-xl bg-white/5 border border-white/5">
            <div className="text-white/40 text-xs">Selhalo</div>
            <div className="text-xl font-bold text-red-400">{failed}</div>
          </div>
        </div>

        <ProgressBar value={pct} className="mt-5" />
        <div className="mt-2 flex justify-between gap-3 text-xs text-white/50">
          <span className="flex-shrink-0">{downloaded} / {total} kapitol ({pct} %)</span>
          <span className="truncate">{current ? `Aktuálně: ${current.title}` : ""}</span>
        </div>
      </Card>

      {runError && !isDownloading && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex gap-2" role="alert">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" /> <span>{runError}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {isDownloading ? (
          <Button onClick={() => downloadManager.pauseProject(project.id)}>
            <Pause size={18} /> Pozastavit
          </Button>
        ) : (
          pending > 0 && (
            <Button onClick={start}>
              <Play size={18} /> {downloaded > 0 ? "Pokračovat" : "Spustit stahování"}
            </Button>
          )
        )}
        {!isDownloading && failed > 0 && (
          <Button variant="ghost" onClick={retry}>
            <RefreshCw size={18} /> Opakovat selhané ({failed})
          </Button>
        )}
        {downloaded > 0 && (
          <Button variant={isDownloading || pending > 0 || failed > 0 ? "ghost" : "primary"} onClick={() => navigate(`/project/${project.id}/export`)}>
            <Share2 size={18} /> Vytvořit EPUB
          </Button>
        )}
      </div>

      {log.length > 0 && (
        <Card>
          <div className="text-xs text-white/50 space-y-1">
            {log.map((m, i) => (
              <div key={i} className="truncate">• {m}</div>
            ))}
          </div>
        </Card>
      )}

      {failedList.length > 0 && (
        <>
          <SectionTitle>Selhané kapitoly</SectionTitle>
          <div className="border border-red-500/20 rounded-xl bg-red-500/5 divide-y divide-white/5 max-h-[320px] overflow-y-auto">
            {failedList.slice(0, 100).map((c) => (
              <div key={c.id} className="p-3">
                <div className="text-white text-sm truncate">{c.orderIndex + 1}. {c.title}</div>
                <div className="text-red-400 text-xs">{c.errorMessage ?? "Neznámá chyba"}</div>
              </div>
            ))}
            {failedList.length > 100 && <div className="p-3 text-xs text-white/50">… a dalších {failedList.length - 100}</div>}
          </div>
        </>
      )}

      <SectionTitle>Kapitoly</SectionTitle>
      <div className="border border-white/5 rounded-xl bg-white/[0.03] divide-y divide-white/5">
        {chapters.slice(0, visible).map((c) => (
          <div key={c.id} className="p-3 flex items-center gap-3">
            <span className="w-10 text-right text-white/40 text-xs flex-shrink-0">{c.orderIndex + 1}.</span>
            <span className="flex-1 min-w-0 text-white text-sm truncate">{c.title}</span>
            <Badge variant={c.status === "downloaded" ? "ok" : c.status === "failed" ? "bad" : "muted"}>
              {c.status === "downloaded" ? "Hotovo" : c.status === "failed" ? "Chyba" : "Čeká"}
            </Badge>
          </div>
        ))}
        {visible < chapters.length && (
          <div className="p-2">
            <Button variant="ghost" className="w-full" onClick={() => setVisible((v) => v + 500)}>
              Zobrazit dalších {Math.min(500, chapters.length - visible)} (z {chapters.length})
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
