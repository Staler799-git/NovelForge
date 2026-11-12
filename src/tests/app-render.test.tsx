/**
 * Regresní test na bílou obrazovku.
 *
 * Dřívější verze App.tsx volala `useNavigate()` JEŠTĚ PŘED <BrowserRouter>,
 * což v React Router 7 vyhodí:
 *   Error: useNavigate() may be used only in the context of a <Router> component.
 * React při tom odregistruje celý strom a na obrazovce zůstane prázdný <div id="root">.
 *
 * Tento test skutečně renderuje <App />, takže na tuto regresi selže.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Nativní plugin y v testu nahradíme – jde jen o to, že inicializace projde.
vi.mock("@capacitor/splash-screen", () => ({
  SplashScreen: { hide: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@capacitor/status-bar", () => ({
  StatusBar: {
    setBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setStyle: vi.fn().mockResolvedValue(undefined),
  },
  Style: { Dark: "DARK" },
}));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setResizeMode: vi.fn().mockResolvedValue(undefined) },
  KeyboardResize: { Ionic: "ionic" },
}));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
vi.mock("@/services/db", () => ({
  db: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/services/storage", () => ({
  storage: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/store", () => ({
  projectStore: { refresh: vi.fn() },
}));
vi.mock("@/pages/Dashboard", () => ({
  Dashboard: () => <div data-testid="dashboard">Dashboard</div>,
}));
vi.mock("@/pages/NewDownload", () => ({ NewDownload: () => <div>NewDownload</div> }));
vi.mock("@/pages/Downloads", () => ({ Downloads: () => <div>Downloads</div> }));
vi.mock("@/pages/Library", () => ({ Library: () => <div>Library</div> }));
vi.mock("@/pages/Settings", () => ({ Settings: () => <div>Settings</div> }));
vi.mock("@/pages/ProjectDetail", () => ({ ProjectDetail: () => <div>ProjectDetail</div> }));
vi.mock("@/pages/EpubExport", () => ({ EpubExport: () => <div>EpubExport</div> }));
vi.mock("@/layout/TabNavigator", () => ({
  TabNavigator: ({ onTab }: { onTab: (to: string) => void }) => (
    <nav data-testid="tabnav">
      <button onClick={() => onTab("/library")}>Library</button>
    </nav>
  ),
}));

describe("App render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("vyrenderuje obsah, nikoli bílou obrazovku", async () => {
    const { default: App } = await import("@/App");
    const { container } = render(<App />);

    // Klíčové: Dashboard se musí objevit. Kdyby useNavigate() byl mimo Router,
    // render spadne na invariant a tento dotaz nic nenajde.
    await waitFor(() => {
      expect(container.innerHTML).not.toBe("");
    });

    expect(await screen.findByTestId("dashboard")).toBeTruthy();
    expect(await screen.findByTestId("tabnav")).toBeTruthy();
  });

  it("navigace z TabNavigatoru funguje (useNavigate má router kontext)", async () => {
    const { default: App } = await import("@/App");
    render(<App />);

    const libraryButton = await screen.findByText("Library");
    // Kdyby navigate nebyl v router kontextu, kliknutí by vyhodilo.
    expect(() => libraryButton.click()).not.toThrow();
  });
});
