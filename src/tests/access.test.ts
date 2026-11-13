import { describe, it, expect } from "vitest";
import { AccessError, classifyHttp, parseRetryAfter, statusForAccess, pauseMessage, looksLikeLoginMessage, accessKindOf } from "@/services/access";
import { AdaptivePace, RunStats, basePace, formatDuration, MAX_RATE_LIMIT_WAITS } from "@/services/speed";
import { projectStatus } from "@/services/status";

describe("rozlišení přístupových omezení", () => {
  it("HTTP 429 = omezení požadavků, respektuje Retry-After (sekundy i datum)", () => {
    const e = classifyHttp(429, { "Retry-After": "30" }, "Too Many Requests")!;
    expect(e).toMatchObject({ kind: "rate-limited", retryAfterMs: 30000, stopSource: false, retryable: true });
    expect(parseRetryAfter("120")).toBe(120000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(30000);
    expect(parseRetryAfter("99999")).toBe(3_600_000); // nejvýše hodina
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("HTTP 403 = přístup odmítnut; 401 = přihlášení; 404/410 = nedostupná kapitola", () => {
    expect(classifyHttp(403, {}, "<html><body>Forbidden</body></html>")).toMatchObject({ kind: "forbidden", stopSource: false });
    expect(classifyHttp(401, {}, "")).toMatchObject({ kind: "login-required", stopSource: true });
    expect(classifyHttp(404, {}, "")).toMatchObject({ kind: "unavailable", stopSource: false, retryable: false });
    expect(classifyHttp(410, {}, "")).toMatchObject({ kind: "unavailable" });
    expect(classifyHttp(200, {}, "<html><body>ok</body></html>")).toBeNull();
    expect(classifyHttp(500, {}, "oops")).toBeNull();
  });

  it("Cloudflare challenge se pozná z hlavičky i ze stránky – i když má stav 403 nebo 200", () => {
    expect(classifyHttp(403, { "cf-mitigated": "challenge" }, "")).toMatchObject({ kind: "challenge", stopSource: true });
    expect(classifyHttp(403, {}, "<html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/x.js'></script></body></html>")).toMatchObject({ kind: "challenge" });
    expect(classifyHttp(200, {}, "<html><body><h1>Security Check Required</h1><p>We've detected unusual reading activity from your IP address.</p><div class='cf-turnstile'></div></body></html>")).toMatchObject({ kind: "challenge" });
    expect(classifyHttp(200, {}, "<html><body><div class='g-recaptcha'></div></body></html>")).toMatchObject({ kind: "challenge" });
    // JSON odpověď se za ověřovací stránku nepovažuje, i když slovo obsahuje
    expect(classifyHttp(200, {}, '{"body":["the captain passed a security check required by the port"]}')).toBeNull();
  });

  it("hlášky o registraci a přihlášení", () => {
    expect(looksLikeLoginMessage("AI Translation Requires Registration")).toBe(true);
    expect(looksLikeLoginMessage("Please sign in to continue")).toBe(true);
    expect(looksLikeLoginMessage("Unauthorized")).toBe(true);
    expect(looksLikeLoginMessage("Chapter not found")).toBe(false);
  });

  it("stav projektu a zpráva po zastavení", () => {
    expect(statusForAccess("challenge")).toBe("verification-required");
    expect(statusForAccess("login-required")).toBe("waiting-auth");
    expect(statusForAccess("translation-locked")).toBe("waiting-auth");
    expect(statusForAccess("rate-limited")).toBe("rate-limited");
    expect(statusForAccess("forbidden")).toBe("paused");
    expect(pauseMessage("WTR-LAB", "login-required", "x")).toMatch(/WTR-LAB vyžaduje přihlášení\. Stahování bylo pozastaveno a hotové kapitoly zůstaly uložené\./);
    expect(pauseMessage("WTR-LAB", "challenge", "x")).toMatch(/bezpečnostní ověření.*proveďte sami/);
    expect(accessKindOf(new AccessError("challenge", "x"))).toBe("challenge");
    expect(accessKindOf(new Error("x"))).toBeNull();
  });

  it("zobrazované stavy", () => {
    const p = { totalChapters: 3138, downloadedChapters: 10 };
    expect(projectStatus({ ...p, status: "waiting-auth" }, false)).toMatchObject({ label: "Čeká na přihlášení", variant: "warn" });
    expect(projectStatus({ ...p, status: "verification-required" }, false)).toMatchObject({ label: "Vyžadováno ověření" });
    expect(projectStatus({ ...p, status: "rate-limited" }, false)).toMatchObject({ label: "Omezeno webem" });
    expect(projectStatus({ ...p, status: "waiting-auth" }, true)).toMatchObject({ label: "Stahuje se" });
    expect(projectStatus({ ...p, status: "paused" }, false)).toMatchObject({ label: "Pozastaveno" });
    expect(projectStatus({ ...p, status: "failed" }, false)).toMatchObject({ label: "Dokončeno s chybami" });
    expect(projectStatus({ totalChapters: 5, downloadedChapters: 5, status: "completed" }, false)).toMatchObject({ label: "Dokončeno" });
  });
});

describe("rychlostní režimy", () => {
  const open = { maxConcurrency: Infinity, allowFast: true, minIntervalMs: 0 };
  const wtr = { maxConcurrency: 1, allowFast: false, minIntervalMs: 3000 };
  const settings = { concurrentRequests: 3, delayMs: 1500 };

  it("vyvážený = nastavení projektu v mezích zdroje", () => {
    expect(basePace("balanced", settings, open)).toEqual({ mode: "balanced", concurrency: 3, delayMs: 1500 });
    expect(basePace(undefined, settings, open).mode).toBe("balanced");
    expect(basePace("balanced", settings, wtr)).toEqual({ mode: "balanced", concurrency: 1, delayMs: 3000 });
  });

  it("úsporný = po jedné kapitole, dvojnásobný odstup", () => {
    expect(basePace("eco", settings, open)).toEqual({ mode: "eco", concurrency: 1, delayMs: 3000 });
    expect(basePace("eco", settings, wtr)).toEqual({ mode: "eco", concurrency: 1, delayMs: 6000 });
  });

  it("rychlý jen tam, kde to zdroj dovoluje; nikdy pod nejkratší odstup a nad 4 souběžně", () => {
    expect(basePace("fast", settings, open)).toEqual({ mode: "fast", concurrency: 4, delayMs: 600 });
    expect(basePace("fast", { concurrentRequests: 9, delayMs: 100 }, open)).toEqual({ mode: "fast", concurrency: 4, delayMs: 300 });
    expect(basePace("fast", settings, { maxConcurrency: 2, allowFast: true, minIntervalMs: 1000 })).toEqual({ mode: "fast", concurrency: 2, delayMs: 1000 });
    // WTR-LAB: rychlý režim se nepoužije vůbec
    expect(basePace("fast", settings, wtr)).toEqual({ mode: "balanced", concurrency: 1, delayMs: 3000 });
  });

  it("adaptivní tempo: omezení webu zpomalí a sníží souběžnost, řada úspěchů ho postupně vrátí", () => {
    const pace = new AdaptivePace({ mode: "balanced", concurrency: 3, delayMs: 1500 });
    expect(pace.onRateLimit()).toBe(5000);
    expect(pace).toMatchObject({ concurrency: 1, delayMs: 3000 });
    expect(pace.onRateLimit(30000)).toBe(30000); // Retry-After má přednost před kratším backoffem
    expect(pace.delayMs).toBe(6000);
    expect(pace.onRateLimit(1000)).toBe(20000); // backoff roste: 5 s, 10 s, 20 s
    for (let i = 0; i < 15; i++) pace.onSuccess();
    expect(pace.delayMs).toBe(9600); // 12000 * 0.8
    for (let i = 0; i < 15 * 12; i++) pace.onSuccess();
    expect(pace.delayMs).toBe(1500);
    for (let i = 0; i < 30; i++) pace.onSuccess();
    expect(pace.concurrency).toBe(3);
    expect(pace.slowdowns).toBe(3);
  });

  it("po opakovaném omezení bez úspěchu se čekání ukončí", () => {
    const pace = new AdaptivePace({ mode: "balanced", concurrency: 1, delayMs: 3000 });
    const waits = Array.from({ length: MAX_RATE_LIMIT_WAITS + 1 }, () => pace.onRateLimit());
    expect(waits).toEqual([5000, 10000, 20000, 40000, null]);
    expect(pace.delayMs).toBe(60000); // strop
  });

  it("statistika: kapitoly za minutu, průměr a odhad", () => {
    const s = new RunStats(0);
    expect(s.perMinute(1000)).toBe(0);
    expect(s.etaMs(100, 1000)).toBeNull();
    for (let i = 1; i <= 10; i++) s.record(500, { fetch: 400, clean: 60, write: 30, db: 10 }, i * 3000);
    expect(s.completed).toBe(10);
    expect(s.avgChapterMs).toBe(500);
    expect(s.perMinute(30000)).toBeCloseTo(20, 5);
    expect(s.etaMs(3128, 30000)).toBeCloseTo(3128 * 3000, 0);
    expect(s.steps).toEqual({ fetch: 4000, clean: 600, write: 300, db: 100 });
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(3128 * 3000)).toBe("2 h 36 min");
    expect(formatDuration(null)).toBe("–");
  });
});
