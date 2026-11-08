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
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

// Cloudflare cookies are bound to the original IP/UA — the new machine must earn its own.
const SKIP = /^(cf_clearance|__cf_bm|_cfuvid)$/;
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
export function parseSessionInput(raw: string): PwCookie[] {
  const text = raw.trim();
  const host = new URL(config.baseUrl).hostname;
  if (!text.startsWith("{") && !text.startsWith("[")) {
    // Bare value of the __Secure-next-auth.session-token cookie.
    return [mkCookie("__Secure-next-auth.session-token", text, host)];
  }
  const data = JSON.parse(text);
  const list: any[] = Array.isArray(data) ? data : (data.cookies ?? []);
  return list
    .filter((c) => c && c.name && c.value !== undefined && !SKIP.test(c.name))
    .map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain ?? host),
      path: String(c.path ?? "/"),
      expires: Number(c.expires ?? c.expirationDate ?? -1) || -1,
      httpOnly: Boolean(c.httpOnly),
      secure: c.secure !== false || /^__(Secure|Host)-/.test(String(c.name)) || normSameSite(c.sameSite) === "None",
      sameSite: normSameSite(c.sameSite),
    }))
    // A cookie without an expiry is a "session cookie" that Chrome drops on exit — give it one so the login persists.
    .map((c) => ({ ...c, expires: c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 90 * 86400 }));
}

export async function importSession(ctx: BrowserContext, raw: string): Promise<number> {
  const cookies = parseSessionInput(raw);
  if (!cookies.length) throw new Error("No cookies found in the provided session data.");
  await ctx.addCookies(cookies);
  return cookies.length;
}

function mkCookie(name: string, value: string, domain: string): PwCookie {
  return { name, value, domain, path: "/", expires: Math.floor(Date.now() / 1000) + 90 * 86400, httpOnly: true, secure: true, sameSite: "Lax" };
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

/** Seeds an empty profile from the env secret — lets fresh cloud containers start already logged in. */
export async function seedFromEnv(ctx: BrowserContext): Promise<boolean> {
  const raw = sessionFromEnv();
  if (!raw) return false;
  const have = (await ctx.cookies(config.baseUrl)).some((c) => c.name.startsWith("__Secure-next-auth.session-token"));
  if (have) return false; // the profile's own (fresher, auto-refreshed) login wins
  await importSession(ctx, raw);
  return true;
}

/** One-line value for GPT_IMAGE_SESSION (cookies only — small enough for any secrets UI). */
export function toEnvValue(file: string): string {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const cookies = (Array.isArray(data) ? data : data.cookies ?? []).filter((c: any) => !SKIP.test(c.name));
  return Buffer.from(JSON.stringify({ cookies })).toString("base64");
}
