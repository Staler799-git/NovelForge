// @vitest-environment node
/**
 * Test produkčního CSS.
 *
 * Chrání před chybou, kvůli které se aplikace na iPhonu zobrazila jako
 * nestylovaná HTML stránka (bílé pozadí, patkové písmo, navigace nahoře):
 * Tailwind nebyl zpracován a do CSS prošly surové direktivy.
 *
 * CSS se kompiluje přímo zde přes Vite pipeline (postcss.config.js +
 * tailwind.config.js), takže test nezávisí na existenci dist/.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileProductionCss, rule } from "./helpers/productionCss";

describe("Produkční CSS (Tailwind přes PostCSS)", () => {
  let css = "";

  beforeAll(async () => {
    css = await compileProductionCss();
  }, 60_000);

  it("postcss.config.js existuje a zapíná tailwindcss + autoprefixer", () => {
    const file = join(process.cwd(), "postcss.config.js");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/tailwindcss/);
    expect(src).toMatch(/autoprefixer/);
  });

  it("Tailwind byl skutečně zpracován (žádné surové direktivy)", () => {
    expect(css.length).toBeGreaterThan(10_000);
    expect(css).not.toMatch(/@tailwind\s+(base|components|utilities)/);
    expect(css).not.toMatch(/@apply\s/);
    expect(css).not.toMatch(/@layer\s+(base|components|utilities)/);
  });

  it("tmavé pozadí #0a0a0b na html, body i #root", () => {
    expect(rule(css, "html")).toMatch(/background-color:\s*#0a0a0b/i);
    expect(rule(css, "body")).toMatch(/background-color:\s*rgb\(\s*10\s+10\s+11/);
    expect(rule(css, "#root")).toMatch(/background-color:\s*#0a0a0b/i);
    expect(rule(css, ".bg-dark-900")).toMatch(/rgb\(\s*10\s+10\s+11/);
  });

  it("světlý text a systémové bezpatkové písmo", () => {
    expect(rule(css, "body")).toMatch(/color:\s*rgb\(\s*255\s+255\s+255/);
    expect(css).toMatch(/font-family:\s*-apple-system/);
    expect(css).not.toMatch(/font-family:\s*(serif|Times)/i);
  });

  it("spodní navigace: fixně dole, v jednom řádku, se safe-area", () => {
    const tabbar = rule(css, ".tabbar");
    expect(tabbar).toMatch(/position:\s*fixed/);
    expect(tabbar).toMatch(/bottom:\s*0/);
    expect(tabbar).not.toMatch(/(^|;)\s*top:/);
    expect(tabbar).toMatch(/safe-area-inset-bottom/);
    expect(rule(css, ".tabbar-inner")).toMatch(/display:\s*flex/);
    expect(rule(css, ".tab")).toMatch(/flex:\s*1 1 0/);
    expect(rule(css, ".tab-label")).toMatch(/white-space:\s*nowrap/);
    // aktivní záložka je růžová
    expect(css).toMatch(/\.tab\[data-active=["']?true["']?\]\s*\{[^}]*#f472b6/i);
  });

  it("obsah je odsazen od Dynamic Islandu a od navigace", () => {
    const scroll = rule(css, ".app-scroll");
    expect(scroll).toMatch(/padding-top:[^;]*safe-area-inset-top/);
    expect(scroll).toMatch(/padding-bottom:[^;]*safe-area-inset-bottom/);
  });

  it("hlavní UI prvky: karta, tlačítka, formulářové pole, nadpis sekce", () => {
    const card = rule(css, ".card");
    expect(card).toMatch(/border-radius:\s*1\.5rem/);
    expect(card).toMatch(/background-color:\s*rgb\(\s*20\s+20\s+23/);

    // Komponenta <Button> (src/components/ui.tsx): růžovo-fialový gradient,
    // zaoblení, vnitřní odsazení a dotyková plocha min. 44 px.
    expect(rule(css, ".bg-gradient-to-br")).toMatch(/background-image:\s*linear-gradient/);
    expect(rule(css, ".from-pink-500")).toMatch(/#ec4899/i);
    expect(rule(css, ".via-purple-600")).toMatch(/#9333ea/i);
    expect(rule(css, ".rounded-xl")).toMatch(/border-radius:\s*1rem/);
    expect(rule(css, ".px-4")).toMatch(/padding-left:\s*1rem/);
    expect(rule(css, ".min-h-\\[44px\\]")).toMatch(/min-height:\s*44px/);

    // Komponenta <Input>
    expect(rule(css, ".w-full")).toMatch(/width:\s*100%/);
    expect(rule(css, ".py-3")).toMatch(/padding-top:\s*0\.75rem/);
    expect(rule(css, ".border-white\\/10")).toMatch(/border-color:\s*rgb\(\s*255\s+255\s+255\s*\/\s*0?\.1\)/);

    expect(rule(css, ".section-title")).toMatch(/font-weight:\s*600/);
  });

  it("utility třídy použité v komponentách se vygenerovaly", () => {
    for (const cls of [".flex", ".grid", ".min-h-screen", ".text-white", ".rounded-2xl", ".rounded-full"]) {
      expect(rule(css, cls), `chybí ${cls}`).not.toBe("");
    }
  });

  it("index.html: viewport-fit=cover a tmavý inline fallback", () => {
    const html = readFileSync(join(process.cwd(), "index.html"), "utf8");
    // bez viewport-fit=cover vrací env(safe-area-inset-*) ve WKWebView vždy 0
    expect(html).toMatch(/viewport-fit=cover/);
    // i kdyby se externí CSS nenačetlo, nesmí být obrazovka bílá s patkovým písmem
    expect(html).toMatch(/<style[^>]*>[\s\S]*background(-color)?:\s*#0a0a0b[\s\S]*<\/style>/i);
    expect(html).toMatch(/<style[^>]*>[\s\S]*-apple-system[\s\S]*<\/style>/i);
  });
});
