/**
 * Vizuální smoke test pro mobilní viewport (iPhone 16 Pro Max: 440×956).
 *
 * Ověřuje, že se UI skutečně VYKRESLÍ se správnými vlastnostmi – ne jen že
 * React nespadne. Chrání před regresí, kdy chybí Tailwind a aplikace je
 * "funkční", ale bez stylů: bílé pozadí, patkové písmo, navigace nahoře.
 *
 * Pozadí a písmo se ověřují z reálného produkčního CSS (dist/assets/*.css),
 * rozvržení z DOM stromu. CSS se kompiluje přímo v testu (Vite + PostCSS +
 * Tailwind), takže test funguje i bez předchozího `npm run build`.
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { compileProductionCss, rule } from "./helpers/productionCss";

// ---------- nativní pluginy ----------
vi.mock("@capacitor/splash-screen", () => ({ SplashScreen: { hide: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setBackgroundColor: vi.fn().mockResolvedValue(undefined), setStyle: vi.fn().mockResolvedValue(undefined) },
  Style: { Dark: "DARK" },
}));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { setResizeMode: vi.fn().mockResolvedValue(undefined) },
  KeyboardResize: { Ionic: "ionic" },
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) } }));
vi.mock("@/services/db", () => ({ db: { init: vi.fn().mockResolvedValue(undefined), getProjects: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/services/storage", () => ({ storage: { init: vi.fn().mockResolvedValue(undefined) } }));
vi.mock("@/store", () => ({
  projectStore: { refresh: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));

describe("Vizuální smoke test – mobilní viewport", () => {
  let css = "";

  beforeAll(async () => {
    // simulace iPhone 16 Pro Max
    Object.defineProperty(window, "innerWidth", { value: 440, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 956, writable: true, configurable: true });
    css = await compileProductionCss();
  }, 60_000);

  it("produkční CSS existuje a obsahuje Tailwind", () => {
    expect(css.length).toBeGreaterThan(5_000);
    expect(css).not.toMatch(/@tailwind\s+(base|components|utilities)/);
  });

  it("pozadí je tmavé #0a0a0b, nikoli bílé", () => {
    const body = rule(css, "body");
    // Tailwind zapisuje rgb(10 10 11 / var(--tw-bg-opacity, 1))
    expect(body).toMatch(/background-color:\s*rgb\(\s*10\s+10\s+11/);
    expect(body).not.toMatch(/background-color:\s*(#fff|white)/i);
  });

  it("typografie je systémové bezpatkové písmo, nikoli patkové", () => {
    expect(css).toMatch(/-apple-system/);
    // bez Tailwindu by prohlížeč použil výchozí serif (Times)
    expect(css).not.toMatch(/font-family:\s*(serif|Times)/i);
  });

  it("spodní navigace je fixovaná dole, nikoli nahoře", async () => {
    const { default: App } = await import("@/App");
    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
    const nav = container.querySelector("nav")!;

    // .tabbar je definovaná v index.css jako position:fixed; bottom:0
    expect(nav.className).toContain("tabbar");
    expect(nav.className).not.toContain("top-0");
    // a v produkčním CSS musí být skutečně bottom:0
    const tabbar = rule(css, ".tabbar");
    expect(tabbar).toMatch(/position:\s*fixed/);
    expect(tabbar).toMatch(/bottom:\s*0/);
  });

  it("všech 5 záložek se vejde vedle sebe", async () => {
    const { default: App } = await import("@/App");
    render(<App />);

    await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
    const nav = screen.getByRole("navigation");
    const buttons = nav.querySelectorAll("button");

    expect(buttons.length).toBe(5);
    const labels = [...buttons].map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Dashboard", "Nové", "Stahování", "Knihovna", "Nastavení"]);
  });

  it("každá záložka má ikonu i krátký popisek", async () => {
    const { default: App } = await import("@/App");
    render(<App />);

    await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
    for (const button of screen.getByRole("navigation").querySelectorAll("button")) {
      expect(button.querySelector("svg")).toBeTruthy(); // ikona
      const label = button.querySelector("span");
      expect(label?.textContent?.length ?? 99).toBeLessThanOrEqual(10); // krátký název
    }
  });

  it("hlavní obsah má tmavé pozadí a spodní odsazení pro navigaci", async () => {
    const { default: App } = await import("@/App");
    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.className).toMatch(/bg-dark-900/);

    // app-scroll je na <main>, který obaluje Routes
    const main = container.querySelector("main")!;
    expect(main).toBeTruthy();
    // bez paddingu by poslední karty zmizely pod spodní navigací
    expect(main.className).toContain("app-scroll");
    const scroll = rule(css, ".app-scroll");
    expect(scroll).toMatch(/padding-bottom/);
    expect(scroll).toMatch(/safe-area-inset-bottom/);
  });

  it("CSS definuje safe-area pro Dynamic Island a Home Indicator", () => {
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/safe-area-inset-top/);
  });
});
