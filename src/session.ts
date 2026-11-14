/**
 * Move a ChatGPT login between machines: log in on your own computer (where Google sign-in works),
 * export, then import on a server / VPS / container that runs headless.
 */
import fs from "node:fs";
import type { BrowserContext } from "playwright";
import { config } from "./config.js";

type SameSite = "Strict" | "Lax" | "None";
interface PwCookie {
  name: string;
  value: string;
  /** Either url (host-only, required for __Host- cookies) or domain+path. */
  url?: string;
  domain?: string;
  path?: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

// Cloudflare cookies are bound to the original IP/UA — the new machine must earn its own.
const SKIP = /^(cf_clearance|__cf_bm|_cfuvid)$/;
/** Cloudflare's own cookies. Never copied between machines or between browser contexts: each earns its own. */
export const isCloudflareCookie = (name: string): boolean => SKIP.test(name);
const appHost = () => new URL(config.baseUrl).hostname;
const DOMAINS = { test: (host: string) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(host) || host === appHost() };

export async function exportSession(ctx: BrowserContext, file: string): Promise<number> {
  const state = await ctx.storageState();
  const cookies = state.cookies.filter((c) => DOMAINS.test(c.domain.replace(/^\./, "")) && !SKIP.test(c.name));
  const origins = state.origins.filter((o) => DOMAINS.test(new URL(o.origin).hostname));
  fs.writeFileSync(file, JSON.stringify({ cookies, origins }, null, 2), { mode: 0o600 });
  return cookies.length;
}

/** Accepts Playwright storageState JSON, a Cookie-Editor / EditThisCookie export array, or a raw session-token string. */
/**
 * Accepts any of:
 *  - Playwright storageState JSON (from `export-session`)
 *  - a Cookie-Editor / EditThisCookie JSON export (array)
 *  - a one-line cookie header string ("name=value; name2=value2", Cookie-Editor's "Header String" export)
 *  - the raw value of the __Secure-next-auth.session-token cookie
 */
export function parseSessionInput(raw: string): PwCookie[] {
  const text = raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  const origin = new URL(config.baseUrl).origin + "/";
  const host = new URL(config.baseUrl).hostname;
  // __Host- cookies must be host-only (set via url); everything else via domain+path.
  const where = (name: string) => (name.startsWith("__Host-") ? { url: origin } : { domain: host, path: "/" });
  const later = Math.floor(Date.now() / 1000) + 90 * 86400;

  if (!text.startsWith("{") && !text.startsWith("[")) {
    if (/^[\w.\-]+=/.test(text)) {
      // Cookie header string.
      return text
        .split(/;\s*/)
        .map((pair) => {
          const i = pair.indexOf("=");
          return i > 0 ? { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() } : null;
        })
        .filter((c): c is { name: string; value: string } => !!c && !!c.name && !SKIP.test(c.name))
        .map((c) => ({ ...c, ...where(c.name), expires: later, httpOnly: c.name.includes("session-token"), secure: true, sameSite: "Lax" as SameSite }));
    }
    // Bare value of the __Secure-next-auth.session-token cookie.
    return [{ name: "__Secure-next-auth.session-token", value: text, ...where("__Secure-"), expires: later, httpOnly: true, secure: true, sameSite: "Lax" }];
  }

  const data = JSON.parse(text);
  const list: any[] = Array.isArray(data) ? data : (data.cookies ?? []);
  return list
    .filter((c) => c && c.name && c.value !== undefined && !SKIP.test(c.name))
    .map((c): PwCookie => {
      const name = String(c.name);
      const sameSite = normSameSite(c.sameSite);
      const base = {
        name,
        value: String(c.value),
        // A cookie without an expiry is a "session cookie" that Chrome drops on exit — give it one so the login persists.
        expires: Number(c.expires ?? c.expirationDate ?? -1) > 0 ? Math.floor(Number(c.expires ?? c.expirationDate)) : later,
        httpOnly: Boolean(c.httpOnly),
        secure: c.secure !== false || /^__(Secure|Host)-/.test(name) || sameSite === "None",
        sameSite,
      };
      // __Host- cookies must be host-only (no Domain attribute).
      if (name.startsWith("__Host-") || !c.domain) return { ...base, ...where(name) };
      return { ...base, domain: String(c.domain), path: String(c.path ?? "/") };
    });
}

export async function importSession(ctx: BrowserContext, raw: string): Promise<number> {
  const cookies = parseSessionInput(raw);
  if (!cookies.length) throw new Error("No cookies found in the provided session data.");
  await ctx.addCookies(cookies);
  return cookies.length;
}

function normSameSite(v: unknown): SameSite {
  const s = String(v ?? "").toLowerCase();
  if (s === "strict") return "Strict";
  if (s === "none" || s === "no_restriction") return "None";
  return "Lax";
}

/** Reads GPT_IMAGE_SESSION (JSON, base64 JSON, or raw token) or GPT_IMAGE_SESSION_FILE. */
export function sessionFromEnv(): string | null {
  const file = process.env.GPT_IMAGE_SESSION_FILE;
  let v = process.env.GPT_IMAGE_SESSION || (file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
  v = v.trim();
  if (!v) return null;
  if (!v.startsWith("{") && !v.startsWith("[")) {
    try {
      const decoded = Buffer.from(v, "base64").toString("utf8").trim();
      if (decoded.startsWith("{") || decoded.startsWith("[")) return decoded;
    } catch {
      /* raw token */
    }
  }
  return v;
}

/**
 * Seeds an empty profile from the env secret — lets fresh cloud containers start already logged in.
 * `beforeImport` runs only when a login is about to be added (see BrowserManager.firstVisit).
 */
export async function seedFromEnv(ctx: BrowserContext, beforeImport?: () => Promise<void>): Promise<boolean> {
  const raw = sessionFromEnv();
  if (!raw) return false;
  const have = (await ctx.cookies(config.baseUrl)).some((c) => c.name.startsWith("__Secure-next-auth.session-token"));
  if (have) return false; // the profile's own (fresher, auto-refreshed) login wins
  if (beforeImport) await beforeImport();
  await importSession(ctx, raw);
  return true;
}

/** One-line value for GPT_IMAGE_SESSION (cookies only — small enough for any secrets UI). */
export function toEnvValue(file: string): string {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const cookies = (Array.isArray(data) ? data : data.cookies ?? []).filter((c: any) => !SKIP.test(c.name));
  return Buffer.from(JSON.stringify({ cookies })).toString("base64");
}
