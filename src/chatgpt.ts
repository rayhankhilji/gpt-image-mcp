/**
 * Low-level driver for one chatgpt.com tab.
 *
 * Strategy (cheap + robust):
 *  - SEND through the real UI (types into the composer, clicks send). That way ChatGPT's own
 *    front-end produces the anti-bot tokens (sentinel / proof-of-work / Turnstile) and your
 *    plan's image quota is used — not API credits.
 *  - READ through ChatGPT's own JSON endpoints, called from inside the page so they carry your
 *    session: /backend-api/conversation/{id} for status, /backend-api/files/... for full-res
 *    downloads. No screenshots, no vision, no DOM scraping unless the API is unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { config, debug } from "./config.js";
import { SEL, css, IMAGE_PENDING_TEXT } from "./selectors.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NotLoggedInError extends Error {
  constructor(msg = "Not logged in to ChatGPT. Run `npx gpt-image-mcp login` (or import a session) first.") {
    super(msg);
    this.name = "NotLoggedInError";
  }
}

// ---------------------------------------------------------------------------
// Navigation & readiness
// ---------------------------------------------------------------------------

export function conversationIdFromUrl(url: string): string | null {
  const m = url.match(/\/c\/([0-9a-zA-Z-]{8,})/);
  return m ? m[1] : null;
}

/** Accepts a bare conversation id or any chatgpt.com URL containing /c/<id>. */
export function normalizeChatId(idOrUrl: string): string {
  const fromUrl = conversationIdFromUrl(idOrUrl);
  return fromUrl ?? idOrUrl.trim();
}

export function chatUrl(id: string): string {
  return `${config.baseUrl}/c/${id}`;
}

export function newChatUrl(model?: string): string {
  const m = model || config.model;
  return m ? `${config.baseUrl}/?model=${encodeURIComponent(m)}` : `${config.baseUrl}/`;
}

export async function openUrl(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await ensureReady(page);
}

/** Waits out Cloudflare, verifies login, waits for the composer. */
export async function ensureReady(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (/just a moment|attention required|verify you are human/i.test(await page.title().catch(() => ""))) {
    if (Date.now() > deadline) {
      throw new Error(
        "Stuck on a Cloudflare 'verify you are human' check. Run with GPT_IMAGE_HEADLESS=0 GPT_IMAGE_WINDOW=normal and complete it once in the window, " +
          "or run on a different network (datacenter IPs are checked more often).",
      );
    }
    await sleep(1500);
  }

  const session = await getSession(page);
  if (!session.loggedIn) throw new NotLoggedInError();
  const composer = page.locator(css(SEL.composer)).first();
  try {
    await composer.waitFor({ state: "visible", timeout: 60_000 });
  } catch (err) {
    throw new Error(`ChatGPT composer never appeared (${(err as Error).message.split("\n")[0]}). Selectors in src/selectors.ts may need updating.`);
  }
  await dismissOverlays(page);
}

