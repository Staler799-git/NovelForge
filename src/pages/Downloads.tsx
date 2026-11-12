import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { projectStore } from "@/store";
import type { Project } from "@/types";
import { Card, SectionTitle, Button, Badge, ProgressBar, Cover } from "@/components/ui";
import { formatDateShort } from "@/lib/utils";
import { Download, Pause, Play, RefreshCw, Trash2, Share2, FileText, Clock } from "lucide-react";

export function Downloads() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      setProjects(await db.getProjects());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    load();
    const unsub = projectStore.subscribe(load);
    const sub = downloadManager.on((e) => {
      if (!mounted) return;
      if (e.type === "log") setLogs((prev) => [e.message, ...prev.slice(0, 29)]);
      if (e.type === "project-end" || e.type === "progress") load();
    });
    return () => {
      mounted = false;
      unsub();
      sub();
    };
  }, [load]);

  const pause = (p: Project) => downloadManager.pauseProject(p.id);
  const resume = (p: Project) => downloadManager.startProject(p);
  const retry = (p: Project) => downloadManager.retryFailed(p);

  return (
    <div className="p-4 space-y-5 max-w-[700px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[28px] font-bold tracking-tight text-white leading-tight">Stahování</h1>
          <p className="text-white/60">Průběh, opakování chyb a obnovení po přerušení.</p>
        </div>
        <Button variant="ghost" onClick={load}>
          <RefreshCw size={18} className="mr-2" /> Obnovit
        </Button>
      </div>

      {logs.length > 0 && (
        <Card>
          <div className="p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Clock size={14} className="text-pink-400" />
              <span className="text-xs text-white/60">Poslední události</span>
            </div>
            <div className="text-xs text-white/50 space-y-1 font-mono">
              {logs.map((m, i) => (
                <div key={i}>• {m}</div>
              ))}
            </div>
          </div>
        </Card>
      )}

      <SectionTitle>Projekty</SectionTitle>
      {loading ? (
        <div className="h-40 flex items-center justify-center text-white/40">Načítá se…</div>
      ) : projects.length === 0 ? (
        <Card className="text-center p-12 text-white/50">
          <Download size={36} className="mx-auto mb-3 opacity-40" />
          <p>Žádné projekty. Spusťte stahování na kartě “Nové stahování”.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <Card key={p.id} className="hover:border-white/10 transition-border">
              <div className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  {p.coverPath ? (
                    <Cover coverPath={p.coverPath} className="w-14 h-20" />
                  ) : (
                    <div className="w-14 h-20 rounded-xl bg-white/5 flex items-center justify-center text-white/20">
                      <FileText size={20} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-semibold">{p.title}</div>
                    <div className="text-white/50 text-xs">{p.author} • {domainOf(p.sourceUrl)}</div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm text-white/80">
                    <span>Kapitoly</span>
                    <span>{p.downloadedChapters} / {p.totalChapters}</span>
                  </div>
                  <ProgressBar value={p.progress} className="h-2.5" />

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant={p.status === "completed" ? "ok" : p.status === "downloading" ? "warn" : "muted"}>
                      {statusLabel(p.status)}
                    </Badge>
                    {downloadManager.getCurrentChapter(p.id) && (
                      <Badge variant="muted">{downloadManager.getCurrentChapter(p.id)!.title}</Badge>
                    )}
                    {p.failedChapters > 0 && <Badge variant="bad">{p.failedChapters} selhalo</Badge>}
                    <span className="text-white/40">{formatDateShort(p.updatedAt)}</span>
                  </div>

                  <div className="flex gap-2 mt-3">
                    {p.status === "downloading" && (
                      <>
                        <Button variant="ghost" onClick={() => pause(p)}>
                          <Pause size={16} className="mr-1" /> Pozastavit
                        </Button>
                        <Button variant="danger" onClick={() => downloadManager.cancelProject(p.id)}>
                          <Trash2 size={16} className="mr-1" /> Zrušit
                        </Button>
                      </>
                    )}
                    {p.status === "paused" && (
                      <Button onClick={() => resume(p)}>
                        <Play size={16} className="mr-1" /> Obnovit
                      </Button>
                    )}
                    {p.status !== "downloading" && p.failedChapters > 0 && (
                      <Button variant="ghost" onClick={() => retry(p)}>
                        <RefreshCw size={16} className="mr-1" /> Zkusit selhané
                      </Button>
                    )}
                    {p.status === "completed" && (
                      <Button variant="ghost" onClick={() => navigate(`/project/${p.id}/export`)}>
                        <Share2 size={16} className="mr-1" /> Export EPUB
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "completed": return "Dokončeno";
    case "downloading": return "Stahuje se";
    case "paused": return "Pozastaveno";
    case "failed": return "Chyba";
    default: return "Připraveno";
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}
