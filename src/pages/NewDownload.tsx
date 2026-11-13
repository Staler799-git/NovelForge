import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { parseMetadata, parseCatalog, parseChapter } from "@/services/parser/registry";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { storage } from "@/services/storage";
import { projectStore } from "@/store";
import { isAbort } from "@/services/http";
import { analyzeLogical, selectVariant, verifyAlternatives, findGaps, type AlternativeCheck, type VariantChoice } from "@/services/catalog";
import { generatePlaceholderCover, downloadCover, saveCover, pickCoverFromGallery, coverDataUri, type CoverData } from "@/services/cover";
import type { CatalogProgress, CatalogResult, NovelMetadata, ParserChapter } from "@/types";
import { Card, SectionTitle, Button, Input, Textarea, Badge, ProgressBar } from "@/components/ui";
import { Search, AlertTriangle, List, ChevronRight, Square, Image as ImageIcon, Loader2 } from "lucide-react";

type Step = "url" | "preview";

const PAGE_SIZE = 200;

export function NewDownload() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<NovelMetadata | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [variant, setVariant] = useState<VariantChoice>("all");
  const [comparison, setComparison] = useState<AlternativeCheck | null>(null);
  const [comparing, setComparing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectProgress, setDetectProgress] = useState<CatalogProgress | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [cover, setCover] = useState<CoverData | null>(null);
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [coverNote, setCoverNote] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const allChapters = catalog?.chapters ?? [];
  const analysis = useMemo(() => analyzeLogical(allChapters), [allChapters]);
  const selection = useMemo(() => selectVariant(allChapters, variant, analysis), [allChapters, variant, analysis]);

  /** Kapitoly zvolené verze ve správném pořadí (vyřazené alternativy tu nejsou). */
  const chapters: ParserChapter[] = useMemo(() => {
    const byUrl = new Map(allChapters.map((c) => [c.url, c]));
    return selection.chapters.filter((c) => !c.excluded).map((c) => ({ ...byUrl.get(c.url)!, orderIndex: c.orderIndex }));
  }, [allChapters, selection]);

  const gaps = useMemo(() => findGaps(chapters), [chapters]);
  const selectedCount = useMemo(() => chapters.filter((c) => selected.has(c.url)).length, [chapters, selected]);

  const loadCover = useCallback(async (m: NovelMetadata, signal: AbortSignal) => {
    setCover(null);
    setCoverPath(null);
    if (!m.coverUrl) {
      setCoverNote("Web neposkytl obálku. Můžete ji vybrat z galerie.");
      return;
    }
    setCoverNote("Stahuji obálku…");
    try {
      const data = await downloadCover(m.coverUrl, m.sourceUrl, signal);
      if (!mounted.current) return;
      setCover(data);
      setCoverNote("");
    } catch (err: any) {
      if (!mounted.current || isAbort(err)) return;
      setCoverNote(`${err?.message ?? "Obálku se nepodařilo stáhnout"}. Můžete ji vybrat z galerie.`);
    }
  }, []);

  const applyCatalog = useCallback((result: CatalogResult) => {
    setCatalog(result);
    const a = analyzeLogical(result.chapters);
    // Alternativní verze se nikdy nemíchají automaticky: předvybere se hlavní
    // řada (pokrývá celou knihu), uživatel může volbu změnit.
    const choice: VariantChoice = a.alternatives > 0 ? "plain" : "all";
    setVariant(choice);
    setSelected(new Set(selectVariant(result.chapters, choice, a).chapters.filter((c) => !c.excluded).map((c) => c.url)));
    setVisible(PAGE_SIZE);
    setRangeFrom("");
    setRangeTo("");
    setComparison(null);
  }, []);

  const fetchNovel = useCallback(async () => {
    const target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) {
      setError("Zadejte celou adresu včetně https://");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setDetecting(true);
    setError("");
    setDetectProgress(null);
    setCatalog(null);
    setMeta(null);
    setPhase("Načítám stránku novely…");
    try {
      const m = await parseMetadata(target, { signal: ctrl.signal });
      if (!mounted.current) return;
      if (!m.title.trim()) {
        // Stránka vrátila jen název webu – není to stránka novely. Projekt se nevytvoří.
        setError("Katalog kapitol nebyl spolehlivě rozpoznán. Stránka neobsahuje údaje o novele – zkontrolujte, že adresa vede na stránku novely.");
        return;
      }
      setMeta(m);
      void loadCover(m, ctrl.signal);
      setPhase("Načítám katalog kapitol…");
      const result = await parseCatalog(target, {
        signal: ctrl.signal,
        onProgress: (p) => mounted.current && setDetectProgress(p),
      });
      if (!mounted.current) return;
      if (result.chapters.length === 0) {
        setError(
          result.aborted
            ? "Detekce byla zastavena dřív, než se našly kapitoly."
            : "Na stránce nebyly nalezeny žádné kapitoly. Zkontrolujte, že adresa vede na stránku novely.",
        );
        return;
      }
      applyCatalog({ ...result, declaredTotal: result.declaredTotal ?? m.declaredChapters });
      setStep("preview");
    } catch (err: any) {
      if (!mounted.current) return;
      const msg = String(err?.message ?? "neznámá chyba");
      setError(isAbort(err) ? "Detekce byla zastavena." : /^Katalog kapitol nebyl spolehlivě rozpoznán/.test(msg) ? msg : `Novelu se nepodařilo načíst: ${msg}`);
    } finally {
      if (mounted.current) {
        setDetecting(false);
        setPhase("");
      }
    }
  }, [url, loadCover, applyCatalog]);

  const stopDetection = () => abortRef.current?.abort();

  const chooseVariant = (choice: VariantChoice) => {
    setVariant(choice);
    setSelected(new Set(selectVariant(allChapters, choice, analysis).chapters.filter((c) => !c.excluded).map((c) => c.url)));
    setVisible(PAGE_SIZE);
  };

  const runComparison = async () => {
    if (analysis.alternatives === 0) return;
    setComparing(true);
    setComparison(null);
    try {
      setComparison(await verifyAlternatives(allChapters, (u) => parseChapter(u)));
    } catch (err: any) {
      setComparison({ verdict: "uncertain", aligned: null, pairs: [], message: `Ověření se nezdařilo: ${err?.message ?? "neznámá chyba"}` });
    } finally {
      setComparing(false);
    }
  };

  const toggleAll = () => {
    setSelected(selectedCount === chapters.length ? new Set() : new Set(chapters.map((c) => c.url)));
  };

  const applyRange = () => {
    const from = Math.max(1, parseInt(rangeFrom || "1", 10) || 1);
    const to = Math.min(chapters.length, parseInt(rangeTo || String(chapters.length), 10) || chapters.length);
    if (from > to) return;
    setSelected(new Set(chapters.slice(from - 1, to).map((c) => c.url)));
  };

  const pickCover = async () => {
    let picked;
    try {
      picked = await pickCoverFromGallery();
    } catch (err: any) {
      setCoverNote(`${err?.message ?? "Obrázek se nepodařilo zpracovat"}. Vyberte jiný obrázek z galerie.`);
      return;
    }
    if (!picked) return;
    setCover({ base64: picked.base64, mime: picked.mime });
    setCoverPath(picked.path);
    setCoverNote("");
  };

  const startDownload = async () => {
    if (!meta || starting) return;
    const toInsert = chapters.filter((c) => selected.has(c.url));
    if (toInsert.length === 0) return;
    setStarting(true);
    setError("");
    try {
      await storage.init();
      await db.init();

      let finalCover = coverPath ?? undefined;
      if (!finalCover && cover) {
        try {
          finalCover = await saveCover(cover);
        } catch (err) {
          console.warn("Uložení obálky selhalo", err);
        }
      }
      if (!finalCover) {
        try {
          finalCover = await generatePlaceholderCover(meta.title, `cover-${crypto.randomUUID()}.svg`);
        } catch {
          /* kniha může být i bez obálky */
        }
      }

      const project = await db.createProject({
        title: meta.title.trim() || "Bez názvu",
        author: meta.author.trim(),
        language: (meta.language ?? "en").trim() || "en",
        description: meta.description,
        sourceUrl: meta.sourceUrl,
        sourceDomain: meta.sourceDomain,
        coverPath: finalCover,
        totalChapters: toInsert.length,
        downloadedChapters: 0,
        failedChapters: 0,
        status: "idle",
        progress: 0,
      });

      // Ukládají se i adresy nevybraných alternativních verzí (jako vyřazené),
      // aby šla verze později změnit a adresy zkontrolovat. Pořadí je společné.
      const byUrl = new Map(allChapters.map((c) => [c.url, c]));
      const rows = selection.chapters
        .filter((c) => c.excluded || selected.has(c.url))
        .map((c) => ({ title: byUrl.get(c.url)!.title, url: c.url, orderIndex: c.orderIndex, excluded: c.excluded }));
      await db.upsertChapters(project.id, rows);

      // Stahování běží na pozadí – průběh ukazuje detail projektu.
      void downloadManager.startProject(project);
      void projectStore.refresh();
      navigate(`/project/${project.id}`);
    } catch (err: any) {
      setError(`Stahování se nepodařilo spustit: ${err?.message ?? "neznámá chyba"}`);
      setStarting(false);
    }
  };

  const pagesText = detectProgress
    ? `Stránka ${detectProgress.pagesLoaded}${detectProgress.pagesTotal ? ` z ${detectProgress.pagesTotal}` : ""}`
    : "";
  const detectPct =
    detectProgress?.pagesTotal ? Math.min(100, Math.round((detectProgress.pagesLoaded / detectProgress.pagesTotal) * 100)) : 0;

  const errorBox = error && (
    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex gap-2" role="alert">
      <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" /> <span>{error}</span>
    </div>
  );

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
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              disabled={detecting}
              onChange={(e) => setUrl(e.target.value)}
            />
            {!detecting ? (
              <Button className="w-full" onClick={fetchNovel} disabled={!url.trim()}>
                <Search size={18} /> Detekovat novelu
              </Button>
            ) : (
              <div className="space-y-3 p-3 rounded-xl bg-white/5 border border-white/10" aria-live="polite">
                <div className="flex items-center gap-2 text-sm text-white">
                  <Loader2 size={16} className="animate-spin text-pink-400" />
                  <span>{phase}</span>
                </div>
                {meta && <div className="text-sm text-white/70 truncate">{meta.title}</div>}
                {detectProgress && (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="text-2xl font-bold text-white" data-testid="found-count">{detectProgress.chaptersFound}</span>
                      <span className="text-xs text-white/50">nalezených kapitol · {pagesText}</span>
                    </div>
                    {detectProgress.pagesTotal ? <ProgressBar value={detectPct} className="h-2" /> : null}
                  </>
                )}
                <Button variant="danger" className="w-full" onClick={stopDetection}>
                  <Square size={16} /> Zastavit detekci
                </Button>
              </div>
            )}
            {errorBox}
            <p className="text-xs text-white/40">
              U stránkovaných katalogů (např. WuxiaBox) se načtou všechny stránky seznamu kapitol. Detekci lze kdykoli zastavit.
            </p>
          </div>
        </Card>
      )}

      {step === "preview" && meta && catalog && (
        <>
          <Card>
            <div className="flex gap-4">
              <div className="flex-shrink-0">
                {cover ? (
                  <img src={coverDataUri(cover.base64, cover.mime)} alt="Obálka" className="w-28 h-40 rounded-xl object-cover bg-white/5 border border-white/10" />
                ) : (
                  <div className="w-28 h-40 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white/20">
                    <List size={28} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <div className="text-white font-semibold leading-snug">{meta.title}</div>
                <div className="text-xs text-white/50">Zdroj: {meta.sourceDomain ?? meta.sourceUrl}</div>
                {coverNote && <div className="text-xs text-amber-400">{coverNote}</div>}
                <Button variant="ghost" onClick={pickCover}>
                  <ImageIcon size={16} /> Obálka z galerie
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle className="mb-3">Katalog</SectionTitle>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="p-3 rounded-xl bg-white/5">
                <div className="text-white/40 text-xs">Nalezeno adres</div>
                <div className="text-xl font-bold text-white">{catalog.chapters.length}</div>
              </div>
              <div className="p-3 rounded-xl bg-white/5">
                <div className="text-white/40 text-xs">Unikátních kapitol</div>
                <div className="text-xl font-bold text-white">{analysis.uniqueCount}</div>
              </div>
              <div className="p-3 rounded-xl bg-white/5">
                <div className="text-white/40 text-xs">Web uvádí</div>
                <div className="text-xl font-bold text-white">{catalog.declaredTotal ?? "—"}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={catalog.complete ? "ok" : "warn"}>{catalog.complete ? "Katalog kompletní" : "Katalog NENÍ kompletní"}</Badge>
              <Badge variant="muted">Stránek katalogu: {catalog.pagesLoaded}</Badge>
            </div>
            {catalog.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-amber-400">
                {catalog.warnings.map((w, i) => (
                  <li key={i} className="flex gap-2"><AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> <span>{w}</span></li>
                ))}
              </ul>
            )}
            {gaps.reliable && gaps.missingCount > 0 && (
              <div className="mt-3 text-xs text-amber-400 flex gap-2">
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <span>
                  V číslování chybí {gaps.missingCount} kapitol (např. {gaps.missing.slice(0, 8).join(", ")}
                  {gaps.missingCount > 8 ? "…" : ""}). Web je možná nemá, nebo je katalog neúplný.
                </span>
              </div>
            )}
            {gaps.reliable && gaps.missingCount === 0 && (
              <div className="mt-3 text-xs text-green-400">Číslování {gaps.first}–{gaps.last} je souvislé, žádná kapitola nechybí.</div>
            )}
          </Card>

          {(analysis.alternatives > 0 || analysis.uncertain.length > 0) && (
            <Card>
              <SectionTitle className="mb-2">Alternativní verze kapitol</SectionTitle>
              <p className="text-xs text-white/60 mb-3">
                Katalog má {analysis.urlCount} adres, ale jen {analysis.uniqueCount} různých kapitol.
                {analysis.altRange && (
                  <> Kapitoly {analysis.altRange.first}–{analysis.altRange.last} ({analysis.alternatives}) existují ve dvou verzích. Verze se
                  automaticky nemíchají – vyberte, kterou chcete. Adresy druhé verze zůstanou uložené.</>
                )}
              </p>
              {analysis.alternatives > 0 && (
                <div className="space-y-2">
                  {analysis.variants.map((v) => (
                    <label key={v.id} className={`block p-3 rounded-xl border cursor-pointer ${variant === v.id ? "border-pink-500/60 bg-pink-500/10" : "border-white/10 bg-white/5"}`}>
                      <div className="flex items-center gap-2">
                        <input type="radio" name="variant" checked={variant === v.id} onChange={() => chooseVariant(v.id)} />
                        <span className="text-white text-sm font-semibold">{v.label}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-white/50 truncate">{v.samples.join("  ·  ")}</div>
                    </label>
                  ))}
                  <label className={`block p-3 rounded-xl border cursor-pointer ${variant === "all" ? "border-pink-500/60 bg-pink-500/10" : "border-white/10 bg-white/5"}`}>
                    <div className="flex items-center gap-2">
                      <input type="radio" name="variant" checked={variant === "all"} onChange={() => chooseVariant("all")} />
                      <span className="text-white text-sm font-semibold">Obě verze</span>
                      <Badge variant="muted">{allChapters.length}</Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-white/50">Kniha bude stejnou část příběhu obsahovat dvakrát.</div>
                  </label>
                </div>
              )}
              {selection.warnings.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-amber-400">
                  {selection.warnings.map((w, i) => (
                    <li key={i} className="flex gap-2"><AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /> <span>{w}</span></li>
                  ))}
                </ul>
              )}
              {analysis.alternatives > 0 && (
                <div className="mt-3">
                  <Button variant="ghost" onClick={runComparison} disabled={comparing}>
                    {comparing ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />} Ověřit verze na vzorku
                  </Button>
                  {comparison && (
                    <div className={`mt-2 text-xs ${comparison.verdict === "uncertain" ? "text-amber-400" : "text-green-400"}`}>
                      {comparison.message}
                      {comparison.pairs.map((p) => (
                        <div key={p.number} className="text-white/50">
                          kap. {p.number}: shoda textu {Math.round(p.similarity * 100)} %, shoda jmen a čísel {Math.round(p.affinity * 100)} %
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle className="mb-3">Metadata</SectionTitle>
            <div className="space-y-3">
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Název</div>
                <Input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
              </div>
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Autor</div>
                <Input value={meta.author} onChange={(e) => setMeta({ ...meta, author: e.target.value })} />
              </div>
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Jazyk (kód, např. en, cs)</div>
                <Input value={meta.language ?? ""} autoCapitalize="off" onChange={(e) => setMeta({ ...meta, language: e.target.value })} />
              </div>
              <div>
                <div className="text-white/50 text-xs uppercase tracking-wider">Popis</div>
                <Textarea value={meta.description ?? ""} onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle className="mb-3">Kapitoly ({chapters.length})</SectionTitle>
            <div className="flex items-center justify-between gap-3 mb-3">
              <Button variant="ghost" onClick={toggleAll}>
                {selectedCount === chapters.length ? "Odznačit vše" : "Označit vše"}
              </Button>
              <Badge variant="muted">Vybráno: {selectedCount} / {chapters.length}</Badge>
            </div>
            <div className="flex items-end gap-2 mb-3">
              <div className="flex-1">
                <div className="text-white/50 text-xs">Od</div>
                <Input type="number" inputMode="numeric" placeholder="1" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
              </div>
              <div className="flex-1">
                <div className="text-white/50 text-xs">Do</div>
                <Input type="number" inputMode="numeric" placeholder={String(chapters.length)} value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
              </div>
              <Button variant="ghost" onClick={applyRange}>Vybrat rozsah</Button>
            </div>
            <div className="max-h-[320px] overflow-y-auto space-y-1 p-1 bg-white/[0.03] rounded-xl">
              {chapters.slice(0, visible).map((c, i) => (
                <label key={c.url} className="flex items-center p-2 rounded-lg cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(c.url)}
                    onChange={() => {
                      const n = new Set(selected);
                      if (n.has(c.url)) n.delete(c.url); else n.add(c.url);
                      setSelected(n);
                    }}
                  />
                  <span className="ml-3 w-10 text-right text-white/40 text-xs flex-shrink-0">{i + 1}.</span>
                  <span className="ml-2 text-white text-sm truncate">{c.title}</span>
                </label>
              ))}
              {visible < chapters.length && (
                <Button variant="ghost" className="w-full" onClick={() => setVisible((v) => v + 500)}>
                  Zobrazit dalších {Math.min(500, chapters.length - visible)} (z {chapters.length})
                </Button>
              )}
            </div>
          </Card>

          {errorBox}

          <div className="flex justify-end gap-3">
            <Button variant="ghost" disabled={starting} onClick={() => { setStep("url"); setError(""); }}>Zpět</Button>
            <Button disabled={selectedCount === 0 || starting} onClick={startDownload}>
              {starting ? <Loader2 size={18} className="animate-spin" /> : <ChevronRight size={18} />}
              {starting ? "Připravuji…" : `Spustit stahování (${selectedCount})`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
