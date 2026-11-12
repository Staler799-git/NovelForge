import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { projectStore } from "@/store";
import type { Project } from "@/types";
import { Card, Button, Badge, ProgressBar } from "@/components/ui";
import { formatDateShort } from "@/lib/utils";
import { BookOpen, RefreshCw, Share2, EllipsisVertical } from "lucide-react";

export function Library() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

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
    const unsub = projectStore.subscribe(() => {
      if (mounted) {
        db.getProjects().then((ps) => setProjects(ps));
      }
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, [load]);

  return (
    <div className="p-4 space-y-5 max-w-[700px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Knihovna</h1>
          <p className="text-white/60">Vaše stažené projekty připravené k exportu.</p>
        </div>
        {loading ? (
          <span className="text-white/40 text-xs animate-pulse">Načítá se…</span>
        ) : (
          <Button variant="ghost" onClick={load}>
            <RefreshCw size={18} className="mr-2" /> Obnovit
          </Button>
        )}
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center text-white/40">Načítá se…</div>
      ) : projects.length === 0 ? (
        <Card className="text-center p-12 text-white/50">
          <BookOpen size={36} className="mx-auto mb-3 opacity-40" />
          <p>Knihovna je prázdná.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.map((p) => (
            <Card key={p.id} className="hover:border-white/10 transition-border cursor-pointer" onClick={() => navigate(`/project/${p.id}`)}>
              <div className="p-4">
                <div className="flex items-center gap-4">
                  {p.coverPath ? (
                    <img src={`capacitor://${p.coverPath}`} alt="" className="w-20 h-28 rounded-xl object-cover bg-white/5" />
                  ) : (
                    <div className="w-20 h-28 rounded-xl bg-white/5 flex items-center justify-center text-white/20">
                      <BookOpen size={22} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-semibold">{p.title}</div>
                    <div className="text-white/50 text-sm">{p.author}</div>
                    <div className="mt-2 text-xs text-white/40">
                      {p.downloadedChapters}/{p.totalChapters} kapitol • {formatDateShort(p.updatedAt)}
                    </div>
                    <ProgressBar value={p.progress} />
                  </div>
                  <Badge variant={p.status === "completed" ? "ok" : "muted"}>
                    {p.status === "completed" ? "K exportu" : "Stahování"}
                  </Badge>
                </div>
                <div className="flex gap-2 mt-4">
                  {p.status === "completed" && (
                    <Button onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}/export`) }}>
                      <Share2 size={16} className="mr-1" /> Exportovat
                    </Button>
                  )}
                  <Button variant="ghost" onClick={(e) => { e.stopPropagation(); navigate(`/project/${p.id}`) }}>
                    <EllipsisVertical size={16} /> Detaily
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
