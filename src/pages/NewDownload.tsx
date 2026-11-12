import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { parseMetadata, parseChapterList } from "@/services/parser/registry";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { storage } from "@/services/storage";
import { generatePlaceholderCover } from "@/services/cover";
import { Card, SectionTitle, Button, Input, Textarea, Badge, ProgressBar } from "@/components/ui";
import { Search, AlertTriangle, List, ChevronRight } from "lucide-react";

type Step = "url" | "preview";

export function NewDownload() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<{ title: string; author: string; description?: string; language?: string; coverUrl?: string; sourceUrl: string; sourceDomain?: string } | null>(null);
  const [chapters, setChapters] = useState<{ title: string; url: string; orderIndex: number }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);

  const fetchNovel = useCallback(async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError("");
    try {
      const [m, ch] = await Promise.all([parseMetadata(url), parseChapterList(url)]);
      setMeta(m);
      setChapters(ch);
      setSelected(new Set(ch.map((c) => c.url)));
      setStep("preview");
    } catch (err: any) {
      setError(err?.message ?? "Nepodařilo se načíst stránku. Zkontrolujte URL a připojení.");
    } finally {
      setLoading(false);
    }
  }, [url]);

  const toggleAll = useCallback(() => {
    const all = chapters.every((c) => selected.has(c.url));
    setSelected(all ? new Set() : new Set(chapters.map((c) => c.url)));
  }, [chapters, selected]);

  const startDownload = async () => {
    if (!meta) return;
    setLoading(true);
    setDownloading(true);
    setProgress(0);
    setLog([]);
    try {
      await storage.init();
      await db.init();

      // Resolve cover to a local file
      let coverPath: string | undefined;
      const coverFile = `cover-${crypto.randomUUID()}`;
      if (meta.coverUrl) {
        try {
          const res = await fetch(meta.coverUrl);
          if (res.ok) {
            const arr = await res.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arr)));
            const ext = (meta.coverUrl.match(/\.(jpg|jpeg|png|webp)(\?|$)/i) ?? ["jpg"])[0].replace(".", "");
            const path = `NovelForge/covers/${coverFile}.${ext}`;
            const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
            await Filesystem.writeFile({ path, data: base64, directory: Directory.Documents, encoding: Encoding.UTF8 });
            coverPath = path;
          }
        } catch {
          /* cover optional */
        }
      }
      if (!coverPath) {
        try {
          coverPath = await generatePlaceholderCover(meta.title, `${coverFile}.svg`);
        } catch {
          /* no cover */
        }
      }

      const project = await db.createProject({
        title: meta.title,
        author: meta.author,
        language: meta.language ?? "cs",
        description: meta.description,
        sourceUrl: meta.sourceUrl,
        sourceDomain: meta.sourceDomain,
        coverPath,
        totalChapters: chapters.length,
        downloadedChapters: 0,
        failedChapters: 0,
        status: "idle",
        progress: 0,
      });

      const toInsert = chapters.filter((c) => selected.has(c.url));
      await db.upsertChapters(project.id, toInsert);

      const sub = downloadManager.on((e) => {
        if (e.type === "log") setLog((prev) => [...prev.slice(-49), e.message]);
        if (e.type === "progress") setProgress(e.progress);
        if (e.type === "project-end") {
          setDownloading(false);
          sub();
          if (e.ok) navigate(`/project/${project.id}`);
        }
      });

      await downloadManager.startProject(project);
    } catch (err: any) {
      setError(err?.message ?? "Stahování se nepodařilo spustit.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 space-y-5 max-w-[640px] mx-auto">
      <h1 className="text-[28px] font-bold tracking-tight text-white leading-tight">Nové stahování</h1>
      {step === "url" && (
        <Card>
          <SectionTitle>Adresa web novely</SectionTitle>
          <div className="space-y-3">
            <Input
              placeholder="https://www.wuxiabox.com/novel/i-created-the-longevity-club.html"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button className="w-full" onClick={fetchNovel} disabled={loading || !url.trim()}>
              {loading ? <Search className="mr-2 animate-spin" /> : <Search className="mr-2" />} Detekovat novelu
            </Button>
            {error && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <AlertTriangle size={16} className="mr-2" /> {error}
              </div>
            )}
            <p className="text-xs text-white/40">
              Podporováno: obecné HTML weby a (přes nativní prohlížeč) stránky vykreslované JavaScriptem.
            </p>
          </div>
        </Card>
      )}

      {step === "preview" && meta && (
        <>
          <div className="flex flex-col lg:flex-row gap-6">
            <div className="lg:w-1/3">
              <Card>
                <div className="flex items-center justify-center">
                  {meta.coverUrl ? (
                    <img src={meta.coverUrl} alt="" className="w-48 h-64 rounded-2xl object-cover bg-white/5" />
                  ) : (
                    <div className="w-48 h-64 rounded-2xl bg-white/5 flex items-center justify-center text-white/20">
                      <List size={32} />
                    </div>
                  )}
                </div>
                <div className="mt-3 p-3 rounded-xl bg-white/5 text-xs text-white/50">
                  Zdroj: {meta.sourceDomain ?? meta.sourceUrl}
                </div>
              </Card>
            </div>
            <div className="lg:w-2/3 flex-1">
              <Card>
                <SectionTitle className="mb-3">Upravit metadata</SectionTitle>
                <div className="space-y-3">
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Název</div>
                    <Input defaultValue={meta.title} onChange={(e) => setMeta({ ...meta!, title: e.target.value })} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Autor</div>
                    <Input defaultValue={meta.author} onChange={(e) => setMeta({ ...meta!, author: e.target.value })} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Popis</div>
                    <Textarea defaultValue={meta.description ?? ""} onChange={(e) => setMeta({ ...meta!, description: e.target.value })} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Jazyk</div>
                    <Input defaultValue={meta.language ?? "cs"} onChange={(e) => setMeta({ ...meta!, language: e.target.value })} />
                  </div>
                </div>
              </Card>

              <Card>
                <SectionTitle className="mb-3">Kapitoly ({chapters.length})</SectionTitle>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <Button variant="ghost" onClick={toggleAll}>
                    {selected.size === chapters.length ? "Odznačit vše" : "Označit vše"}
                  </Button>
                  <Badge variant="muted">Vybráno: {selected.size} / {chapters.length}</Badge>
                </div>
                <div className="max-h-[320px] overflow-y-auto space-y-1 p-1 bg-white/[0.03] rounded-xl">
                  {chapters.map((c) => (
                    <label key={c.url} className="flex items-center justify-between p-2 rounded-lg cursor-pointer transition hover:bg-white/5 group">
                      <input
                        type="checkbox"
                        className="rounded text-pink-500 focus:ring-pink-500 border-white/20"
                        checked={selected.has(c.url)}
                        onChange={() => {
                          const n = new Set(selected);
                          if (n.has(c.url)) n.delete(c.url); else n.add(c.url);
                          setSelected(n);
                        }}
                      />
                      <div className="flex-1 min-w-0 ml-3">
                        <div className="text-white text-sm truncate">{c.title}</div>
                        <div className="text-white/40 text-[10px] truncate">{c.url}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </Card>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setStep("url")}>Zpět</Button>
            <Button className="w-auto" disabled={selected.size === 0 || loading} onClick={startDownload}>
              {downloading ? <Search className="mr-2 animate-spin" /> : <ChevronRight size={18} className="mr-2" />}
              Spustit stahování ({selected.size})
            </Button>
          </div>
        </>
      )}

      {downloading && step === "preview" && (
        <Card>
          <SectionTitle>Stahování běží</SectionTitle>
          <ProgressBar value={progress} />
          <div className="text-white/50 text-sm">{progress} % kapitol</div>
          <div className="mt-3 text-xs text-white/40 space-y-1">
            {log.slice(-5).map((m, i) => (
              <div key={i}>• {m}</div>
            ))}
          </div>
          <p className="mt-2 text-xs text-white/50">
            Pokud aplikaci uzavřete, stahování je možné později obnovit na kartě “Stahování” — hotové kapitoly se nestahují znovu.
          </p>
        </Card>
      )}
    </div>
  );
}
