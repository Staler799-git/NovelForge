/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react()],
  // Capacitor na iOS servíruje soubory přes capacitor://localhost, kde
  // absolutní cesty "/assets/..." nefungují spolehlivě. Relativní "./assets/"
  // funguje vždy – v prohlížeči i v nativním WebView.
  base: "./",
  define: {
    // Verze zobrazená v Nastavení – jediný zdroj pravdy je package.json.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    // Preview sandboxu běží na jiné doméně než localhost; bez tohoto by Vite
    // odmítl požadavek (403 "Blocked request. This host is not allowed.").
    allowedHosts: true,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
