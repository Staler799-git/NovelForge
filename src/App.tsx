import { useEffect, useState } from "react";
import { diag } from "@/services/diag";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { SplashScreen } from "@capacitor/splash-screen";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { App as CapApp } from "@capacitor/app";
import { db } from "./services/db";
import { storage } from "./services/storage";
import { Dashboard } from "./pages/Dashboard";
import { NewDownload } from "./pages/NewDownload";
import { Downloads } from "./pages/Downloads";
import { Library } from "./pages/Library";
import { Settings } from "./pages/Settings";
import { ProjectDetail } from "./pages/ProjectDetail";
import { EpubExport } from "./pages/EpubExport";
import { TabNavigator } from "./layout/TabNavigator";
import { projectStore } from "./store";
import { downloadManager } from "./services/downloader";

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      // Každý krok zvlášť: selhání kosmetického volání (např.
      // StatusBar.setBackgroundColor na iOS neexistuje) nesmí přeskočit
      // inicializaci úložiště a databáze.
      const step = async (name: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (err) {
          console.warn(`Init: ${name} selhalo`, err);
        }
      };
      await step("storage", () => storage.init());
      // Diagnostika: vyhodnotí, zda minulé spuštění neskončilo nečekaně, a zahájí nový záznam.
      await step("diagnostics", async () => { await diag.startSession(); });
      await step("db", () => db.init());
      // Stahování přerušená ukončením aplikace se nabídnou k pokračování.
      await step("recover", () => downloadManager.recoverInterrupted());
      await step("statusbar-style", () => StatusBar.setStyle({ style: Style.Dark }));
      await step("statusbar-color", () => StatusBar.setBackgroundColor({ color: "#0a0a0b" }));
      await step("keyboard", () => Keyboard.setResizeMode({ mode: KeyboardResize.Ionic }));
      await step("splash", async () => SplashScreen.hide?.());
      if (mounted) setReady(true);
    };
    init();
    return () => {
      mounted = false;
    };
  }, []);

  // Všechny hooky musí být volány bezpodmínečně, před jakýmkoli return.
  // `useNavigate` navíc vyžaduje, aby komponenta byla UVNITŘ <Router> – proto
  // je navigace řešena v oddělené komponentě <AppShell>, která se renderuje
  // až jako potomek <BrowserRouter>. Dřívější varianta volala useNavigate()
  // ještě před <BrowserRouter> a shazovala celou aplikaci bílou obrazovkou:
  //   Error: useNavigate() may be used only in the context of a <Router>

  const store = projectStore;

  useEffect(() => {
    let listener: any;
    (async () => {
      listener = await CapApp.addListener("appStateChange", (state) => {
        // iOS smí aplikaci na pozadí ukončit – v logu se to odliší od pádu.
        diag.log(state?.isActive ? "app-foreground" : "app-background");
        // Správce stahování na pozadí nezačíná nové kapitoly a po návratu pokračuje sám.
        downloadManager.setAppActive(!!state?.isActive);
        store.refresh();
      });
    })();
    return () => {
      listener?.remove?.();
    };
  }, [store]);

  if (!ready) return null;

  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}

/**
 * Vnitřek aplikace – renderuje se až pod <BrowserRouter>, takže `useNavigate`
 * má k dispozici router kontext.
 */
function AppShell() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-dark-900 text-white">
      {/*
        app-scroll zajistí:
          - padding-top = safe-area-inset-top (Dynamic Island / notch)
          - padding-bottom = výška lišty + safe-area-inset-bottom (Home Indicator)
        Bez toho poslední karty mizely pod spodní navigací a nadpisy zajížděly
        pod Dynamic Island.
      */}
      <main className="app-scroll">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/new" element={<NewDownload />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/library" element={<Library />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/project/:id" element={<ProjectDetail />} />
          <Route path="/project/:id/export" element={<EpubExport />} />
        </Routes>
      </main>
      <TabNavigator onTab={(to) => navigate(to)} />
    </div>
  );
}
