import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config, log, debug } from "./config.js";
import { seedFromEnv } from "./session.js";
import { getSession, watchActivity } from "./chatgpt.js";
import { preinstalledChromium, systemBrowsers } from "./chrome-path.js";
import { ensureVirtualDisplay, stopVirtualDisplay } from "./display.js";

const LAUNCH_ARGS = [
  // Keep background tabs running at full speed so 10-20 chats can generate in parallel.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  "--no-first-run",
  "--no-default-browser-check",
];

/** Runs in every page before ChatGPT's own scripts. */
const FORCE_VISIBLE_SCRIPT = `(() => {
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get() { return 'visible'; }, configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get() { return false; }, configurable: true });
    Document.prototype.hasFocus = function () { return true; };
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
  } catch (_) {}
})();`;

export class BrowserManager {
  private ctx: BrowserContext | null = null;
  private browser: Browser | null = null;
  private starting: Promise<BrowserContext> | null = null;
  private ownedPages = new Set<Page>();
  private headless = false;
  private launchArgs: string[] = [];
  private launchExtra: Record<string, unknown> = {};
  private workerBrowser: Browser | null = null;
  private workerStarting: Promise<Browser> | null = null;

  constructor(private opts: { forceHeaded?: boolean } = {}) {}

  get isRunning(): boolean {
    return this.ctx !== null;
  }

  async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<BrowserContext> {
    let ctx: BrowserContext;
    if (config.cdpUrl) {
      log(`connecting to existing Chrome at ${config.cdpUrl}`);
      this.browser = await chromium.connectOverCDP(config.cdpUrl);
      ctx = this.browser.contexts()[0] ?? (await this.browser.newContext());
    } else {
      fs.mkdirSync(config.profileDir, { recursive: true });
      let headless: boolean;
      if (this.opts.forceHeaded) headless = false;
      else if (config.headless !== undefined) headless = config.headless;
      else headless = !(await ensureVirtualDisplay());
      this.headless = headless;
      const args = [...LAUNCH_ARGS];
      if (!headless && config.window === "offscreen") args.push("--window-position=-32000,-32000");
      const base = {
        headless,
        viewport: null,
        args,
        acceptDownloads: true,
      };

      const attempts: Array<Record<string, unknown>> = [];
      if (config.executablePath) attempts.push({ executablePath: config.executablePath });
      else {
        if (config.channel && config.channel !== "chromium") attempts.push({ channel: config.channel });
        attempts.push({}); // Playwright's own Chromium, if installed
        // Then any Chrome/Chromium already on the machine (incl. cloud images with a pre-installed Chromium).
        for (const p of [...systemBrowsers(), ...preinstalledChromium()]) attempts.push({ executablePath: p });
      }

      let lastErr: unknown;
      ctx = undefined as unknown as BrowserContext;
      for (const extra of attempts) {
        try {
          ctx = await chromium.launchPersistentContext(config.profileDir, { ...base, ...extra });
          this.launchArgs = args;
          this.launchExtra = extra;
          debug("launched browser", extra);
          break;
        } catch (err) {
          lastErr = err;
          const msg = String((err as Error)?.message ?? err);
          if (/ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(msg)) {
            throw new Error(
              `The browser profile at ${config.profileDir} is already in use (another gpt-image-mcp instance or the login window is open). ` +
                `Close it, or point this instance at a different profile with GPT_IMAGE_PROFILE_DIR.`,
            );
          }
          debug(`launch attempt ${JSON.stringify(extra)} failed: ${msg.split("\n")[0]}`);
        }
      }
      if (!ctx) {
        throw new Error(
          `Failed to launch a browser: ${String((lastErr as Error)?.message ?? lastErr)}\n` +
            `Install Google Chrome, or run "npx playwright install chromium", or set GPT_IMAGE_EXECUTABLE_PATH.`,
        );
      }
    }

    ctx.on("close", () => {
      this.ctx = null;
      this.browser = null;
      this.ownedPages.clear();
    });

    if (!config.cdpUrl) {
      try {
        if (await seedFromEnv(ctx, () => this.firstVisit(ctx))) {
          await this.confirmLogin(ctx);
          log("loaded ChatGPT login from GPT_IMAGE_SESSION");
        }
      } catch (err) {
        log(`could not load GPT_IMAGE_SESSION: ${(err as Error).message}`);
      }
    }
    // Only now is the context handed out: callers of context() wait for the login to be in place.
    this.ctx = ctx;

    if (!config.cdpUrl && !this.headless && !this.opts.forceHeaded && config.window === "minimized") {
      const p = ctx.pages()[0] ?? (await ctx.newPage());
      await minimizeWindow(p).catch((e) => debug("minimize failed", e));
    }
    return ctx;
  }

