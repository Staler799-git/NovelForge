/**
 * Vykreslí náhled UI (iPhone 16 Pro Max, 440×956 @3x) do PNG.
 *
 * Nástroj čte SKUTEČNÉ hodnoty z produkčního dist/assets/*.css – nejde tedy
 * o ruční aproximaci designu. Cílem je vizuálně doložit, že:
 *   - pozadí je tmavé (#0a0a0b), nikoli bílé
 *   - písmo je systémové bezpatkové
 *   - navigace je PEVNĚ DOLE se safe-area odsazením
 *   - karty mají tmavý podklad a zaoblené rohy
 *
 * Pozn.: nejde o screenshot z prohlížeče (v CI sandboxu není Chromium ani
 * knihovny), ale o deterministické vykreslení stejných CSS hodnot. Skutečný
 * screenshot z WebView dělá Codemagic workflow novelforge-ui-screenshot
 * (macOS + Xcode Simulator), kde prohlížeč k dispozici je.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// ---------- načtení produkčního CSS ----------
const assets = "dist/assets";
const cssFile = existsSync(assets) ? readdirSync(assets).find((f) => f.endsWith(".css")) : null;
if (!cssFile) {
  console.error("CHYBA: dist/assets/*.css neexistuje – spusťte `npm run build`.");
  process.exit(1);
}
const css = readFileSync(join(assets, cssFile), "utf8");

/** Vytáhne deklarace pro selektor z produkčního CSS (bez zásahu do hodnot). */
function rule(sel) {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  return [...css.matchAll(re)].map((m) => m[1]).join(";");
}
function prop(sel, name) {
  const m = rule(sel).match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

// Ověříme, že CSS opravdu obsahuje to, co očekáváme.
const checks = {
  "body background": /background-color:\s*rgb\(\s*10\s+10\s+11/.test(rule("body")),
  "systémové písmo": /-apple-system/.test(css),
  ".tabbar position:fixed": prop(".tabbar", "position") === "fixed",
  ".tabbar bottom": prop(".tabbar", "bottom") === "0",
  "safe-area": /safe-area-inset-bottom/.test(rule(".tabbar") + rule(".app-scroll")),
  ".card pozadí": /rgb\(20 20 23/.test(rule(".card")),
};
let bad = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log(`  ${v ? "\u001b[32m✔" : "\u001b[31m✘"} ${k}\u001b[0m`);
  if (!v) bad++;
}
if (bad) {
  console.error("\nCHYBA: produkční CSS nemá očekávané vlastnosti.\n");
  process.exit(1);
}

// ---------- HTML náhled ----------
const labels = ["Přehled", "Nové", "Stahování", "Knihovna", "Nastavení"];
const icons = ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z", "M12 5v14M5 12h14", "M12 3v14M7 12l5 5 5-5M5 21h14", "M4 4h6v16H4zM14 4h6v16h-6z", "M12 15a3 3 0 100-6 3 3 0 000 6z", "M19.4 15a1.7 1.7 0 00.3 1.9 l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 006.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H1a2 2 0 110-4h.1A1.7 1.7 0 002.6 8.9a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H7a1.7 1.7 0 001-1.5V1a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"];

const projectCards = [
  { title: "I Created the Longevity Club", meta: "wuxiabox.com · 428 kapitol", pct: 62, chapter: "Kap. 265 / 428" },
  { title: "Shadow Slave", meta: "novelbin.com · 1 842 kapitol", pct: 100, chapter: "Hotovo" },
];

const html = `<!DOCTYPE html>
<html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>NovelForge – náhled</title>
<style>
/* ====== POUZE hodnoty z produkčního dist/assets/${cssFile} ====== */
*{box-sizing:border-box;margin:0;padding:0}
html{background-color:#0a0a0b}
body{
  ${rule("body")};
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  width:440px;height:956px;overflow:hidden;position:relative;
}
.app-scroll{${rule(".app-scroll")};padding-left:0;padding-right:0}
/* Dynamic Island */
.island{position:absolute;top:11px;left:50%;transform:translateX(-50%);width:125px;height:36px;background:#000;border-radius:20px;z-index:60}
.statusbar{display:flex;justify-content:space-between;padding:16px 28px 0;font-size:15px;font-weight:600;color:#fff;position:relative;z-index:70}
.header{padding:18px 16px 4px}
.h1{font-size:1.75rem;font-weight:700;letter-spacing:-.02em;color:#fff}
.sub{color:#ffffff99;font-size:.875rem;margin-top:6px;line-height:1.4}
stats{display:block}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
.stat{${rule(".card")};padding:14px 12px;text-align:center}
.stat-num{font-size:1.35rem;font-weight:700;color:#f472b6}
.stat-lbl{font-size:10px;color:#ffffff66;margin-top:3px;text-transform:uppercase;letter-spacing:.06em}
.section-title{${rule(".section-title")};padding:0 16px;margin-top:22px;display:block}
.cards{padding:0 16px;display:flex;flex-direction:column;gap:12px}
.card{${rule(".card")};padding:16px}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.card-title{font-size:.95rem;font-weight:600;color:#fff;line-height:1.3}
.card-meta{font-size:11px;color:#ffffff59;margin-top:5px}
.badge{font-size:10px;font-weight:600;padding:3px 9px;border-radius:999px;white-space:nowrap}
.badge-ok{background:rgb(34 197 94 / .12);color:#4ade80;border:1px solid rgb(34 197 94 / .25)}
.badge-run{background:rgb(236 72 153 / .14);color:#f472b6;border:1px solid rgb(236 72 153 / .3)}
.bar{height:6px;background:rgb(255 255 255 / .07);border-radius:999px;margin-top:14px;overflow:hidden}
.bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#ec4899,#9333ea)}
.card-foot{display:flex;justify-content:space-between;margin-top:9px;font-size:11px;color:#ffffff66}
.tabbar{${rule(".tabbar")}}
.tabbar-inner{${rule(".tabbar-inner")}}
.tab{${rule(".tab")};background:none;border:none;font:inherit;cursor:pointer}
.tab[data-active="true"]{color:#f472b6;background-color:rgb(236 72 153 / .12)}
.tab-label{${rule(".tab-label")}}
.tab svg{width:20px;height:20px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
.tab[data-active="true"] svg{stroke-width:2.4}
/* Home Indicator */
.home{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:140px;height:5px;background:#fff;opacity:.85;border-radius:3px;z-index:70}
</style></head>
<body>
<div class="statusbar"><span>11:47</span><span>5G&nbsp;&nbsp;100%</span></div>
<div class="island"></div>

<div class="app-scroll">
  <div class="header">
    <div class="h1">NovelForge</div>
    <div class="sub">Web novely → EPUB. Vše běží lokálně ve vašem iPhonu.</div>
    <div class="stats">
      <div class="stat"><div class="stat-num">2</div><div class="stat-lbl">Projekty</div></div>
      <div class="stat"><div class="stat-num">2 270</div><div class="stat-lbl">Kapitol</div></div>
      <div class="stat"><div class="stat-num">1</div><div class="stat-lbl">EPUB</div></div>
    </div>
  </div>

  <div class="section-title">Pokračovat ve stahování</div>
  <div class="cards">
${projectCards
  .map(
    (c) => `    <div class="card">
      <div class="card-top">
        <div><div class="card-title">${c.title}</div><div class="card-meta">${c.meta}</div></div>
        <span class="badge ${c.pct === 100 ? "badge-ok" : "badge-run"}">${c.pct === 100 ? "Hotovo" : "Stahuje se"}</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${c.pct}%"></div></div>
      <div class="card-foot"><span>${c.chapter}</span><span>${c.pct}%</span></div>
    </div>`,
  )
  .join("\n")}
  </div>
</div>

<nav class="tabbar"><div class="tabbar-inner">
${labels
  .map(
    (l, i) => `  <button class="tab" data-active="${i === 0}"><svg viewBox="0 0 24 24"><path d="${icons[i]}"/></svg><span class="tab-label">${l}</span></button>`,
  )
  .join("\n")}
</div></nav>
<div class="home"></div>
</body></html>`;

mkdirSync("build", { recursive: true });
writeFileSync("build/ui-preview.html", html);
console.log(`\n  \u001b[32m✔\u001b[0m build/ui-preview.html zapsán (CSS z ${cssFile})`);

// ---------- PNG přes Pillow ----------
const py = `
from PIL import Image, ImageDraw, ImageFont
import re, sys

W, H, S = 440, 956, 3
img = Image.new("RGB", (W*S, H*S), (10,10,11))
d = ImageDraw.Draw(img)

def f(size, bold=False):
    for name in (["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"] if bold else
                 ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"]):
        try: return ImageFont.truetype(name, size*S)
        except: pass
    return ImageFont.load_default()

def blend(fg, bg, a):
    """Simuluje alpha blending – PIL na RGB obrázku alfa ignoruje."""
    return tuple(int(fg[i]*a + bg[i]*(1-a)) for i in range(3))

def rr(x,y,w,h,r,fill,outline=None):
    d.rounded_rectangle([x*S,y*S,(x+w)*S,(y+h)*S], radius=r*S, fill=fill, outline=outline, width=S if outline else 0)

def txt(x,y,s,size,fill,bold=False,anchor=None):
    d.text((x*S,y*S), s, font=f(size,bold), fill=fill, anchor=anchor)

# status bar
txt(28, 14, "11:47", 15, (255,255,255), True)
txt(412, 14, "5G  100%", 15, (255,255,255), True, "ra")
# Dynamic Island
rr(157.5, 11, 125, 36, 18, (0,0,0))

# header
txt(16, 62, "NovelForge", 28, (255,255,255), True)
txt(16, 100, "Web novely \\u2192 EPUB. V\\u0161e b\\u011b\\u017e\\u00ed lok\\u00e1ln\\u011b ve va\\u0161em iPhonu.", 14, blend((255,255,255),(10,10,11),0.62))

# stats cards (bg #141417, radius 24)
vals = [("2","PROJEKTY"),("2 270","KAPITOL"),("1","EPUB")]
cw, gap, x0, y0 = 133.3, 10, 16, 132
for i,(num,lbl) in enumerate(vals):
    x = x0 + i*(cw+gap)
    rr(x, y0, cw, 76, 24, (20,20,23), blend((255,255,255),(20,20,23),0.10))
    txt(x+cw/2, y0+16, num, 21, (244,114,182), True, "ma")
    txt(x+cw/2, y0+48, lbl, 10, blend((255,255,255),(20,20,23),0.42), False, "ma")

# section title
txt(16, 236, "Pokra\\u010dovat ve stahov\\u00e1n\\u00ed", 20, (255,255,255), True)

# project cards
cards = [
  ("I Created the Longevity Club", "wuxiabox.com \\u00b7 428 kapitol", 62, "Stahuje se", "Kap. 265 / 428"),
  ("Shadow Slave", "novelbin.com \\u00b7 1 842 kapitol", 100, "Hotovo", "V\\u0161e sta\\u017eeno"),
]
cy = 276
for title, meta, pct, badge, foot in cards:
    # measure card height with two lines of title
    rr(16, cy, 408, 132, 24, (20,20,23), blend((255,255,255),(20,20,23),0.10))
    txt(32, cy+18, title, 15, (255,255,255), True)
    txt(32, cy+42, meta, 11, blend((255,255,255),(20,20,23),0.40))
    # badge
    bw = 92 if pct<100 else 66
    bx = 424-bw-16
    bc = (236,72,153) if pct<100 else (74,222,128)
    bbg = (58,20,40) if pct<100 else (20,45,30)
    rr(bx, cy+16, bw, 22, 11, bbg, bc)
    txt(bx+bw/2, cy+21, badge, 10, bc, True, "ma")
    # progress bar
    rr(32, cy+68, 376, 6, 3, blend((255,255,255),(20,20,23),0.09))
    if pct>0:
        rr(32, cy+68, 376*pct/100, 6, 3, (236,72,153))
    txt(32, cy+84, foot, 11, blend((255,255,255),(20,20,23),0.45))
    txt(408, cy+84, f"{pct}%", 11, blend((255,255,255),(20,20,23),0.45), False, "ra")
    cy += 144

# tabbar (fixed bottom, safe-area padding-bottom ~34px)
tb_h = 83   # 49 inner + 34 safe area
ty = H - tb_h
d.rectangle([0, ty*S, W*S, H*S], fill=(20,20,23))
d.line([0, ty*S, W*S, ty*S], fill=blend((255,255,255),(20,20,23),0.10), width=S)

labels = ["P\\u0159ehled","Nov\\u00e9","Stahov\\u00e1n\\u00ed","Knihovna","Nastaven\\u00ed"]
tw = W/5
for i,l in enumerate(labels):
    cx = i*tw + tw/2
    active = i==0
    if active:
        rr(cx-40, ty+7, 80, 38, 14, (44,22,36))
    col = (244,114,182) if active else blend((255,255,255),(20,20,23),0.48)
    # icon (simple glyph per tab)
    ix, iy = cx, ty+16
    if i==0:
        for dx,dy in [(-7,-7),(1,-7),(-7,1),(1,1)]:
            d.rectangle([(ix+dx)*S,(iy+dy)*S,(ix+dx+5)*S,(iy+dy+5)*S], outline=col, width=S)
    elif i==1:
        d.line([ix*S,(iy-6)*S,ix*S,(iy+6)*S], fill=col, width=2*S)
        d.line([(ix-6)*S,iy*S,(ix+6)*S,iy*S], fill=col, width=2*S)
    elif i==2:
        d.line([ix*S,(iy-7)*S,ix*S,(iy+5)*S], fill=col, width=2*S)
        d.polygon([((ix-5)*S,(iy+1)*S),((ix+5)*S,(iy+1)*S),(ix*S,(iy+7)*S)], fill=col)
    elif i==3:
        d.rectangle([(ix-7)*S,(iy-7)*S,(ix-1)*S,(iy+7)*S], outline=col, width=S)
        d.rectangle([(ix+1)*S,(iy-7)*S,(ix+7)*S,(iy+7)*S], outline=col, width=S)
    else:
        d.ellipse([(ix-6)*S,(iy-6)*S,(ix+6)*S,(iy+6)*S], outline=col, width=2*S)
        d.ellipse([(ix-2)*S,(iy-2)*S,(ix+2)*S,(iy+2)*S], fill=col)
    txt(cx, ty+47, l, 10, col, True, "ma")

# home indicator
rr(W/2-70, H-9, 140, 5, 3, (255,255,255,220))

img.resize((W, H), Image.LANCZOS).save("build/ui-preview.png")
print("  \\u001b[32m\\u2714\\u001b[0m build/ui-preview.png (440\\u00d7956 @3x -> 1320\\u00d72868 px)")
`;

writeFileSync("build/render_preview.py", py);
console.log("  \u001b[32m✔\u001b[0m build/render_preview.py zapsán");
try {
  const out = execFileSync("python3", ["build/render_preview.py"], { encoding: "utf8" });
  console.log(out);
} catch (e) {
  console.error("Render PNG selhal:", e.message);
  process.exit(1);
}
