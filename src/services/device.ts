/**
 * Stav zařízení a nativní služby (jen iOS): síť, nabíjení, krátký běh na pozadí
 * a webové okno pro přihlášení / bezpečnostní ověření.
 *
 * V prohlížeči a v testech nativní modul chybí – funkce pak vrací „neznámý“
 * stav a nic neblokují.
 */
import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { diag, redactUrl } from "./diag";

function native(): any | undefined {
  const plugins = (Capacitor as any).Plugins as Record<string, any> | undefined;
  return plugins?.["WebRenderer"];
}

export interface DeviceState {
  /** true/false, nebo null když to nejde zjistit. */
  wifi: boolean | null;
  online: boolean | null;
  charging: boolean | null;
}

export async function deviceState(): Promise<DeviceState> {
  const out: DeviceState = { wifi: null, online: null, charging: null };
  try {
    const s = await Network.getStatus();
    out.online = !!s.connected;
    out.wifi = s.connectionType === "wifi" ? true : s.connectionType === "unknown" ? null : false;
  } catch {
    /* modul sítě není k dispozici */
  }
  try {
    const p = native();
    if (p?.deviceState) {
      const d = await p.deviceState();
      if (typeof d?.charging === "boolean") out.charging = d.charging;
    }
  } catch {
    /* nativní modul není k dispozici */
  }
  return out;
}

/**
 * Vrátí důvod, proč se právě teď nemá stahovat (podmínky projektu), nebo null.
 * Když stav nejde zjistit, podmínka se považuje za splněnou – ale zapíše se to.
 */
export async function unmetCondition(settings: { wifiOnly?: boolean; chargingOnly?: boolean } | undefined): Promise<string | null> {
  if (!settings?.wifiOnly && !settings?.chargingOnly) return null;
  const d = await deviceState();
  if (settings.wifiOnly && d.wifi === false) return d.online === false ? "Zařízení je bez připojení (stahování jen přes Wi-Fi)" : "Zařízení není na Wi-Fi (stahování jen přes Wi-Fi)";
  if (settings.chargingOnly && d.charging === false) return "Zařízení se nenabíjí (stahování jen při nabíjení)";
  return null;
}

/**
 * Požádá iOS o krátký čas na pozadí (beginBackgroundTask, typicky kolem 30 s)
 * na dokončení rozpracované kapitoly. Není to trvalý běh na pozadí.
 */
export async function beginBackgroundWork(): Promise<boolean> {
  try {
    const p = native();
    if (!p?.beginBackgroundWork) return false;
    const r = await p.beginBackgroundWork();
    diag.log("background-begin", { granted: !!r?.granted, remainingSec: typeof r?.remaining === "number" ? Math.round(r.remaining) : undefined });
    return !!r?.granted;
  } catch {
    return false;
  }
}

export async function endBackgroundWork(): Promise<void> {
  try {
    await native()?.endBackgroundWork?.();
  } catch {
    /* nic */
  }
}

export function canOpenAuthBrowser(): boolean {
  return !!native()?.openAuthPage;
}

/**
 * Otevře stránku v okně uvnitř aplikace, kde se uživatel SÁM přihlásí nebo
 * provede bezpečnostní ověření. Po zavření se cookies daného webu předají
 * síťové vrstvě aplikace (zůstávají jen v úložišti cookies systému iOS –
 * aplikace je nečte, neukládá do databáze ani nevypisuje do logů).
 * Vrací false, když okno není k dispozici (prohlížeč, starší build).
 */
export async function openAuthBrowser(url: string): Promise<{ opened: boolean; synced: number }> {
  const p = native();
  if (!p?.openAuthPage) return { opened: false, synced: 0 };
  const end = diag.begin("auth-browser", { url: redactUrl(url) });
  try {
    const r = await p.openAuthPage({ url });
    const synced = typeof r?.synced === "number" ? r.synced : 0;
    end({ ok: true, synced });
    return { opened: true, synced };
  } catch (err) {
    end({ ok: false, error: (err as Error)?.message ?? "chyba" });
    throw err;
  }
}

/** Otevře adresu v systémovém prohlížeči (Safari). Relace ze Safari se do aplikace NEpřenáší. */
export function openExternal(url: string): void {
  try {
    window.open(url, "_system");
  } catch {
    /* nic */
  }
}
