import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { db } from "@/services/db";
import { generateEpub, generateTxt, generateHtml, type EpubChapter } from "@/services/epub";
import { pickCoverFromGallery, generatePlaceholderCover, readCover } from "@/services/cover";
import { normalizeLanguage } from "@/services/parser/base";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import type { Project } from "@/types";
import { Card, SectionTitle, Button, Input, Textarea, ProgressBar, Cover } from "@/components/ui";
import { Image as ImageIcon, RotateCw, Share as ShareIcon, FileText, Download as DownloadIcon } from "lucide-react";

type SplitMode = "single" | "chapters" | "range";

type ChapterPick = { id: string; title: string; url: string; orderIndex: number; status: string; filePath?: string; checksum?: string };

export function EpubExport() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [coverBase64, setCoverBase64] = useState<string | null>(null);
  const [coverMime, setCoverMime] = useState("image/jpeg");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [language, setLanguage] = useState("en");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [stats, setStats] = useState<{ downloaded: number; total: number; duplicates: number } | null>(null);
  const [notice, setNotice] = useState("");
  const [description, setDescription] = useState("");
  const [split, setSplit] = useState<SplitMode>("single");
  const [chapterCount, setChapterCount] = useState(50);
  const [customRange, setCustomRange] = useState("");
  const [format, setFormat] = useState<"epub" | "txt" | "html">("epub");
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ path: string; size: number; chapterCount?: number } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (!id) return;
      const p = await db.getProject(id);
      if (!p) return;
      if (mounted) {
        setProject(p);
        setTitle(p.title);
        setAuthor(p.author);
        setLanguage(p.language);
        setDescription(p.description ?? "");
      }
      const all = await db.getChapters(id);
      const done = all.filter((c) => c.status === "downloaded");
      if (mounted) setStats({ downloaded: done.length, total: all.length, duplicates: done.length - dedupeByContent(done).length });
    };
    load();
    return () => { mounted = false; };
  }, [id]);

  const pickCover = async () => {
    const picked = await pickCoverFromGallery();
    if (picked) {
      setCoverBase64(picked.base64);
      setCoverMime(picked.mime);
      if (project) {
        await db.updateProject(project.id, { coverPath: picked.path });
        setProject({ ...project, coverPath: picked.path });
      }
    }
  };

  const makePlaceholder = async () => {
    if (!project) return;
    const p = await generatePlaceholderCover(project.title, `cover-${crypto.randomUUID()}.svg`);
    const data = await readCover(p);
    setCoverBase64(data?.base64 ?? null);
    setCoverMime(data?.mime ?? "image/svg+xml");
  };

  const buildProject = (): Project => ({
    ...project!,
    title,
    author,
    language: normalizeLanguage(language, "en"),
    description,
  });

  const generate = async () => {
    if (!project) return;
    setGenerating(true);
    setError("");
    setNotice("");
    setResult(null);
    setProgress(5);
    try {
      const p = buildProject();
      await db.updateProject(p.id, { title: p.title, author: p.author, language: p.language, description: p.description });

      // Obálka: ručně zvolená má přednost, jinak uložená obálka projektu.
      // MIME typ se určuje ze skutečného obsahu souboru, ne z přípony.
      let coverToUse = coverBase64 ?? undefined;
      let mimeToUse = coverMime;
      if (!coverToUse) {
        const stored = await readCover(project.coverPath);
        if (stored) {
          coverToUse = stored.base64;
          mimeToUse = stored.mime;
        }
      }

      const chapters = await db.getChapters(p.id);
      const downloaded = chapters.filter((c) => c.status === "downloaded") as ChapterPick[];
      if (downloaded.length === 0) {
        setError("Žádné stažené kapitoly k exportu.");
        return;
      }

      const pool = skipDuplicates ? dedupeByContent(downloaded) : downloaded;
      const selected = selectChapters(pool, split, chapterCount, customRange);
      if (selected.length === 0) {
        setError("Zvolený rozsah neobsahuje žádnou staženou kapitolu.");
        return;
      }
      setProgress(15);

      let out;
      if (format === "epub") {
        const res = await generateEpub(p, selected, coverToUse, mimeToUse, (done, total) =>
          setProgress(15 + Math.round((done / total) * 75)),
        );
        out = res;
        const notes: string[] = [];
        if (!coverToUse) notes.push("Kniha nemá obálku.");
        if (res.missing.length) notes.push(`${res.missing.length} kapitol nemělo uložený text a v knize chybí (např. ${res.missing.slice(0, 3).join(", ")}).`);
        if (downloaded.length < chapters.length) notes.push(`Kniha obsahuje jen stažené kapitoly (${downloaded.length} z ${chapters.length}).`);
        setNotice(notes.join(" "));
      } else if (format === "txt") {
        out = await generateTxt(p, selected);
      } else {
        out = await generateHtml(p, selected);
      }
      setProgress(100);
      setResult(out);
      await Haptics.impact({ style: ImpactStyle.Medium });
    } catch (err: any) {
      setError(err?.message ?? "Export selhal.");
      setProgress(0);
    } finally {
      setGenerating(false);
    }
  };

  const share = async () => {
    if (!result) return;
    try {
      const uri = await Filesystem.getUri({ path: result.path, directory: Directory.Documents });
      await Share.share({
        title: project!.title,
        url: uri.uri,
        dialogTitle: "NovelForge – export",
      });
    } catch (err: any) {
      setError(err?.message ?? "Sdílení selhalo.");
    }
  };

  return (
    <div className="p-4 space-y-5 max-w-[640px] mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-[28px] font-bold tracking-tight text-white leading-tight">Export knihy</h1>
        <p className="text-white/60 text-sm">Jediný EPUB obsahující všechny vybrané kapitoly.</p>
      </div>

      {project ? (
        <>
          <Card>
            <SectionTitle>Metadata a obálka</SectionTitle>
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="flex-shrink-0 relative group">
                  {coverBase64 ? (
                    <img src={`data:${coverMime};base64,${coverBase64}`} alt="" className="w-32 h-44 rounded-xl object-cover bg-white/5 border border-white/10" />
                  ) : project.coverPath ? (
                    <Cover coverPath={project.coverPath} className="w-32 h-44 border border-white/10" />
                  ) : (
                    <div className="w-32 h-44 rounded-xl bg-white/5 flex items-center justify-center text-white/20 border border-white/10">
                      <ImageIcon size={24} />
                    </div>
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Název knihy</div>
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Autor</div>
                    <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Jazyk (kód, např. en, cs)</div>
                    <Input value={language} autoCapitalize="off" onChange={(e) => setLanguage(e.target.value)} />
                  </div>
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Popis</div>
                    <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={pickCover}>
                  <ImageIcon size={16} className="mr-2" /> Z galerie
                </Button>
                <Button variant="ghost" onClick={makePlaceholder}>
                  <RotateCw size={16} className="mr-2" /> Placeholder
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Formát a rozdělení</SectionTitle>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <input id="fmt-epub" type="radio" checked={format === "epub"} onChange={() => setFormat("epub")} className="text-pink-500" />
                <label htmlFor="fmt-epub" className="text-white font-medium"><DownloadIcon size={16} className="mr-2" /> EPUB 3 (všechny kapitoly v jednom souboru)</label>
              </div>
              <div className="flex items-center gap-3">
                <input id="fmt-txt" type="radio" checked={format === "txt"} onChange={() => setFormat("txt")} className="text-pink-500" />
                <label htmlFor="fmt-txt" className="text-white font-medium"><FileText size={16} className="mr-2" /> TXT</label>
              </div>
              <div className="flex items-center gap-3">
                <input id="fmt-html" type="radio" checked={format === "html"} onChange={() => setFormat("html")} className="text-pink-500" />
                <label htmlFor="fmt-html" className="text-white font-medium"><ImageIcon size={16} className="mr-2" /> HTML</label>
              </div>

              {format === "epub" && (
                <div className="space-y-3 pt-2">
                  <div>
                    <div className="text-white/50 text-xs uppercase tracking-wider">Rozdělení (volitelné)</div>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={split === "single"} onChange={() => setSplit("single")} className="text-pink-500" />
                        <span className="text-white">Jeden soubor (výchozí, bez dělení)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={split === "chapters"} onChange={() => setSplit("chapters")} className="text-pink-500" />
                        <span className="text-white">Pouze první N kapitol do jednoho souboru</span>
                      </label>
                      <div className="ml-6 flex items-center gap-2">
                        <span className="text-white/50 text-xs">Kapitol</span>
                        <Input type="number" value={chapterCount} onChange={(e) => setChapterCount(Math.max(1, Number(e.target.value || 1)))} className="w-20" />
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={split === "range"} onChange={() => setSplit("range")} className="text-pink-500" />
                        <span className="text-white">Vlastní rozsah (např. 1-50, 51-100)</span>
                      </label>
                      <div className="ml-6 flex items-center gap-2">
                        <Input placeholder="1-100" value={customRange} onChange={(e) => setCustomRange(e.target.value)} className="w-32" />
                      </div>
                    </div>
                  </div>
                  <p className="text-white/40 text-xs">NovelForge nerozděluje knihu na svazky bez vašeho výslovného souhlasu.</p>
                </div>
              )}
            </div>
          </Card>

          {stats && (
            <Card>
              <div className="text-sm text-white/80">
                Stažených kapitol: <strong className="text-white">{stats.downloaded}</strong> z {stats.total}
              </div>
              {stats.downloaded < stats.total && (
                <div className="mt-1 text-xs text-amber-400">Kniha bude obsahovat jen stažené kapitoly, ve správném pořadí.</div>
              )}
              {stats.duplicates > 0 && (
                <label className="mt-3 flex items-start gap-2 cursor-pointer">
                  <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} className="mt-1" />
                  <span className="text-sm text-white">
                    Vynechat {stats.duplicates} kapitol se shodným textem
                    <span className="block text-xs text-white/50">Mají stejný obsah jako dřívější kapitola (porovnává se otisk normalizovaného textu).</span>
                  </span>
                </label>
              )}
            </Card>
          )}

          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => navigate(`/project/${project.id}`)}>Zpět</Button>
            <Button className="w-full md:w-auto" disabled={generating} onClick={generate}>
              {generating ? "Generuji…" : "Vytvořit a připravit k sdílení"}
            </Button>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
          )}

          {notice && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm">{notice}</div>
          )}

          {progress > 0 && progress < 100 && (
            <div className="space-y-2">
              <div className="text-xs text-white/60">Export běží…</div>
              <ProgressBar value={progress} />
            </div>
          )}

          {result && (
            <Card>
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-white font-semibold break-all">{result.path.split("/").pop()}</div>
                    <div className="text-white/50 text-xs">
                      {result.chapterCount ? `${result.chapterCount} kapitol · ` : ""}
                      {result.size ? (result.size / 1024 / 1024).toFixed(2) + " MB" : ""}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex gap-3">
                  <Button onClick={share} className="flex-1"><ShareIcon size={18} className="mr-2" /> Sdílet / otevřít ve čtečce</Button>
                  <Button variant="ghost" onClick={() => navigate("/library")} className="flex-1">Hotovo</Button>
                </div>
              </div>
            </Card>
          )}
        </>
      ) : (
        <div className="h-60 flex flex-col items-center justify-center text-white/40">Načítá se projekt…</div>
      )}
    </div>
  );
}

