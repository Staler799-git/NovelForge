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

  if (!ready) return null;

  const navigate = useNavigate();
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

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-dark-900 text-white">
        <TabNavigator onTab={navigate} />
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
    </BrowserRouter>
  );
}
