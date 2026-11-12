import { useLocation } from "react-router-dom";
import { LayoutDashboard, PlusCircle, ArrowDownToLine, Library as LibraryIcon, Settings as SettingsIcon } from "lucide-react";

/**
 * Spodní navigace s pěti záložkami.
 *
 * Názvy jsou záměrně KRÁTKÉ (max 9 znaků), aby se všech pět záložek vešlo
 * vedle sebe i na nejužší iPhone (375 px) – pět slotů po ~72 px.
 * Dřívější "Nové stahování" se na 440 px nevešlo a lámalo se do dvou řádků.
 *
 * Ikony jsou kompaktní (size 20) a každá jiná, aby se záložky nepletly:
 * dřív měly "Dashboard" a "Knihovna" obě BookOpen a "Nové"/"Stahování"
 * obě Download – z UI se nedalo poznat, kde jsi.
 */
const tabs = [
  { path: "/", label: "Přehled", icon: LayoutDashboard },
  { path: "/new", label: "Nové", icon: PlusCircle },
  { path: "/downloads", label: "Stahování", icon: ArrowDownToLine },
  { path: "/library", label: "Knihovna", icon: LibraryIcon },
  { path: "/settings", label: "Nastavení", icon: SettingsIcon },
];

export function TabNavigator({ onTab }: { onTab: (to: string) => void }) {
  const location = useLocation();

  return (
    <nav className="tabbar" role="navigation" aria-label="Hlavní navigace">
      <div className="tabbar-inner">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active =
            location.pathname === t.path || (t.path !== "/" && location.pathname.startsWith(t.path));
          return (
            <button
              key={t.path}
              type="button"
              onClick={() => onTab(t.path)}
              data-active={active}
              aria-current={active ? "page" : undefined}
              className="tab"
            >
              <Icon size={20} strokeWidth={active ? 2.4 : 2} />
              <span className="tab-label">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