/**
 * Vynechá kapitoly, jejichž NORMALIZOVANÝ text je shodný s dřívější kapitolou
 * (stejný otisk obsahu). Ponechá první výskyt; pořadí se nemění.
 * Kapitoly bez otisku (stažené starší verzí) se nikdy nevynechávají.
 */
export function dedupeByContent<T extends { checksum?: string; orderIndex: number }>(chapters: T[]): T[] {
  const seen = new Set<string>();
  return chapters
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .filter((c) => {
      // otisk obsahu má 16 hex znaků; starší 8znakový otisk zahrnoval i název
      if (!c.checksum || c.checksum.length !== 16) return true;
      if (seen.has(c.checksum)) return false;
      seen.add(c.checksum);
      return true;
    });
}

function selectChapters(
  all: ChapterPick[],
  mode: SplitMode,
  chapterCount: number,
  customRange: string
): EpubChapter[] {
  if (mode === "single") return all as EpubChapter[];
  if (mode === "chapters") return all.slice(0, chapterCount) as EpubChapter[];
  if (mode === "range") {
    const m = customRange.match(/(\d+)\s*-\s*(\d+)/);
    if (!m) return all as EpubChapter[];
    const from = Math.max(1, parseInt(m[1], 10));
    const to = Math.min(all.length, parseInt(m[2], 10));
    return all.filter((_, i) => i + 1 >= from && i + 1 <= to) as EpubChapter[];
  }
  return all as EpubChapter[];
}