  /**
   * A brand-new profile opens ChatGPT once as an ordinary signed-out visitor BEFORE the login from
   * GPT_IMAGE_SESSION is added. The browser then holds Cloudflare cookies it earned itself on this
   * machine. A fresh profile that arrives already carrying a login from another machine is far more
   * likely to be shown the "verify you are human" page, which nothing here can or should answer.
   * Disable with GPT_IMAGE_FIRST_VISIT=0.
   */
  private async firstVisit(ctx: BrowserContext): Promise<void> {
    if (!config.firstVisit) return;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await page.goto(config.baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const names = (await ctx.cookies(config.baseUrl)).map((c) => c.name);
        if (names.includes("__cf_bm") || names.includes("cf_clearance")) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(config.firstVisitSettleMs);
      debug("first visit done", page.url());
    } catch (err) {
      debug(`first visit failed: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      await page.goto("about:blank").catch(() => {}); // leave the tab blank so newPage() can reuse it
    }
  }

  /**
   * After the login is added, load ChatGPT once in the profile and wait until it answers as signed in.
   * Jobs run in separate contexts that copy the profile's cookies; without this the first job can
   * start in the moment before the new login has taken and fail with "not logged in".
   */
  private async confirmLogin(ctx: BrowserContext): Promise<void> {
    if (!config.firstVisit) return;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await page.goto(config.baseUrl + "/", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if ((await getSession(page)).loggedIn) break;
        await page.waitForTimeout(1000);
      }
      await page.waitForTimeout(1500);
    } catch (err) {
      debug(`login confirmation failed: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      await page.goto("about:blank").catch(() => {});
    }
  }

  /**
   * A page in its OWN browser context (like a separate incognito window) carrying the login cookies.
   * ChatGPT's web app shares a single "new chat in progress" slot across tabs of one profile, so
   * parallel new chats in ordinary tabs collide (placeholder /c/local-chatgpt, locked send button).
   * Separate contexts have separate storage, so 10-20 chats can start at the same moment.
   */
  async newIsolatedPage(): Promise<Page> {
    const main = await this.context();
    const browser = await this.workers();
    const wctx = await browser.newContext({
      viewport: this.headless ? { width: 1280, height: 900 } : null,
      acceptDownloads: true,
    });
    const cookies = await main.cookies();
    if (cookies.length) await wctx.addCookies(cookies);
    const page = await wctx.newPage();
    watchActivity(page); // attach before the page opens its websocket
    this.ownedPages.add(page);
    page.on("close", () => {
      this.ownedPages.delete(page);
      // Keep the saved login fresh: copy any rotated session cookies back into the profile.
      void wctx
        .cookies()
        .then((c) => (this.ctx ? this.ctx.addCookies(c.filter((x) => /session-token|oai-/.test(x.name))) : undefined))
        .catch(() => {})
        .finally(() => wctx.close().catch(() => {}));
    });
    if (config.forceVisible) await page.addInitScript(FORCE_VISIBLE_SCRIPT);
    if (!config.cdpUrl && !this.headless && config.window === "minimized") {
      await minimizeWindow(page).catch((e) => debug("minimize failed", e));
    }
    page.setDefaultTimeout(30_000);
    return page;
  }

  private async workers(): Promise<Browser> {
    if (this.workerBrowser?.isConnected()) return this.workerBrowser;
    if (config.cdpUrl && this.browser) return this.browser; // CDP browsers can create contexts directly
    if (!this.workerStarting) {
      this.workerStarting = chromium
        .launch({ headless: this.headless, args: this.launchArgs, ...this.launchExtra })
        .then((b) => {
          this.workerBrowser = b;
          b.on("disconnected", () => (this.workerBrowser = null));
          return b;
        })
        .finally(() => (this.workerStarting = null));
    }
    return this.workerStarting;
  }

  async newPage(): Promise<Page> {
    const ctx = await this.context();
    // Reuse the blank tab Chrome opens on launch.
    const blank = ctx.pages().find((p) => !this.ownedPages.has(p) && (p.url() === "about:blank" || p.url() === "chrome://newtab/"));
    const page = blank && !config.cdpUrl ? blank : await ctx.newPage();
    this.ownedPages.add(page);
    page.on("close", () => this.ownedPages.delete(page));
    if (config.forceVisible) await page.addInitScript(FORCE_VISIBLE_SCRIPT);
    if (!config.cdpUrl && !this.opts.forceHeaded && !this.headless && config.window === "minimized") {
      await minimizeWindow(page).catch((e) => debug("minimize failed", e));
    }
    page.setDefaultTimeout(30_000);
    return page;
  }

  private utility: Page | null = null;

  /**
   * Shrinks an image to a small JPEG using the browser's canvas — lets the agent *see* results
   * for a few hundred tokens instead of shipping multi-MB PNGs. No native deps needed.
   */
  async makePreview(buf: Buffer, maxPx = 768, quality = 0.82): Promise<Buffer> {
    if (!this.utility || this.utility.isClosed()) {
      const ctx = await this.context();
      this.utility = await ctx.newPage();
      this.ownedPages.add(this.utility);
    }
    const b64 = await this.utility.evaluate(
      async ({ data, maxPx, quality }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes]));
        const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext("2d")!;
        g.fillStyle = "#fff"; // flatten transparency for JPEG
        g.fillRect(0, 0, w, h);
        g.drawImage(bmp, 0, 0, w, h);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        const out = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      { data: buf.toString("base64"), maxPx, quality },
    );
    return Buffer.from(b64, "base64");
  }

  async close(): Promise<void> {
    this.utility = null;
    const workers = this.workerBrowser;
    if (workers) {
      // Let page-close handlers copy cookies back before the profile closes.
      for (const p of [...this.ownedPages]) if (p.context() !== this.ctx) await p.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await workers.close().catch(() => {});
      this.workerBrowser = null;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (config.cdpUrl) {
        // Never close the user's own browser — only the tabs we opened.
        for (const p of this.ownedPages) await p.close().catch(() => {});
        await this.browser?.close().catch(() => {});
      } else {
        await ctx.close();
        stopVirtualDisplay();
      }
    } catch (err) {
      debug("close error", err);
    }
    this.ctx = null;
    this.browser = null;
  }
}

async function minimizeWindow(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const { windowId } = (await session.send("Browser.getWindowForTarget")) as { windowId: number };
  await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  await session.detach();
}
