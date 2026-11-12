import { useLocation } from "react-router-dom";
import { BookOpen, Download, Settings as SettingsIcon } from "lucide-react";

const tabs = [
  { path: "/", label: "Dashboard", icon: BookOpen },
  { path: "/new", label: "Nové stahování", icon: Download },
  { path: "/downloads", label: "Stahování", icon: Download },
  { path: "/library", label: "Knihovna", icon: BookOpen },
  { path: "/settings", label: "Nastavení", icon: SettingsIcon },
];

export function TabNavigator({ onTab }: { onTab: (to: string) => void }) {
  const location = useLocation();
  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-dark-800/95 backdrop-blur border-t border-white/5 z-50">
      <div className="flex items-center justify-around px-2 py-3">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = location.pathname === t.path || (t.path !== "/" && location.pathname.startsWith(t.path));
          return (
            <button
              key={t.path}
              onClick={() => onTab(t.path)}
              className="flex flex-col items-center gap-1 w-20 min-w-[70px] p-2 rounded-2xl transition-all"
              style={{
                background: active ? "rgba(236, 72, 153, 0.15)" : "transparent",
                color: active ? "#f472b6" : "#a1a1aa",
              }}
            >
              <Icon size={22} className={active ? "text-pink-400" : "text-white/50"} />
              <span className="text-[11px] font-medium">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
