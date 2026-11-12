/**
 * Autonomní kontrola produkčního CSS.
 *
 * Chráněné regrese:
 *  1. Chybějící postcss.config.js -> Vite Tailwind nezpracuje a do dist se
 *     zkopírují SUROVÉ `@tailwind` a `@apply` direktivy (1053 B místo ~18 kB).
 *     Prohlížeč je ignoruje -> bílé pozadí, patkové písmo, rozhozený layout.
 *  2. Neplatné Tailwind třídy jako `bg-white/4`, `bg-white/3`, `bg-white/6`
 *     (Tailwind 3 zná jen 0,5,10,...,100) -> `@apply` vyhodí chybu buildu,
 *     nebo se třída tiše zahodí.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const ASSETS = join(DIST, "assets");

let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  \u001b[32m✔\u001b[0m ${label}`);
  } else {
    console.log(`  \u001b[31m✘ ${label}\u001b[0m${detail ? `\n     ${detail}` : ""}`);
    failed++;
  }
}

console.log("\n\u001b[1mKontrola produkčního CSS\u001b[0m");

// 1) Vite vytvořil CSS soubor
const cssFiles = existsSync(ASSETS) ? readdirSync(ASSETS).filter((f) => f.endsWith(".css")) : [];
check("Vite vytvořil CSS soubor", cssFiles.length > 0, `v ${ASSETS} není žádné .css`);

if (cssFiles.length === 0) {
  console.log("\n\u001b[31mCSS chybí – build nesmí projít.\u001b[0m\n");
  process.exit(1);
}

const css = cssFiles.map((f) => readFileSync(join(ASSETS, f), "utf8")).join("\n");

// 2) CSS není prázdné
check("CSS není prázdné", css.length > 5_000, `velikost ${css.length} B (< 5 kB = Tailwind neproběhl)`);

// 3) Nezůstaly surové Tailwind direktivy
check(
  "CSS neobsahuje surové @tailwind/@apply",
  !/@tailwind\s+(base|components|utilities)/.test(css) && !/@apply\s/.test(css),
  "Tailwind neproběhl – chybí postcss.config.js?",
);

// 4) Očekávané Tailwind utility / vlastní vrstvy
const expected = [
  ["tmavé pozadí #0a0a0b (bg-dark-900)", /rgb\(\s*10\s+10\s+11/],
  ["systémové písmo (-apple-system)", /-apple-system/],
  [".card (komponenta)", /\.card\s*\{/],
  [".tabbar (spodní navigace fixně dole)", /\.tabbar\s*\{[^}]*position:\s*fixed/],
  [".tabbar bottom:0", /\.tabbar\s*\{[^}]*bottom:\s*0/],
  ["utility .flex", /\.flex\s*\{/],
  ["backdrop-blur (sklo navigace)", /backdrop-filter/],
  ["iOS safe-area (Home Indicator)", /safe-area-inset-bottom/],
  ["iOS safe-area (Dynamic Island)", /safe-area-inset-top/],
];
for (const [label, re] of expected) check(label, re.test(css));

// 5) dist/index.html odkazuje na CSS i JS
const indexPath = join(DIST, "index.html");
check("dist/index.html existuje", existsSync(indexPath));
const html = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
check("index.html odkazuje na CSS", /<link[^>]+rel="stylesheet"[^>]+href="[^"]+\.css"/.test(html));
check("index.html odkazuje na JS", /<script[^>]+src="[^"]+\.js"/.test(html));

// 6) CSS je zkopírováno do iOS aplikace
const iosPublic = "ios/App/App/public";
if (existsSync(iosPublic)) {
  const iosCss = existsSync(join(iosPublic, "assets"))
    ? readdirSync(join(iosPublic, "assets")).filter((f) => f.endsWith(".css"))
    : [];
  check("CSS zkopírováno do iOS (ios/App/App/public/assets)", iosCss.length > 0);
} else {
  console.log("  \u001b[33m•\u001b[0m ios/App/App/public zatím neexistuje (npx cap sync ios) – přeskakuji");
}

// 7) Sanity: nesmí existovat neplatné opacity třídy ve zdrojích
import("node:fs").then(({ readdirSync: rd }) => {
  const walk = (dir) =>
    rd(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".tsx") || e.name.endsWith(".css") ? [join(dir, e.name)] : [],
    );
  const bad = [];
  const valid = new Set([5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]);
  for (const file of walk("src")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:bg|text|border|ring)-(?:white|black)\/(\d+)\b/g)) {
      if (!valid.has(Number(m[1]))) bad.push(`${file}: ${m[0]}`);
    }
  }
  check("žádné neplatné Tailwind opacity (bg-white/4 …)", bad.length === 0, bad.join("\n     "));

  console.log(
    failed === 0
      ? `\n\u001b[32m✔ Produkční CSS je v pořádku (${cssFiles.join(", ")}, ${(css.length / 1024).toFixed(1)} kB)\u001b[0m\n`
      : `\n\u001b[31m✘ ${failed} kontrola(y) selhaly – build by měl skončit chybou.\u001b[0m\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
});
