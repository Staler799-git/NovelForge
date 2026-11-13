# Stahování na pozadí v iOS – co je možné a co NovelForge dělá

| Mechanismus | Co umí | Proč (ne)použit |
|---|---|---|
| `beginBackgroundTask` | Krátký odklad uspání (řádově 30 s) po odchodu z popředí. | **Použito** (`WebRenderer.beginBackgroundWork`): dokončí se rozpracovaná kapitola a zapíše se stav. |
| Background `URLSession` | Systém sám stáhne/nahraje soubor, i když aplikace neběží. | Jen přenos souborů. Nespustí JS parser, čistič ani zápis do SQLite; každá kapitola WTR-LAB je POST s následným zpracováním a kontrolou přístupu. Systém navíc tempo řídí sám a po ručním ukončení aplikace úlohy ruší. **Nepoužito.** |
| `BGProcessingTask` | Minuty běhu, kdy to určí systém (typicky v noci, na nabíječce). | Čas nelze vynutit ani zaručit; vyžadovalo by nativní parser mimo WebView. Vhodné nanejvýš jako doplněk. **Nepoužito.** |
| `BGContinuedProcessingTask` (iOS 26+) | Pokračování úlohy zahájené uživatelem s průběhem v systému. | Jen iOS 26+, vyžaduje nativní worker nezávislý na WebView (WKWebView s JS je na pozadí uspáván) a oprávnění v Info.plist. Bez zařízení nešlo ověřit. **Neimplementováno** – kandidát na další verzi spolu s nativním (Swift) stahovačem. |

## Skutečné chování verze 1.3.0
- Při zamčení telefonu nebo přepnutí aplikace se **nezačne nová kapitola**; rozpracovaná se dokončí v odkladu (~30 s).
- Požadavek přerušený uspáním se **nepočítá jako chyba** a po návratu se zopakuje.
- Po návratu do popředí stahování **pokračuje samo**.
- Po ručním ukončení aplikace nic neběží; po spuštění se projekt načte, rozpracované kapitoly se vrátí do fronty a pokračuje se chybějícími.
- Pro dlouhé knihy: nechat aplikaci otevřenou (na nabíječce), nebo volitelný server (`docs/server-design.md`).
