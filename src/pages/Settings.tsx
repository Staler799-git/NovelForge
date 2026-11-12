import { useState, useEffect } from "react";
import { Preferences } from "@capacitor/preferences";
import { Card, SectionTitle, Button, Input, Badge } from "@/components/ui";
import { ShieldCheck, Info } from "lucide-react";

const KEY_CONCURRENT = "app_default_concurrent";
const KEY_DELAY = "app_default_delay";
const KEY_RETRIES = "app_default_retries";

export function Settings() {
  const [concurrent, setConcurrent] = useState(3);
  const [delay, setDelay] = useState(1500);
  const [retries, setRetries] = useState(5);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      const c = await Preferences.get({ key: KEY_CONCURRENT });
      const d = await Preferences.get({ key: KEY_DELAY });
      const r = await Preferences.get({ key: KEY_RETRIES });
      if (c.value) setConcurrent(parseInt(c.value, 10) || 3);
      if (d.value) setDelay(parseInt(d.value, 10) || 1500);
      if (r.value) setRetries(parseInt(r.value, 10) || 5);
    };
    load();
  }, []);

  const saveDefaults = async () => {
    setSaving(true);
    try {
      await Preferences.set({ key: KEY_CONCURRENT, value: String(concurrent) });
      await Preferences.set({ key: KEY_DELAY, value: String(delay) });
      await Preferences.set({ key: KEY_RETRIES, value: String(retries) });
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 space-y-5 max-w-[560px] mx-auto">
      <h1 className="text-[28px] font-bold tracking-tight text-white leading-tight">Nastavení</h1>

      <Card>
        <SectionTitle>Výchozí chování stahování</SectionTitle>
        <p className="text-white/50 text-sm mb-4">
          Tyto hodnoty se použijí pro nové projekty. U každého projektu je lze později změnit v jeho detailech.
        </p>
        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-xs text-white/50 mb-1">
              <span>Souběžných požadavků</span>
              <span>{concurrent}</span>
            </div>
            <Input
              type="number"
              value={concurrent}
              onChange={(e) => setConcurrent(Math.max(1, Math.min(10, Number(e.target.value || 1))))}
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-white/50 mb-1">
              <span>Prodleva mezi požadavky (ms)</span>
              <span>{delay}</span>
            </div>
            <Input
              type="number"
              value={delay}
              onChange={(e) => setDelay(Math.max(0, Math.min(10000, Number(e.target.value || 0))))}
            />
          </div>
          <div>
            <div className="flex justify-between text-xs text-white/50 mb-1">
              <span>Max. opakování při chybě</span>
              <span>{retries}</span>
            </div>
            <Input
              type="number"
              value={retries}
              onChange={(e) => setRetries(Math.max(0, Math.min(20, Number(e.target.value || 0))))}
            />
          </div>
          <Button onClick={saveDefaults} disabled={saving}>
            {saving ? "Ukládá se…" : "Uložit výchozí hodnoty"}
          </Button>
        </div>
      </Card>

      <Card>
        <SectionTitle>O aplikaci</SectionTitle>
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5">
            <span className="text-white">NovelForge</span>
            <span className="text-white/50">v{__APP_VERSION__}</span>
          </div>
          <div className="text-xs text-white/50 leading-relaxed">
            Web novely → EPUB. Všechny údaje a knihy jsou uloženy pouze ve vašem zařízení. Nevyžaduje účet, server ani placené API.
            Stahování běží při otevřené aplikaci (iOS omezuje běh na pozadí); stahování je kdykoli možné pozastavit a později obnovit — hotové kapitoly se nestahují znovu.
          </div>
          <Badge variant="muted" className="text-xs">
            IPA sestavit přes Codemagic a nainstalovat přes Signulous
          </Badge>
        </div>
      </Card>

      <div className="flex gap-2">
        <Button variant="ghost" ><ShieldCheck size={16} className="mr-2" /> Zásady ochrany</Button>
        <Button variant="ghost" ><Info size={16} className="mr-2" /> O aplikaci</Button>
      </div>
    </div>
  );
}
