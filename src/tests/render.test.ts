import { describe, it, expect, vi, beforeEach } from "vitest";

const native = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  order: [] as string[],
  impl: null as null | ((url: string) => Promise<any>),
  listeners: {} as Record<string, () => void>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    Plugins: {
      WebRenderer: {
        render: async ({ url }: { url: string }) => {
          native.inFlight++;
          native.maxInFlight = Math.max(native.maxInFlight, native.inFlight);
          native.order.push(`start ${url}`);
          try {
            await new Promise((r) => setTimeout(r, 5));
            return native.impl ? await native.impl(url) : { html: `<html>${url}</html>`, url };
          } finally {
            native.order.push(`end ${url}`);
            native.inFlight--;
          }
        },
        addListener: async (name: string, cb: () => void) => {
          native.listeners[name] = cb;
          return { remove: () => delete native.listeners[name] };
        },
      },
    },
  },
}));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "D" },
  Encoding: { UTF8: "utf8" },
  Filesystem: { mkdir: async () => {}, stat: async () => ({ size: 0 }), appendFile: async () => {}, readFile: async () => ({ data: "" }), deleteFile: async () => {}, rename: async () => {}, writeFile: async () => {} },
}));

import { renderHtml, renderPage, onMemoryWarning, RenderError } from "@/services/render";

beforeEach(() => {
  Object.assign(native, { inFlight: 0, maxInFlight: 0, order: [], impl: null });
});

describe("fronta vykreslování (WKWebView)", () => {
  it("souběžné požadavky běží po jednom, v pořadí a navzájem se neruší", async () => {
    const urls = [1, 2, 3, 4].map((n) => `https://wtr-lab.com/c/${n}`);
    const out = await Promise.all(urls.map((u) => renderHtml(u)));
    expect(native.maxInFlight).toBe(1);
    expect(out).toEqual(urls.map((u) => `<html>${u}</html>`));
    expect(native.order).toEqual(urls.flatMap((u) => [`start ${u}`, `end ${u}`]));
  });

  it("chyba jednoho vykreslení nezastaví další ve frontě", async () => {
    native.impl = async (url) => {
      if (url.endsWith("/2")) throw new Error("Rendering timeout");
      return { html: "ok", url };
    };
    const res = await Promise.allSettled([1, 2, 3].map((n) => renderHtml(`https://x.com/${n}`)));
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((res[1] as PromiseRejectedResult).reason).toBeInstanceOf(RenderError);
    expect((res[1] as PromiseRejectedResult).reason.critical).toBe(false);
  });

  it("pád procesu s webovým obsahem je kritická chyba", async () => {
    native.impl = async () => {
      throw new Error("Web content process terminated (possibly out of memory)");
    };
    await expect(renderHtml("https://x.com/1")).rejects.toMatchObject({ critical: true });
  });

  it("příliš mnoho čekajících požadavků se odmítne, fronta neroste bez omezení", async () => {
    const all = Array.from({ length: 9 }, (_, i) => renderHtml(`https://x.com/${i}`));
    const res = await Promise.allSettled(all);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(6);
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect((res[8] as PromiseRejectedResult).reason.message).toMatch(/přetížené/);
    // po vyprázdnění fronty jde vykreslovat dál
    await expect(renderHtml("https://x.com/again")).resolves.toContain("again");
  });

  it("vrací skutečnou adresu po přesměrování", async () => {
    native.impl = async () => ({ html: "x", url: "https://x.com/elsewhere" });
    await expect(renderPage("https://x.com/1")).resolves.toEqual({ html: "x", url: "https://x.com/elsewhere" });
  });

  it("upozornění na paměť z nativního modulu se předá dál a jde odhlásit", async () => {
    const cb = vi.fn();
    const off = onMemoryWarning(cb);
    await Promise.resolve();
    await Promise.resolve();
    native.listeners.memoryWarning?.();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(native.listeners.memoryWarning).toBeUndefined();
  });
});
