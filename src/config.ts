import os from "node:os";
import path from "node:path";

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function int(v: string | undefined, def: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

const env = process.env;
const home = env.GPT_IMAGE_HOME || path.join(os.homedir(), ".gpt-image-mcp");

export type WindowMode = "normal" | "minimized" | "offscreen";

export const config = {
  /** Root folder for the browser profile, state and default image output. */
  home,
  /** Persistent Chrome profile (holds your ChatGPT login). */
  profileDir: env.GPT_IMAGE_PROFILE_DIR || path.join(home, "profile"),
  /** Where images are saved unless a tool call passes output_dir. */
  outputDir: env.GPT_IMAGE_OUTPUT_DIR || path.join(home, "images"),
  statePath: path.join(home, "state.json"),
  debugDir: env.GPT_IMAGE_DEBUG_DIR || path.join(home, "debug"),

  /** Overridable for testing against a mock. */
  baseUrl: (env.GPT_IMAGE_BASE_URL || "https://chatgpt.com").replace(/\/+$/, ""),

  /** Attach to an already-running Chrome (started with --remote-debugging-port) instead of launching one. */
  cdpUrl: env.GPT_IMAGE_CDP_URL || "",
  /** "chrome" (installed Google Chrome — best for Google sign-in & Cloudflare), "msedge", or "chromium" (Playwright's bundled build). */
  channel: env.GPT_IMAGE_BROWSER_CHANNEL ?? "chrome",
  executablePath: env.GPT_IMAGE_EXECUTABLE_PATH || "",
  /**
   * undefined = auto: a real (headed) Chrome window that starts minimized. On a Linux box with no
   * screen (servers, cloud agents) a virtual display (Xvfb) is started if available, else headless.
   * `login` always opens a window regardless.
   */
  headless: env.GPT_IMAGE_HEADLESS === undefined || env.GPT_IMAGE_HEADLESS === "" ? undefined : bool(env.GPT_IMAGE_HEADLESS, false),
  window: ((env.GPT_IMAGE_WINDOW || "minimized").toLowerCase() as WindowMode),
  /** Pretend every tab is visible/focused so background tabs aren't throttled by the page. */
  forceVisible: bool(env.GPT_IMAGE_FORCE_VISIBLE, true),

  /** Max chats generating at the same time. Extra jobs are queued. */
  maxConcurrency: Math.max(1, int(env.GPT_IMAGE_MAX_CONCURRENCY, 10)),
  /** Ready-to-type ChatGPT tabs kept loaded by the server so new jobs start instantly. */
  warmTabs: Math.max(0, int(env.GPT_IMAGE_WARM_TABS, 4)),
  /** Finished chats kept open as tabs so edits start instantly. */
  maxIdleTabs: Math.max(0, int(env.GPT_IMAGE_MAX_IDLE_TABS, 4)),
  /** Minimum gap between two prompt submissions (keeps bursts human-ish). */
  sendGapMs: Math.max(0, int(env.GPT_IMAGE_SEND_GAP_MS, 250)),
  /**
   * Longest a single MCP tool call blocks before returning partial results. Some clients
   * (e.g. Claude Code on the web) abort tool calls after 60 s; jobs keep running in the background
   * and the agent collects them with wait_for_jobs. Raise it if your client allows longer calls.
   */
  maxCallWaitSec: Math.max(5, int(env.GPT_IMAGE_MAX_CALL_WAIT, 50)),
  /** Minimum gap between ANY two ChatGPT data requests from this process (status checks, downloads). */
  apiGapMs: Math.max(100, int(env.GPT_IMAGE_API_GAP_MS, 300)),
  /** Max ChatGPT pages loading at once (each load fires ~25 requests at ChatGPT). */
  maxPageLoads: Math.max(1, int(env.GPT_IMAGE_MAX_PAGE_LOADS, 8)),
  /** Default per-job timeout. */
  timeoutSec: Math.max(30, int(env.GPT_IMAGE_TIMEOUT, 600)),
  /** Optional model slug appended as ?model= on new chats (e.g. "gpt-4o", "gpt-5"). Empty = account default. */
  model: env.GPT_IMAGE_MODEL || "",

  debug: bool(env.GPT_IMAGE_DEBUG, false),
};

export function log(...args: unknown[]): void {
  // stdout is reserved for the MCP protocol — always log to stderr.
  console.error("[gpt-image-mcp]", ...args);
}

export function debug(...args: unknown[]): void {
  if (config.debug) console.error("[gpt-image-mcp:debug]", ...args);
}