/** Closes upsell / "what's new" dialogs that would swallow clicks. */
async function dismissOverlays(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"]').first();
  if (await dialog.isVisible().catch(() => false)) {
    const btn = dialog
      .getByRole("button", { name: /^(maybe later|not now|dismiss|got it|close|no thanks|skip|okay|ok)$/i })
      .first();
    if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press("Escape").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// In-page API access (uses the logged-in session; never leaves the browser)
// ---------------------------------------------------------------------------

export interface ApiResult {
  ok: boolean;
  status: number;
  json: any;
  text?: string;
}

export async function apiGet(page: Page, apiPath: string): Promise<ApiResult> {
  return page.evaluate(async (p: string) => {
    const w = window as any;
    async function token(force: boolean): Promise<string | null> {
      if (!force && w.__gimTok && Date.now() - w.__gimTokAt < 240_000) return w.__gimTok;
      try {
        const r = await fetch("/api/auth/session", { credentials: "include" });
        const s = r.ok ? await r.json() : null;
        w.__gimTok = (s && s.accessToken) || null;
      } catch {
        w.__gimTok = null;
      }
      w.__gimTokAt = Date.now();
      return w.__gimTok;
    }
    async function go(force: boolean): Promise<Response> {
      const t = await token(force);
      const h: Record<string, string> = { accept: "application/json" };
      if (t) h.authorization = "Bearer " + t;
      const m = document.cookie.match(/(?:^|; )oai-did=([^;]+)/);
      if (m) h["oai-device-id"] = decodeURIComponent(m[1]);
      return fetch(p, { headers: h, credentials: "include" });
    }
    let r = await go(false);
    if (r.status === 401 || r.status === 403) r = await go(true);
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { ok: r.ok, status: r.status, json, text: json ? undefined : text.slice(0, 300) };
  }, apiPath);
}

export interface SessionInfo {
  loggedIn: boolean;
  email?: string;
  name?: string;
  plan?: string;
  expires?: string;
}

export async function getSession(page: Page): Promise<SessionInfo> {
  const s = await page
    .evaluate(async () => {
      try {
        const r = await fetch("/api/auth/session", { credentials: "include" });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (!s || !s.accessToken) return { loggedIn: false };
  return {
    loggedIn: true,
    email: s.user?.email,
    name: s.user?.name,
    plan: s.account?.planType ?? s.account?.plan_type,
    expires: s.expires,
  };
}

export async function fetchConversation(page: Page, id: string): Promise<ApiResult> {
  return apiGet(page, `/backend-api/conversation/${id}`);
}

// ---------------------------------------------------------------------------
// Conversation JSON analysis
// ---------------------------------------------------------------------------

interface Msg {
  id: string;
  author?: { role?: string };
  content?: { content_type?: string; parts?: any[]; text?: string };
  status?: string;
  end_turn?: boolean | null;
  recipient?: string;
  metadata?: Record<string, any>;
  create_time?: number | null;
}
interface Node {
  id: string;
  message?: Msg | null;
  parent?: string | null;
  children?: string[];
}
export interface Conversation {
  title?: string;
  current_node?: string;
  mapping: Record<string, Node>;
}

export interface ConvImage {
  pointer: string;
  width?: number;
  height?: number;
  messageId: string;
}

export interface TurnState {
  registered: boolean;
  images: ConvImage[];
  text: string;
  asyncPending: boolean;
  endTurn: boolean;
}

function isVisibleUser(m: Msg | null | undefined): boolean {
  return (
    !!m &&
    m.author?.role === "user" &&
    !m.metadata?.is_visually_hidden_from_conversation &&
    ["text", "multimodal_text"].includes(m.content?.content_type ?? "")
  );
}

function branchNodes(c: Conversation): Node[] {
  const out: Node[] = [];
  const seen = new Set<string>();
  let id = c.current_node;
  while (id && c.mapping[id] && !seen.has(id)) {
    seen.add(id);
    out.push(c.mapping[id]);
    id = c.mapping[id].parent ?? undefined;
  }
  return out.reverse();
}

export function countUserMessages(c: Conversation): number {
  return branchNodes(c).filter((n) => isVisibleUser(n.message)).length;
}

function isAsyncImageMarker(md: Record<string, any> | undefined): boolean {
  if (!md) return false;
  return Boolean(
    md.image_gen_async ||
      md.image_gen_task_id ||
      md.trigger_async_ux ||
      (typeof md.async_task_type === "string" && /image/i.test(md.async_task_type)),
  );
}

/** Looks at everything the assistant produced after our (baseUserCount+1)-th user message. */
export function analyzeTurn(c: Conversation, baseUserCount: number): TurnState {
  const empty: TurnState = { registered: false, images: [], text: "", asyncPending: false, endTurn: false };
  if (!c?.mapping) return empty;
  const users = branchNodes(c).filter((n) => isVisibleUser(n.message));
  if (users.length <= baseUserCount) return empty;
  const ours = users[users.length - 1];

  // All descendants of our message (not just the current branch — async images can land on a side node).
  const msgs: Msg[] = [];
  const stack = [...(ours.children ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = c.mapping[id];
    if (!n) continue;
    if (n.message) {
      if (isVisibleUser(n.message)) continue; // a later turn — not ours
      msgs.push(n.message);
    }
    stack.push(...(n.children ?? []));
  }
  msgs.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));

  const images: ConvImage[] = [];
  const seenPtr = new Set<string>();
  const texts: string[] = [];
  for (const m of msgs) {
    const parts = m.content?.parts ?? [];
    for (const part of parts) {
      if (part && typeof part === "object" && part.content_type === "image_asset_pointer" && part.asset_pointer) {
        if (!seenPtr.has(part.asset_pointer)) {
          seenPtr.add(part.asset_pointer);
          images.push({ pointer: part.asset_pointer, width: part.width, height: part.height, messageId: m.id });
        }
      } else if (
        typeof part === "string" &&
        part.trim() &&
        m.author?.role === "assistant" &&
        (!m.recipient || m.recipient === "all")
      ) {
        texts.push(part.trim());
      }
    }
  }
  const lastAssistant = [...msgs].reverse().find((m) => m.author?.role === "assistant");
  return {
    registered: true,
    images,
    text: texts.join("\n\n"),
    asyncPending: msgs.some((m) => isAsyncImageMarker(m.metadata)),
    endTurn: lastAssistant?.end_turn === true,
  };
}

// ---------------------------------------------------------------------------
// DOM signals (secondary — used for "still streaming" and as a fallback)
// ---------------------------------------------------------------------------

export interface PageSignals {
  generating: boolean;
  imagePendingText: boolean;
  domImages: string[];
  userMessages: number;
  errorText: string;
}

export async function pageSignals(page: Page): Promise<PageSignals> {
  return page.evaluate(
    ({ stop, user, img, pendingSrc }) => {
      const pending = new RegExp(pendingSrc, "i");
      const users = document.querySelectorAll(user);
      const last = users[users.length - 1];
      const after = (el: Element) =>
        !last || (!!(last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !last.contains(el));
      const domImages = Array.from(new Set(
        Array.from(document.querySelectorAll<HTMLImageElement>(img))
          .filter(after)
          .filter((i) => i.complete && i.naturalWidth >= 256 && !getComputedStyle(i).filter.includes("blur"))
          .map((i) => i.currentSrc || i.src),
      ));
      const turnText = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], article'))
        .filter(after)
        .map((e) => (e as HTMLElement).innerText || "")
        .join("\n");
      const err = Array.from(document.querySelectorAll('[role="alert"], .text-token-text-error, [class*="text-red"]'))
        .map((e) => (e as HTMLElement).innerText?.trim())
        .filter(Boolean)
        .join(" | ")
        .slice(0, 400);
      return {
        generating: !!document.querySelector(stop),
        imagePendingText: pending.test(turnText),
        domImages,
        userMessages: users.length,
        errorText: err,
      };
    },
    { stop: css(SEL.stopButton), user: css(SEL.userMessage), img: css(SEL.generatedImage), pendingSrc: IMAGE_PENDING_TEXT.source },
  );
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** First selector (in priority order) that matches something visible; falls back to the joined list. */
async function locate(page: Page, list: string[], { visible = true } = {}) {
  for (const sel of list) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      if (!visible || (await loc.nth(i).isVisible().catch(() => false))) return loc.nth(i);
    }
  }
  return page.locator(css(list)).first();
}

export async function sendPrompt(page: Page, prompt: string, files: string[] = []): Promise<void> {
  await page.locator(css(SEL.composer)).first().waitFor({ state: "visible", timeout: 60_000 });
  const composer = await locate(page, SEL.composer);

  if (files.length) {
    const input = await locate(page, SEL.fileInput, { visible: false });
    await input.setInputFiles(files);
    await sleep(1500); // let the upload state kick in so the send button disables
  }

  // Focus via DOM (immune to overlays), clear, then type. insertText = one input event, not N keystrokes.
  await composer.evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  const lines = prompt.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press("Shift+Enter");
  }

  // Wait for send to become enabled (it stays disabled while attachments upload).
  const deadline = Date.now() + 120_000;
  let clicked = false;
  while (Date.now() < deadline) {
    const send = await locate(page, SEL.sendButton, { visible: false });
    const ready = await send
      .evaluate((b) => {
        const el = b as HTMLButtonElement;
        const r = el.getBoundingClientRect();
        return !el.hidden && r.width > 0 && !el.disabled && el.getAttribute("aria-disabled") !== "true";
      }, undefined, { timeout: 1000 })
      .catch(() => false);
    if (ready) {
      // force: skip Playwright's "stable" check, which waits on animation frames that background tabs never render.
      // Still a real (trusted) mouse click dispatched via CDP.
      await send.click({ timeout: 5000, force: true }).then(
        () => (clicked = true),
        () => {},
      );
      if (clicked) break;
    }
    await sleep(300);
  }
  if (!clicked) {
    await composer.evaluate((el) => (el as HTMLElement).focus());
    await page.keyboard.press("Enter");
  }

  // Confirm the message actually left: composer empties, stop button shows, or URL becomes /c/<id>.
  // Polled from Node — in-page timers are throttled in background tabs.
  let ok = false;
  const confirmDeadline = Date.now() + 30_000;
  while (!ok && Date.now() < confirmDeadline) {
    ok = await page
      .evaluate(
        ({ comp, stop }) => {
          const c = document.querySelector(comp) as HTMLElement | null;
          const empty = !c || ((c as HTMLTextAreaElement).value ?? c.innerText ?? "").trim() === "";
          return empty || !!document.querySelector(stop) || /\/c\/[0-9a-zA-Z-]{8,}/.test(location.pathname);
        },
        { comp: css(SEL.composer), stop: css(SEL.stopButton) },
      )
      .catch(() => false);
    if (!ok) await sleep(250);
  }
  if (!ok) {
    const sig = await pageSignals(page).catch(() => null);
    throw new Error(`Prompt did not send.${sig?.errorText ? " Page says: " + sig.errorText : ""}`);
  }
}

export async function waitForConversationId(page: Page, timeoutMs = 90_000): Promise<string> {
  const existing = conversationIdFromUrl(page.url());
  if (existing) return existing;
  await page.waitForURL(/\/c\/[0-9a-zA-Z-]{8,}/, { timeout: timeoutMs });
  return conversationIdFromUrl(page.url())!;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

export async function resolvePointer(page: Page, pointer: string, conversationId: string): Promise<string> {
  const fileId = pointer.replace(/^[a-z-]+:\/\//i, "");
  const a = `/backend-api/files/download/${fileId}?conversation_id=${conversationId}&inline=false`;
  const b = `/backend-api/files/${fileId}/download`;
  const candidates = pointer.startsWith("sediment://") ? [a, b] : [b, a];
  let last = "";
  for (const u of candidates) {
    const r = await apiGet(page, u);
    if (r.ok && r.json?.download_url) return r.json.download_url as string;
    last = `${r.status} ${r.text ?? JSON.stringify(r.json)?.slice(0, 200)}`;
  }
  throw new Error(`Could not resolve download URL for ${pointer}: ${last}`);
}

export async function downloadUrl(page: Page, url: string): Promise<Buffer> {
  const abs = new URL(url, config.baseUrl).toString();
  const sameOrigin = abs.startsWith(config.baseUrl);
  if (!sameOrigin) {
    // Signed CDN URL — fetch from Node (no CORS issues).
    try {
      const r = await page.context().request.get(abs, { timeout: 120_000 });
      if (r.ok()) return Buffer.from(await r.body());
      debug("node fetch failed", r.status(), abs);
    } catch (err) {
      debug("node fetch error", err);
    }
  }
  const b64 = await page.evaluate(
    async ({ u, same }) => {
      const r = await fetch(u, { credentials: same ? "include" : "omit" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { u: abs, same: sameOrigin },
  );
  return Buffer.from(b64, "base64");
}

export function sniffExt(buf: Buffer): string {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "gif";
  return "png";
}

export function imageSize(buf: Buffer): { width?: number; height?: number } {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(12, 16).toString() === "VP8X")
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

// ---------------------------------------------------------------------------
// Debug capture
// ---------------------------------------------------------------------------

export async function captureDebug(page: Page, tag: string): Promise<string | undefined> {
  try {
    fs.mkdirSync(config.debugDir, { recursive: true });
    const base = path.join(config.debugDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}`);
    await page.screenshot({ path: `${base}.png`, fullPage: false, timeout: 10_000 });
    fs.writeFileSync(`${base}.html`, await page.content());
    return `${base}.png`;
  } catch (err) {
    debug("captureDebug failed", err);
    return undefined;
  }
}
