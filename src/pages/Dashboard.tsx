import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { projectStore } from "@/store";
import type { Project } from "@/types";
import { Card, SectionTitle, Badge, ProgressBar, Button } from "@/components/ui";
import { domainOf } from "@/lib/utils";
import { BookOpen, Download, FileText } from "lucide-react";

export function Dashboard() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const ps = await db.getProjects();
        if (mounted) setProjects(ps);
      } catch {
        /* ignore */
      }
    };
    load();
    const unsub = projectStore.subscribe(load);
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const chapters = projects.reduce((s, p) => s + p.downloadedChapters, 0);

  return (
    <div className="p-4 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">NovelForge</h1>
        <p className="text-white/60">Web novely → EPUB. Vše běží lokálně ve vašem iPhonu.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card padded={false}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Knihy v knihovně</div>
                <div className="text-3xl font-bold">{projects.length}</div>
              </div>
              <div className="p-3 rounded-2xl bg-white/5 text-pink-400"><BookOpen size={24} /></div>
            </div>
          </div>
        </Card>
        <Card padded={false}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Stažené kapitoly</div>
                <div className="text-3xl font-bold">{chapters}</div>
              </div>
              <div className="p-3 rounded-2xl bg-white/5 text-purple-400"><Download size={24} /></div>
            </div>
          </div>
        </Card>
        <Card padded={false}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Uloženo dat</div>
                <div className="text-3xl font-bold">—</div>
              </div>
              <div className="p-3 rounded-2xl bg-white/5 text-white"><FileText size={24} /></div>
            </div>
          </div>
        </Card>
      </div>

      <SectionTitle>Naposledy aktualizované</SectionTitle>
      {projects.length === 0 ? (
        <Card>
          <div className="p-10 text-center text-white/50">
            <p>Knihovna je prázdná. Přidejte první web novelu přes “Nové stahování”.</p>
            <Button className="mt-4" onClick={() => navigate("/new")}>
              <Download size={18} className="mr-2" /> Nová novela
            </Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {projects.slice(0, 8).map((p) => (
            <Card key={p.id} className="cursor-pointer group hover:border-white/10 transition-border" onClick={() => navigate(`/project/${p.id}`)}>
              <div className="flex gap-4">
                {p.coverPath ? (
                  <img src={`capacitor://${p.coverPath}`} alt="" className="w-20 h-28 rounded-xl object-cover bg-white/5" />
                ) : (
                  <div className="w-20 h-28 rounded-xl bg-white/5 flex items-center justify-center text-white/20">
                    <BookOpen size={20} />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-white font-semibold truncate">{p.title}</div>
                  <div className="text-white/50 text-sm truncate">{p.author}</div>
                  <div className="mt-2 text-xs text-white/40">
                    {domainOf(p.sourceUrl)} • {p.downloadedChapters}/{p.totalChapters} kapitol
                  </div>
                  <ProgressBar value={p.progress} />
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={p.status === "completed" ? "ok" : p.status === "downloading" ? "warn" : "muted"}>
                    {p.status === "completed" ? "Hotovo" : p.status === "downloading" ? "Stahuje se" : "Připraveno"}
                  </Badge>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mt-2">
        <Button variant="ghost" onClick={() => navigate("/new")} className="h-12">
          <Download size={18} className="mr-2" /> Nové stahování
        </Button>
        <Button variant="ghost" onClick={() => navigate("/library")} className="h-12">
          <BookOpen size={18} className="mr-2" /> Knihovna
        </Button>
      </div>
    </div>
  );
}
