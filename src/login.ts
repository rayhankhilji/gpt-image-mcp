/**
 * One-time login. Opens your normal installed Chrome (not an automation-launched one) with a
 * dedicated profile, you sign in however you like — Google, Apple, Microsoft, email — and the
 * resulting ChatGPT session is copied into gpt-image-mcp's own browser profile.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { systemBrowsers } from "./chrome-path.js";
import { chromium } from "playwright";
import { BrowserManager } from "./browser.js";
import { config, log } from "./config.js";
import { getSession, newChatUrl, type SessionInfo } from "./chatgpt.js";

export function findSystemChrome(): string | null {
  if (process.env.GPT_IMAGE_LOGIN_BROWSER) return process.env.GPT_IMAGE_LOGIN_BROWSER;
  return systemBrowsers()[0] ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Login through the user's own Chrome; returns the session once signed in. */
export async function loginWithSystemChrome(chromePath: string): Promise<SessionInfo> {
  const port = Number(process.env.GPT_IMAGE_LOGIN_PORT) || (await freePort());
  const userDir = path.join(config.home, "login-chrome");
  fs.mkdirSync(userDir, { recursive: true });
  const proc = spawn(
    chromePath,
    [
      `--user-data-dir=${userDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome refuses to start as root (e.g. in containers) without this.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      newChatUrl(),
    ],
    { stdio: "ignore", detached: false },
  );
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
  try {
    for (let i = 0; i < 60 && !browser; i++) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
      if (!browser) await new Promise((r) => setTimeout(r, 500));
    }
    if (!browser) throw new Error("Could not talk to the Chrome window that was opened.");
    console.log("Chrome opened. Sign in to ChatGPT there (Google / Apple / Microsoft / email all work).");
    console.log("This finishes automatically once you're logged in…");
    const ctx = browser.contexts()[0];
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error("Chrome was closed before sign-in completed.");
      const page = ctx.pages().find((p) => p.url().startsWith(config.baseUrl));
      if (page) {
        const s = await getSession(page).catch(() => ({ loggedIn: false }) as SessionInfo);
        if (s.loggedIn) {
          const state = await ctx.storageState();
          const target = new BrowserManager();
          try {
            const tctx = await target.context();
            const host = new URL(config.baseUrl).hostname;
            await tctx.addCookies(state.cookies.filter((c) => /(^|\.)(chatgpt\.com|openai\.com)$/.test(c.domain.replace(/^\./, "")) || c.domain.replace(/^\./, "") === host));
          } finally {
            await target.close();
          }
          return s;
        }
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error("Timed out waiting for login (15 min).");
  } finally {
    await browser?.close().catch(() => {});
    if (proc.exitCode === null) proc.kill();
  }
}

/** Fallback: sign in inside the Playwright-controlled window. */
export async function loginWithPlaywrightWindow(): Promise<SessionInfo> {
  const browser = new BrowserManager({ forceHeaded: true });
  try {
    const page = await browser.newPage();
    await page.goto(newChatUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    console.log("A browser window opened. Sign in to ChatGPT there.");
    console.log("(If Google says the browser isn't secure, sign in with email/Apple, or install Google Chrome and re-run login.)");
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("Login window was closed before sign-in completed.");
      const s = await getSession(page).catch(() => ({ loggedIn: false }) as SessionInfo);
      if (s.loggedIn) {
        await new Promise((r) => setTimeout(r, 2000)); // let cookies flush to disk
        return s;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    throw new Error("Timed out waiting for login (15 min).");
  } finally {
    await browser.close();
  }
}

export async function runLogin(): Promise<SessionInfo> {
  const chrome = findSystemChrome();
  if (chrome) {
    log(`using your installed browser for sign-in: ${chrome}`);
    return loginWithSystemChrome(chrome);
  }
  return loginWithPlaywrightWindow();
}
