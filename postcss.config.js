/**
 * PostCSS konfigurace pro Tailwind CSS 3.
 *
 * BEZ TOHOTO SOUBORU VITE TAILWIND NEZPRACUJE.
 *
 * Vite si PostCSS konfiguraci hledá sám (postcss.config.js v rootu). Když ji
 * nenajde, `@tailwind base/components/utilities` i všechny `@apply` direktivy
 * projdou do výsledného CSS jako SUROVÝ TEXT. Prohlížeč je ignoruje, takže:
 *   - chybí `bg-dark-900`  -> bílé pozadí místo #0a0a0b
 *   - chybí `font-sans`    -> výchozí patkové písmo
 *   - chybí veškerý layout -> rozhozená navigace a karty
 *
 * Přesně to byl stav, kdy se aplikace na iPhonu zobrazila bez stylů.
 *
 * Verze: tailwindcss 3.x (NEmigrovat na 4 – projekt používá tailwind.config.js
 * s `theme.extend` a `@apply`, což je formát Tailwind 3).
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
