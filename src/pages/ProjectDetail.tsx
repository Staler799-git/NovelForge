import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { projectStore } from "@/store";
import type { Project, Chapter } from "@/types";
import { Card, SectionTitle, Button, Badge, ProgressBar } from "@/components/ui";
import { List, Pause, Play, RefreshCw, Share2, AlertCircle, Clock } from "lucide-react";

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, ch] = await Promise.all([db.getProject(id), db.getChapters(id)]);
      setProject(p ?? null);
      setChapters(ch);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let mounted = true;
    load();
    const unsub = projectStore.subscribe(load);
    const sub = downloadManager.on((e) => {
      if (!mounted) return;
      if (
        (e.type === "chapter-end" || e.type === "progress" || e.type === "project-end") &&
        e.projectId === id
      ) {
        load();
      }
    });
    return () => {
      mounted = false;
      unsub();
      sub();
    };
  }, [id, load]);

  if (loading) return <div className="p-4 text-white/40">Načítá se…</div>;
  if (!project) return <div className="p-4 text-red-400">Projekt nenalezen.</div>;

  const stats = {
    total: chapters.length,
    downloaded: chapters.filter((c) => c.status === "downloaded").length,
    failed: chapters.filter((c) => c.status === "failed").length,
    pending: chapters.filter((c) => c.status === "pending").length,
  };

  const isDownloading = downloadManager.isDownloading(project.id);
  const current = downloadManager.getCurrentChapter(project.id);

  return (
    <div className="p-4 space-y-5 max-w-[700px] mx-auto">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => navigate(-1)}>
          <List size={18} className="mr-2" /> Zpět
        </Button>
      </div>

      <Card>
        <div className="p-5">
          <div className="flex gap-4">
            {project.coverPath ? (
              <img src={`capacitor://${project.coverPath}`} alt="" className="w-32 h-44 rounded-2xl object-cover bg-white/5" />
            ) : (
              <div className="w-32 h-44 rounded-2xl bg-white/5 flex items-center justify-center text-white/20">
                <List size={28} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-white">{project.title}</h1>
              <p className="text-white/60 text-lg">{project.author}</p>
              <p className="mt-2 text-white/50">{project.description ?? "Bez popisu."}</p>
              <div className="mt-3 flex gap-2 text-xs text-white/40">
                <span>{new URL(project.sourceUrl).hostname.replace("www.", "")}</span>
                <span>•</span>
                <span>{stats.downloaded} / {stats.total} kapitol</span>
              </div>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="text-white/40 text-xs">Staženo</div>
              <div className="text-2xl font-bold text-white">{stats.downloaded}</div>
            </div>
            <div className="p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="text-white/40 text-xs">Selháno</div>
              <div className="text-2xl font-bold text-red-400">{stats.failed}</div>
            </div>
          </div>

          <ProgressBar value={project.progress} className="mt-6" />
          <div className="mt-2 flex justify-between text-xs text-white/50">
            <span>{project.progress} %</span>
            <span>{current ? `Aktuálně: ${current.title}` : "—"}</span>
          </div>
        </div>
      </Card>

      <div className="flex gap-3">
        {isDownloading ? (
          <>
            <Button onClick={() => downloadManager.pauseProject(project.id)}>
              <Pause size={18} className="mr-2" /> Pozastavit
            </Button>
            <Button variant="danger" onClick={() => downloadManager.cancelProject(project.id)}>
              <AlertCircle size={18} className="mr-2" /> Zrušit
            </Button>
          </>
        ) : project.status === "paused" || project.status === "idle" ? (
          <Button onClick={() => downloadManager.startProject(project)}>
            <Play size={18} className="mr-2" />
            {project.status === "paused" ? "Pokračovat" : "Spustit stahování"}
          </Button>
        ) : (
          <Button variant="ghost" disabled>
            <Clock size={18} className="mr-2" /> Probíhá
          </Button>
        )}
        {stats.failed > 0 && (
          <Button variant="ghost" onClick={() => downloadManager.retryFailed(project)}>
            <RefreshCw size={18} className="mr-2" /> Opakovat selhané
          </Button>
        )}
        {project.status === "completed" && (
          <Button onClick={() => navigate(`/project/${project.id}/export`)}>
            <Share2 size={18} className="mr-2" /> Vytvořit EPUB
          </Button>
        )}
      </div>

      <SectionTitle>Kapitoly</SectionTitle>
      <div className="max-h-[560px] overflow-y-auto border border-white/5 rounded-xl bg-white/3">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-white/40 border-b border-white/5">
              <th className="p-3">#</th>
              <th className="p-3">Název</th>
              <th className="p-3">Stav</th>
            </tr>
          </thead>
          <tbody>
            {chapters.map((c) => (
              <tr key={c.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="p-3 text-white/50">{c.orderIndex + 1}</td>
                <td className="p-3 text-white truncate" title={c.title}>
                  {c.title}
                </td>
                <td className="p-3">
                  <Badge variant={c.status === "downloaded" ? "ok" : c.status === "failed" ? "bad" : "muted"}>
                    {c.status === "downloaded" ? "Hotovo" : c.status === "failed" ? "Chyba" : "Čeká"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
