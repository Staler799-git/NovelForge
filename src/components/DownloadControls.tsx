/**
 * Ovládání a stav stahování jednoho projektu: rychlost, překlad, podmínky,
 * přístupová omezení zdroje a skutečný stav běhu na pozadí.
 */
import { useEffect, useState } from "react";
import { db } from "@/services/db";
import { downloadManager } from "@/services/downloader";
import { parserInfo, probeTranslationModes, checkSession } from "@/services/parser/registry";
import type { ModeProbe, SessionState } from "@/services/parser/base";
import { accessLabel, type AccessKind } from "@/services/access";
import { SPEED_LABELS, formatDuration, normalizeSpeedMode } from "@/services/speed";
import { canOpenAuthBrowser, openAuthBrowser, openExternal } from "@/services/device";
import type { Project, ProjectSettings, SpeedMode } from "@/types";
import { Button, Badge } from "@/components/ui";
import { ExternalLink, ShieldCheck, Gauge } from "lucide-react";

const SELECT = "w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-white disabled:opacity-50";

function probeText(p: ModeProbe): string {
  if (p.state === "available") return "dostupný";
  if (p.state === "unknown") return "neověřeno";
  return accessLabel(p.state as AccessKind).toLowerCase() || "nedostupný";
}

export function DownloadControls({ project, running, onChanged }: { project: Project; running: boolean; onChanged: () => void }) {
  const info = parserInfo(project.sourceUrl);
  const modes = info.translationModes;
  const settings: ProjectSettings = project.settings ?? { concurrentRequests: 3, delayMs: 1500, maxRetries: 5 };
  const speed = normalizeSpeedMode(settings.speedMode);
  const mode = settings.translationMode ?? (modes.length ? info.legacyTranslationMode : undefined);
  const view = running ? downloadManager.getRunView(project.id) : undefined;

  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<ModeProbe[] | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [message, setMessage] = useState("");
  const [, tick] = useState(0);

  // Živé údaje (rychlost, odhad) se překreslují i mezi událostmi stahování.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [running]);

  const save = async (patch: Partial<ProjectSettings>, extra: Partial<Project> = {}) => {
    await db.updateProject(project.id, { ...extra, settings: { ...settings, ...patch } });
    onChanged();
  };

  const changeMode = async (next: string) => {
    if (!next || next === mode) return;
    const from = modes.find((m) => m.id === mode)?.label ?? mode ?? "–";
    const to = modes.find((m) => m.id === next)?.label ?? next;
    if (project.downloadedChapters > 0) {
      const ok = window.confirm(
        `Projekt má ${project.downloadedChapters} kapitol stažených v překladu ${from}.\n\n` +
          `Další kapitoly se stáhnou v překladu ${to}. Formulace, jména a názvy kapitol se mezi překlady mohou lišit a kniha pak bude obsahovat dva překlady.\n\n` +
          `Stažené kapitoly zůstanou beze změny. Změnit překlad?`,
      );
      if (!ok) return;
    }
    setProbes(null);
    // Dřívější překážka se týkala původního překladu.
    await save({ translationMode: next }, { accessKind: "", accessMessage: "", status: project.status === "waiting-auth" ? "paused" : project.status });
    setMessage(`Překlad změněn na ${to}.`);
  };

  const probe = async () => {
    setBusy(true);
    setMessage("");
    try {
      const chapters = await db.getChapters(project.id);
      const target = chapters.find((c) => !c.excluded && c.status !== "downloaded") ?? chapters.find((c) => !c.excluded);
      if (!target) {
        setMessage("Projekt nemá kapitolu, na které by šlo překlady ověřit.");
        return;
      }
      setProbes(await probeTranslationModes(target.url));
      setMessage(`Ověřeno na kapitole „${target.title}“.`);
    } catch (err) {
      setMessage(`Ověření se nepodařilo: ${(err as Error)?.message ?? "neznámá chyba"}`);
    } finally {
      setBusy(false);
    }
  };

  const verifySession = async () => {
    setBusy(true);
    try {
      setSession(await checkSession(project.sourceUrl, { fresh: true }));
    } catch {
      setSession("unknown");
    } finally {
      setBusy(false);
    }
  };

  const openInApp = async () => {
    setBusy(true);
    setMessage("");
    try {
      const r = await openAuthBrowser(project.sourceUrl);
      if (!r.opened) {
        setMessage("Okno pro přihlášení není v tomto buildu k dispozici – použijte Safari.");
        return;
      }
      setMessage("Okno zavřeno. Pokud jste se přihlásili nebo provedli ověření, zvolte Pokračovat.");
      if (modes.length) await verifySession();
    } catch (err) {
      setMessage(`Okno se nepodařilo otevřít: ${(err as Error)?.message ?? "neznámá chyba"}`);
    } finally {
      setBusy(false);
    }
  };

  const blocked = !running && !!project.accessMessage;

  return (
    <div className="space-y-3" data-testid="download-controls">
      {view && (
        <div className="rounded-xl bg-white/5 border border-white/5 p-3 text-xs text-white/70 space-y-1" data-testid="run-stats">
          <div className="flex items-center gap-2 text-white/80">
            <Gauge size={14} className="text-pink-400" />
            <span>
              {view.perMinute > 0 ? `${view.perMinute.toFixed(1)} kap./min` : "Měří se…"}
              {view.avgChapterMs > 0 && ` • průměr ${(view.avgChapterMs / 1000).toFixed(1)} s na kapitolu`}
              {view.etaMs !== null && ` • zbývá asi ${formatDuration(view.etaMs)}`}
            </span>
          </div>
          <div>
            Rychlost: {SPEED_LABELS[view.effectiveSpeedMode]}
            {view.effectiveSpeedMode !== view.speedMode && " (rychlý režim tento web nedovoluje)"} • {view.concurrency === 1 ? "po jedné kapitole" : `${view.concurrency} souběžně`} • odstup {(view.delayMs / 1000).toFixed(1)} s
            {view.slowdowns > 0 && " • zpomaleno kvůli omezení webu"}
          </div>
          {view.translationLabel && <div>Překlad: {view.translationLabel}</div>}
          {view.waiting && <div className="text-amber-400">{view.waiting}</div>}
          <div className="text-white/40">
            Na pozadí: po zamčení telefonu nebo přepnutí aplikace iOS dovolí dokončit rozpracovanou kapitolu (zhruba 30 s) a pak stahování pozastaví. Po návratu do aplikace pokračuje samo.
          </div>
        </div>
      )}

      {blocked && (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 space-y-2" data-testid="access-block">
          <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
            <ShieldCheck size={16} /> {accessLabel(project.accessKind as AccessKind) || "Stahování pozastaveno"}
          </div>
          <div className="text-xs text-white/80 leading-relaxed">{project.accessMessage}</div>
          <div className="flex flex-wrap gap-2">
            {canOpenAuthBrowser() && (
              <Button variant="ghost" onClick={openInApp} disabled={busy}>
                <ShieldCheck size={16} /> Přihlásit / ověřit v aplikaci
              </Button>
            )}
            <Button variant="ghost" onClick={() => openExternal(project.sourceUrl)}>
              <ExternalLink size={16} /> Otevřít zdrojovou stránku
            </Button>
          </div>
          <div className="text-[11px] text-white/40 leading-relaxed">
            Přihlášení i bezpečnostní ověření provádíte vždy sami. Přihlášení provedené v Safari se do aplikace nepřenáší (iOS relace mezi aplikacemi nesdílí) – pro pokračování použijte okno v aplikaci.
            Heslo aplikace nevidí ani neukládá.
          </div>
        </div>
      )}

      <details className="rounded-xl bg-white/5 border border-white/5">
        <summary className="cursor-pointer p-3 text-sm text-white/80">
          Nastavení stahování
          <span className="ml-2 text-xs text-white/40">
            {SPEED_LABELS[speed]}
            {mode && ` • ${modes.find((m) => m.id === mode)?.label ?? mode}`}
            {settings.wifiOnly && " • jen Wi-Fi"}
            {settings.chargingOnly && " • jen při nabíjení"}
          </span>
        </summary>
        <div className="p-3 pt-0 space-y-3">
          <label className="block text-xs text-white/60">
            Rychlost
            <select className={SELECT} value={speed} disabled={running} onChange={(e) => void save({ speedMode: e.target.value as SpeedMode })} aria-label="Rychlost stahování">
              <option value="eco">Úsporný – po jedné kapitole, delší odstupy (šetří baterii a paměť)</option>
              <option value="balanced">Vyvážený – výchozí</option>
              <option value="fast" disabled={!info.allowFast}>
                Rychlý{info.allowFast ? " – více kapitol naráz, kratší odstupy" : " – tento web ho nedovoluje"}
              </option>
            </select>
          </label>

          {modes.length > 0 && (
            <div className="space-y-2">
              <label className="block text-xs text-white/60">
                Překlad
                <select className={SELECT} value={mode ?? ""} disabled={running || busy} onChange={(e) => void changeMode(e.target.value)} aria-label="Překlad">
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-[11px] text-white/40 leading-relaxed">
                Projekt používá jeden překlad a aplikace ho sama nikdy nezmění. AI překlad bývá bez přihlášení dostupný jen u prvních kapitol; zamčený obsah aplikace nezískává.
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={probe} disabled={running || busy}>
                  Ověřit dostupné překlady
                </Button>
                <Button variant="ghost" onClick={verifySession} disabled={busy}>
                  Ověřit přihlášení
                </Button>
              </div>
              {session && (
                <div className="text-xs text-white/70" data-testid="session-state">
                  Stav přihlášení: {session === "signed-in" ? "přihlášeno" : session === "signed-out" ? "nepřihlášeno" : "nelze ověřit"}
                </div>
              )}
              {probes && (
                <div className="space-y-1" data-testid="mode-probes">
                  {probes.map((p) => (
                    <div key={p.mode} className="text-xs text-white/70">
                      <Badge variant={p.state === "available" ? "ok" : p.state === "unknown" ? "muted" : "warn"}>{p.label}: {probeText(p)}</Badge>
                      {p.state !== "available" && <span className="block mt-0.5 text-white/40">{p.message}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <label className="flex items-start gap-2 text-sm text-white/80">
            <input type="checkbox" className="mt-1" checked={!!settings.wifiOnly} disabled={running} onChange={(e) => void save({ wifiOnly: e.target.checked })} />
            <span>
              Stahovat jen přes Wi-Fi
              <span className="block text-[11px] text-white/50">Na mobilních datech stahování počká.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-white/80">
            <input type="checkbox" className="mt-1" checked={!!settings.chargingOnly} disabled={running} onChange={(e) => void save({ chargingOnly: e.target.checked })} />
            <span>
              Stahovat jen při nabíjení
              <span className="block text-[11px] text-white/50">Bez nabíječky stahování počká.</span>
            </span>
          </label>
          {message && <div className="text-xs text-white/60">{message}</div>}
        </div>
      </details>
    </div>
  );
}
