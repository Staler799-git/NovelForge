# NovelForge – Web Novel to EPUB Converter pro iOS

NovelForge je plně funkční iOS aplikace pro převod web novel (online románů kapitol po kapitole) do jedné souboru EPUB 3, který lze číst v Apple Books, ElevenReader, Calibre a dalších čtečkách. Aplikace běží úplně lokálně na iPhonu – nevyžaduje server, registraci ani placené API.

[https://www.wuxiabox.com/novel/i-created-the-longevity-club.html](https://www.wuxiabox.com/novel/i-created-the-longevity-club.html) je primárním testovacím zdrojem.

## 1. Technologie a odůvodnění volby

**React + TypeScript + Capacitor (iOS)** – UI je sestaveno v Reactu (Vite, Tailwind CSS, typografie Dynamického ostrova-friendly tmavého režimu s růžovo-fialovými akcenty), nativoské mosty zajišťuje Capacitor:

| Funkce | Capacitor plugin |
|---|---|
| SQLite (projekty, kapitoly, stav, retry počítadla) | `@capacitor-community/sqlite` |
| Souborové úložiště (kapitoly, obálky, exporty) | `@capacitor/filesystem` |
| HTTP požadavky (bez CORS omezení, cookies) | `@capacitor-community/http` |
| SDílení (Share Sheet do Souborů / čteček) | `@capacitor/share` |
| Galerii a výběr obálky | `@capacitor/camera` |
| Haptika, stavový řádek, splash screen, klávesnice | `@capacitor/haptics`, `status-bar`, `splash-screen`, `keyboard` |
| Síť | `@capacitor/network` |
| ZIP / EPUB balíček | `jszip` (čistý JS, MIT) |

**Proč ne čistě nativní Swift?** Swift by byl vhodnější pouze pro neomezené stahování na pozadí (Background Sessions), ale iOS i tak dlouhé stahování na pozadí negarantuje (viz sekce Omezení). Capacitor pokrývá všechny potřebné nativní rozhraní (SQLite, soubory, sdílení, kamera/galerie), udržuje jednu kodovou bázi pro UI a usnadňuje testování (unit testy běží v Node/happy-dom bez Xcode). Pro stránky vykreslované JavaScriptem je přidán malý nativní Swift plugin `WebRenderer` (WKWebView), který načte cizí URL, počká na dokončení renderu a vrátí finální HTML.

## 2. Struktura repozitáře

```
NovelForge/
├── capacitor.config.ts      # Konfigurace Capacitoru (appId com.novelforge.app)
├── codemagic.yaml           # Sestavení IPA pro Signulous
├── export-options.plist     # Možnosti exportu archivu (ad-hoc)
├── package.json, tsconfig.json, vite.config.ts, tailwind.config.js
├── index.html
├── src/
│   ├── main.tsx, App.tsx           # Spuštění, router, inicializace Capacitoru
│   ├── layout/TabNavigator.tsx     # Dolní navigace (5 záložek)
│   ├── lib/utils.ts                # Formátování data, velikosti, domény
│   ├── store.ts                    # Jednoduchý reaktivní store projektů
│   ├── services/
│   │   ├── db.ts                   # SQLite, schéma, migrace, DAO metody
│   │   ├── http.ts                 # HTTP klient (Capacitor HTTP + fetch fallback)
│   │   ├── storage.ts              # Soubory v Documents/NovelForge/{projects,covers,exports,cache}
│   │   ├── cover.ts                # Obálky: galerie, placeholder, uložení
│   │   ├── downloader.ts           # Fronta, souběh, prodleva, opakování, RESUME
│   │   ├── epub.ts                 # EPUB 3 generator (čistý TS + jszip)
│   │   ├── render.ts               # Nativní WKWebView render pro JS stránky
│   │   └── parser/
│   │       ├── base.ts             # Abstrakce parseru + HTML vyčištění
│   │       ├── registry.ts         # Registrace a výběr parseru dle domény
│   │       ├── generic.ts          # Obecný heuristický parser (všechny weby)
│   │       └── wuxiabox.ts         # Adaptér pro wuxiabox.com
│   ├── pages/                      # Dashboard, NewDownload, Downloads, Library, ProjectDetail, EpubExport, Settings
│   ├── components/ui.tsx           # Button, Input, Card, Badge, ProgressBar, …
│   └── tests/                      # Unit testy + HTML fixatury
├── ios/                            # Nativní Xcode projekt (Capacitor)
│   ├── App/App/Plugins/WebRenderer.swift   # WKWebView plugin pro JS-renderované weby
│   └── App/App/Info.plist                # Práva (kamera, galerie, ATS)
├── .gitignore
└── README.md
```

## 3. Hlavní funkce

### 3.1 URL → EPUB (nový projekt)
1. Uživatel vloží URL web novely.
2. Aplikace načte stránku a detekuje název, autora, popis, jazyk a obálku (og:* meta tagy, `<h1>`, `.author`).
3. Detekuje seznam kapitol – obecná heuristika (odkazy s "kapitola/chapter/díl/ep/číslem ve stejné doméně") nebo site-specific adaptér (wuxiabox.com).
4. Kapitoly se seřadí podle čísla v názvu, zobrazí se jejich počet a stav.
5. Uživatel vybere rozsah (vše / vybrané / vlastní rozsah) a spustí stahování.
6. Každá kapitola se stáhne, vyčistí (navigace, reklamy, patička, komentáře, sociální tlačítka) a uloží jako čisté XHTML.

Podporovány jsou klasické HTML stránky i stránky vykreslované JavaScriptem (přes nativní `WebRenderer` plugin). Pokud automatická detekce selže, nabízí se obecný parser a uživatel si může odkazy zkontrolovat.

### 3.2 Bezpečné stahování a obnovení (Resume) – kritická funkce
- Každá úspěšně stažená kapitola se **okamžitě zapisuje na disk** (Documents/NovelForge/projects/<id>/<chapterId>.html) a eviduje se v SQLite se stavem `downloaded`, velikostí a kontrolním součtem.
- Při přerušení (internet, chyba serveru, uzavření aplikace, restart telefonu) se po restartu:
  - načte projekt,
  - zjistí dokončené kapitoly,
  - ověří existenci a velikost souborů na disku,
  - přeskočí hotové kapitoly,
  - automaticky pokračuje od první chybějící/neúplné.
- Ovládání: **Pause** (pozastavit – aktuální fronta se dovolí dořídit a projekt se označí `paused`), **Resume** (obnovit), **Retry failed** (opakovat jen selhané), **Cancel** (zrušit).
- Zabraňuje duplicitním kapitolám (kapitola je identifikována hashem URL).
- Atomičnost zápisu: kapitola se zapíše celá a teprve poté se zapíše velikost a kontrolní součet do DB; při porovnání po restartu se neúplný soubor přehraje.

> Omezení iOS: systém dovoluje aplikaci běžet na pozadí pouze omezeně. Pro spolehlivé stahování stovek kapitol nechte aplikaci otevřenou (nebo ji občas přepněte do popředí). Stahování je vždy možné pozastavit a obnovit – žádná hotová kapitola se nestahuje dvakrát.

### 3.3 Export EPUB 3
Ve výchozím nastavení se tvoří **JEDEN soubor EPUB** se všemi vybranými kapitolami (nikdy se nerozděluje bez souhlasu uživatele). Volitelné rozdělení: první N kapitol nebo vlastní rozsah (např. 1-50).

Každý EPUB obsahuje:
- název, autora, jazyk, popis, datum úpravy (`dcterms:modified`),
- obálku vloženu přímo do balíčku (`properties="cover-image"`, `<meta name="cover">`),
- obsah s navigací (`nav.xhtml` s `epub:type="toc"`),
- zpětnou kompatibilitu NCX (`toc.ncx`),
- čisté XHTML kapitoly s UTF-8, asociované CSS styly,
- správné pořadí kapitol (spine/itemref).

Export také do **TXT** a **HTML**. Hotový soubor se sdílí přes iOS Share Sheet do Souborů, Apple Books, ElevenReader, Calibre (přes soubor) atd.

### 3.4 Download Manager (samostatná obrazovka "Stahování")
Pro každý projekt zobrazuje: název, obálku, počet kapitol, staženo/selhalo, procentuální průběh, aktuálně zpracovávanou kapitolu, odhad sizes, stav a čas aktualizace. Ovládací prvky: Pozastavit, Obnovit, Zkusit selhané, Zrušit, Export EPUB (po dokončení).

### 3.5 Knihovna
Všechny projekty s kartami (obálka, název, autor, pokrok, stav). Možnost pokračovat ve stahování, zkontrolovat, exportovat nebo otevřít detaily projektu se seznamem kapitol a jejich stavem.

### 3.6 Obálky a metadata
- Automatická detekce z `og:image`.
- Vlastní obrázek z galerie (s oříznutím přes nativní rozhraní iOS).
- Jednoduchý placeholder s názvem knihy.
- Obálka se vloží přímo do EPUBu (viditelná v čtečkách).
- Název, autor, jazyk a popis se editují před stažením i před exportem.

### 3.7 Nastavení
Výchozí souběžnost požadavků (1-10), prodleva mezi požadavky (ms) a maximální počet opakování při chybě (0-20). Ukládáno trvale (`@capacitor/preferences`).

## 4. Omezení a kompromisy (iOS)

1. **Živé testování wuxiabox.com nebylo v tomto prostředí možné** (sandbox povoluje odchozí spojení pouze na github.com a npm registry). Selektory v `wuxiabox.ts` vycházejí z běžné struktury web-novelových katalogů a budou vyžadovat odladění proti skutečnému webu. Pokud detekce selže, aplikace automaticky použije `GenericNovelParser` a nabídne ruční výběr odkazů. Automatické testy jsou sestaveny s uloženými HTML fixatury.
2. **Stahování na pozadí**: iOS neposkytuje neomezené background stahování bez speciálních oprávnění. NovelForge nepoukazuje na nepřerušitelné běhání na pozadí – doporučuje se nechat aplikaci spuštěnou. Resume funguje spolehlivě po restartu i uzavření aplikace.
3. **Signulous**: instalace IPA přes Signulous nevyžaduje jailbreak. Vyžaduje však platný vývojářský/distribuční účet Apple pro sestavení podepsaného archivu v Codemagic (viz níže).
4. **DRM / placený obsah / CAPTCHA**: aplikace tyto ochrany neobchází. Stahuje pouze volně přístupný obsah.

## 5. Postup sestavení a instalace

### Lokálně (macOS + Xcode)
```bash
cd /home/user/NovelForge   # (ve vašem macOS pracovním adresáři)
npm install --legacy-peer-deps
npm run build             # Vite sestavení do dist/
npx cap sync ios          # zkopíruje web do ios/App
npx cap open ios          # otevře Xcode
```
V Xcode vyberte схему `App`, cíl váš iPhone (fyzické zařízení; simulátor nelze pro finální IPA), připojte podepsání (Apple ID / vývojářský certifikát) a sestavte: **Product → Archive → Distribute App → Ad Hoc** (nebo Development pro osobní použití).

### Přes Codemagic (doporučeno pro Signulous)
1. Nahrajte repozitář na GitHub.
2. V Codemagic vytvořte novou aplikaci, vyberte tento repozitář a soubor `codemagic.yaml`.
3. Nastavte proměnné prostředí: `TEAM_ID` (váš Apple Team ID). Pro podepsání potřebujete v Codemagic nahrát distribční certifikát a provisioning profil (App Store nebo Ad Hoc).
4. Spusťte build – výstupem je `NovelForge.ipa` (artefakt buildu).

### Instalace přes Signulous (bez jailbreaku)
1. Stáhněte `NovelForge.ipa` z artefaktů Codemagic buildu.
2. V webovém rozhraní Signulous nahrajte .ipa soubor.
3. Signulous soubor znovu podepře swoim enterprise certifikátem.
4. Nainstalujte upravený .ipa do iPhonu přes Safari (odkaz od Signulous) nebo přes configurator. Není nutný jailbreak, není nutný App Store.

> Poznámka: Signulous vyžaduje vlastní předplatné/signovací certifikát Signulous; NovelForge si jej neposkytuje.

## 6. Testy

```bash
npm run test        # spustí všechny unit testy (vitest)
```

Testy pokrývají:
- **parser.test.ts** (6 testů): detekce adaptéru dle domény, extrakce metadat (název, autor, obálka, jazyk), vyhledání a seřazení kapitol (číselné řazení 1, 2, 3, 10), vyloučení nekapitola odkazů, vyčištění kapitoly od navigace/reklamy – s fixatury v `src/tests/fixtures/`.
- **epub.test.ts** (2 testy): validní EPUB 3 (mimetyp nekomprimovaný, `container.xml`, `content.opf` s metadaty, obálkou a `nav`, `nav.xhtml` s `epub:type="toc"`, `toc.ncx`, XHTML kapitoly s UTF-8, vložení obálky).
- **downloader.test.ts** (4 testy): kompletní stahování, přeskočení hotových kapitol při obnově, přehrazení neúplného souboru, `Retry failed` (reset selhaných a opětovné stažení).

Živé end-to-end testování proti `wuxiabox.com` nebylo v tomto prostředí proveditelné (viz sekce Omezení).

## 7. Jak přidat parser pro nový web

Vytvořte nový soubor v `src/services/parser/` (např. `mojewebsite.ts`):

```ts
import { NovelParser, cleanText, extractTitle } from "./base";
import type { NovelMetadata, ParserChapter } from "@/types";

export class MojeWebsiteParser extends NovelParser {
  canHandle(url: string): boolean {
    try { return new URL(url).hostname === "mojewebsite.cz"; } catch { return false; }
  }
  async fetchMetadata(url: string) { /* ... */ }
  async fetchChapterList(url: string) { /* ... */ }
  async fetchChapter(url: string) { /* ... */ }
}
```

a zaregistrujte ho v `src/services/parser/registry.ts` před generický parser:

```ts
const parsers: NovelParser[] = [new MojeWebsiteParser(), new WuxiaBoxParser()];
```

První shodný `canHandle` vyhraje; ostatní weby obslouží `GenericNovelParser`.

## 8. Licence dépendencí

Všechny použité knihovny jsou pod permissivními licencemi (MIT / ISC / BSD) kompatibilními s iOS a uzavřeným zdrojovým kódem: React, Capacitor, jszip, Tailwind, Lucide, atd. `@capacitor-community/sqlite` je MIT. Celý zdrojový kód aplikace můžete nahrát na GitHub a sestavit přes Codemagic dle výše uvedeného postupu.

## 9. Kontakt a budoucí rozvoj

Plánované vylepšení: kontrola nových kapitol pro uložené projekty, záloha/obnovení projektů (export/import JSON databáze), Live Activities pro indikaci průběhu, více site-specific adaptérů.
