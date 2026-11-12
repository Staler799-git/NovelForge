import { useEffect, useState } from "react";
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

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        await SplashScreen.hide?.();
        await StatusBar.setBackgroundColor({ color: "#0a0a0b" });
        await StatusBar.setStyle({ style: Style.Dark });
        await Keyboard.setResizeMode({ mode: KeyboardResize.Ionic });
        await storage.init();
        await db.init();
        if (mounted) setReady(true);
      } catch (err) {
        console.error("Init failed", err);
        if (mounted) setReady(true);
      }
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
      listener = await CapApp.addListener("appStateChange", () => {
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
      <TabNavigator onTab={(to) => navigate(to)} />
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/new" element={<NewDownload />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/library" element={<Library />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/project/:id" element={<ProjectDetail />} />
        <Route path="/project/:id/export" element={<EpubExport />} />
      </Routes>
    </div>
  );
}
