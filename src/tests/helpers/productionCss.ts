/**
 * Zkompiluje src/index.css STEJNOU cestou jako `vite build`:
 * Vite si sám najde postcss.config.js -> tailwindcss -> autoprefixer.
 *
 * Záměrně NEČTE dist/. Dřívější verze testů četla dist/assets/*.css, jenže
 * Codemagic spouští `npm test` PŘED `npm run build` na čistém checkoutu, kde
 * dist/ neexistuje -> testy spadly a iOS build se vůbec nedostal k IPA.
 *
 * Když postcss.config.js chybí nebo Tailwind neproběhne, vrátí se surové
 * `@tailwind` direktivy a testy to odhalí.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { preprocessCSS, resolveConfig } from "vite";

let cached: Promise<string> | undefined;

export function compileProductionCss(): Promise<string> {
  cached ??= (async () => {
    const root = process.cwd();
    const file = join(root, "src", "index.css");
    const config = await resolveConfig({ root, logLevel: "silent" }, "build", "production", "production");
    const result = await preprocessCSS(readFileSync(file, "utf8"), file, config);
    return result.code;
  })();
  return cached;
}

/** Vrátí spojené deklarace všech pravidel s přesně tímto selektorem. */
export function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[},\\s])${esc}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].map((m) => m[1]).join(";");
}
