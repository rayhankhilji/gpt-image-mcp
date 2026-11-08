import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config, log, debug } from "./config.js";
import { seedFromEnv } from "./session.js";

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
      const headless = this.opts.forceHeaded ? false : config.headless;
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
      else if (config.channel && config.channel !== "chromium") attempts.push({ channel: config.channel }, {});
      else attempts.push({});

      let lastErr: unknown;
      ctx = undefined as unknown as BrowserContext;
      for (const extra of attempts) {
        try {
          ctx = await chromium.launchPersistentContext(config.profileDir, { ...base, ...extra });
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
          if (extra.channel) log(`could not launch channel "${String(extra.channel)}" (${msg.split("\n")[0]}); falling back to bundled Chromium`);
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
    this.ctx = ctx;

    if (!config.cdpUrl) {
      try {
        if (await seedFromEnv(ctx)) log("loaded ChatGPT login from GPT_IMAGE_SESSION");
      } catch (err) {
        log(`could not load GPT_IMAGE_SESSION: ${(err as Error).message}`);
      }
    }

    if (!config.cdpUrl && !config.headless && config.window === "minimized") {
      const p = ctx.pages()[0] ?? (await ctx.newPage());
      await minimizeWindow(p).catch((e) => debug("minimize failed", e));
    }
    return ctx;
  }

  async newPage(): Promise<Page> {
    const ctx = await this.context();
    // Reuse the blank tab Chrome opens on launch.
    const blank = ctx.pages().find((p) => !this.ownedPages.has(p) && (p.url() === "about:blank" || p.url() === "chrome://newtab/"));
    const page = blank && !config.cdpUrl ? blank : await ctx.newPage();
    this.ownedPages.add(page);
    page.on("close", () => this.ownedPages.delete(page));
    if (config.forceVisible) await page.addInitScript(FORCE_VISIBLE_SCRIPT);
    if (!config.cdpUrl && !this.opts.forceHeaded && !config.headless && config.window === "minimized") {
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
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      if (config.cdpUrl) {
        // Never close the user's own browser — only the tabs we opened.
        for (const p of this.ownedPages) await p.close().catch(() => {});
        await this.browser?.close().catch(() => {});
      } else {
        await ctx.close();
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
