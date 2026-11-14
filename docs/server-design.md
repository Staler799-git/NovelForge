# NovelForge – volitelný serverový režim (technický návrh)

Stav: **návrh, neimplementováno.** Lokální režim v iPhonu funguje samostatně a na serveru nijak nezávisí.

## Proč
iOS nedovolí aplikaci stahovat hodiny na pozadí (viz `docs/background-ios.md`). Kniha o 3138 kapitolách při odstupu 3 s trvá zhruba 2,6 hodiny s otevřenou aplikací. Vlastní linuxový stroj může stejnou frontu zpracovat bez ohledu na stav telefonu.

## Zásady
- Server používá **stejná pravidla jako aplikace**: jeden překlad na projekt, odstupy a souběžnost podle zdroje, Retry-After, zastavení při ověření / přihlášení / zamčeném překladu.
- Server **neřeší CAPTCHA, nevyrábí ověřovací tokeny a nezískává zamčený ani placený obsah**. Při překážce nastaví stav projektu (`verification-required`, `waiting-auth`, `rate-limited`) a čeká na uživatele.
- Přihlašovací relaci server nezískává sám. Pokud ji zdroj vyžaduje, uživatel se přihlásí vlastním účtem v prohlížeči na serveru (profil prohlížeče uložený jen na jeho stroji). Hesla se neukládají; cookies se nikdy nelogují ani nepřenášejí do telefonu.
- Dostupný jen přes soukromou síť (Tailscale); žádný veřejný port.

## Součásti
| Součást | Popis |
|---|---|
| `novelforge-worker` | Node.js 20+ proces. Znovu používá `src/services/parser/*`, `access.ts`, `speed.ts`, `cleaner`, `epub.ts` (bez Capacitoru; `HttpClient` nad `fetch`/undici, úložiště nad `fs`). |
| Trvalá fronta | SQLite (`better-sqlite3`, WAL) se stejným schématem `projects` / `chapters` jako aplikace (včetně `translation_mode`, `error_kind`, `checksum`, `retry_count`). Po restartu: `downloading` → `pending`, ověření souborů proti `checksum`. |
| Lokální cache | `data/projects/<id>/<chapterId>.html` (stejný XHTML jako v telefonu), `data/covers/`, `data/exports/*.epub`. Zápis atomicky (temp + rename). |
| API | HTTP+JSON na rozhraní Tailscale (`100.x.y.z:8787`), autorizace tokenem zařízení (Bearer, uložený v iOS Keychain) + ACL Tailscale. |
| Služba | `systemd` unit (`Restart=on-failure`, `StateDirectory=novelforge`), logy v journald se stejnou redakcí jako `diag.ts`. |

## API (návrh)
```
GET  /v1/status                         verze, fronta, volné místo
GET  /v1/projects                       seznam + stav + počítadla + RunView
POST /v1/projects                       {sourceUrl, translationMode, speedMode, chapters?}
GET  /v1/projects/:id                   detail, accessKind/accessMessage
POST /v1/projects/:id/start|pause       ruční řízení (obnovení po ověření je vždy ruční)
PATCH /v1/projects/:id                  nastavení; změna překladu vyžaduje confirm=true
GET  /v1/projects/:id/chapters?since=   změny kapitol (id, stav, checksum, translationMode)
GET  /v1/projects/:id/chapters/:cid     obsah jedné kapitoly (XHTML)
POST /v1/projects/:id/epub              sestaví EPUB → {exportId}
GET  /v1/exports/:exportId              stažení EPUB (Range)
GET  /v1/events                         SSE: průběh, stav, překážky
```

## Synchronizace s aplikací
- Projekt má stabilní UUID; kapitola se páruje podle `source_url` + `order_index`.
- **Telefon → server** (převzetí rozpracované knihy): metadata + seznam kapitol s `checksum` a `translationMode`; hotové kapitoly se nahrají, nestahují se znovu.
- **Server → telefon**: aplikace stáhne jen kapitoly, které nemá (`since` kurzor), ověří `checksum` a zapíše je stejnou cestou jako lokální stahování. Kapitola v jiném překladu, než má projekt v telefonu, se nepřijme bez potvrzení.
- Konflikt: vyhrává existující stažená kapitola (nikdy se nepřepisuje jiným překladem).
- EPUB: buď se sestaví na serveru a přenese jako soubor (do `Documents/NovelForge/exports`), nebo se sestaví v telefonu po synchronizaci kapitol.

## Ovládání z iPhonu
Nastavení → „Server“ (volitelné): adresa v tailnetu, token, test spojení. U projektu přepínač „Stahovat na serveru“. Seznam stahování ukazuje stejné stavy a stejnou hlášku o překážce; tlačítko „Otevřít zdrojovou stránku“ zůstává. Při nedostupném serveru aplikace funguje lokálně jako dnes.

## Tailscale
- Server i iPhone ve stejném tailnetu; služba poslouchá jen na `tailscale0`.
- ACL: jen zařízení uživatele → `tag:novelforge:8787`. Volitelně `tailscale serve` pro HTTPS s certifikátem tailnetu (bez výjimek ATS v iOS).
- Aplikace potřebuje v `Info.plist` jen běžný HTTPS přístup; při čistém HTTP na 100.x by byla nutná výjimka ATS – proto se doporučuje `tailscale serve`.

## Přístupová práva zdrojů
- Server vychází z jiné IP adresy než telefon: ověření provedené v telefonu pro server neplatí a naopak. Aplikace to u projektu uvádí.
- Limity zdroje (WTR-LAB: 1 požadavek naráz, odstup ≥ 3 s, žádný rychlý režim) jsou v parseru a platí i na serveru; server je nezvyšuje.
- Souběh telefon + server nad stejným zdrojem se nepovoluje (projekt stahuje vždy jen jedno místo), aby se limity nesčítaly.

## Otevřené body před implementací
1. Parsery používají `DOMParser` – na serveru `linkedom`/`happy-dom` (testy už v happy-dom běží).
2. Stránky románu WTR-LAB se v telefonu vykreslují ve WKWebView; na serveru by to vyžadovalo prohlížeč (Playwright) spuštěný uživatelem – jen pro katalog, ne pro obcházení ověření.
3. Formát přenosu většího počtu kapitol (jednotlivě vs. archiv) změřit na reálné knize.
