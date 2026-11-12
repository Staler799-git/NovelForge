/**
 * Bezpečné parsování cizího HTML.
 *
 * Před předáním DOMParseru se z textu odstraní prvky, které text kapitoly
 * ani metadata nikdy nenesou, ale mohou spouštět vedlejší účinky:
 *   - <script> (kromě JSON-LD, ze kterého se čte obálka),
 *   - <iframe>, <object>, <embed>,
 *   - <link rel="stylesheet">.
 *
 * Skutečný prohlížeč (WKWebView) je u dokumentu z DOMParseru nenačítá, ale
 * jiné implementace DOM ano (happy-dom v testech se je pokoušel stahovat a
 * končilo to neošetřenými chybami). Odstranění je levné a chování je pak
 * všude stejné.
 */
export function inertHtml(html: string): string {
  return html
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (m, attrs: string) => (/ld\+json/i.test(attrs) ? m : ""))
    .replace(/<script\b(?![^>]*ld\+json)[^>]*>/gi, "")
    .replace(/<(iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(iframe|object|embed)\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*stylesheet[^>]*>/gi, "");
}

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(inertHtml(html), "text/html");
}
