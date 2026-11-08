import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { BrowserManager } from "./browser.js";
import { config, debug, log } from "./config.js";
import {
  activity,
  analyzeTurn,
  apiCoolingDown,
  captureDebug,
  chatUrl,
  conversationIdFromUrl,
  countUserMessages,
  downloadUrl,
  ensureReady,
  fetchConversation,
  imageSize,
  newChatUrl,
  normalizeChatId,
  openUrl,
  pageSignals,
  resolvePointer,
  sendPrompt,
  sniffExt,
  waitForConversationId,
  type TurnState,
} from "./chatgpt.js";
import { StateStore, type SavedImage } from "./state.js";

export type JobStatus =
  | "queued"
  | "opening"
  | "sending"
  | "generating"
  | "downloading"
  | "done"
  | "no_image"
  | "timeout"
  | "error";

const FINAL: JobStatus[] = ["done", "no_image", "timeout", "error"];

export interface JobSpec {
  kind: "generate" | "edit";
  prompt: string;
  /** Required for edits: conversation id or chatgpt.com/c/<id> URL. */
  chatId?: string;
  referenceImages?: string[];
  outputDir?: string;
  label?: string;
  aspectRatio?: string;
  transparent?: boolean;
  /** Send the prompt exactly as given (no "generate an image" wrapper). */
  raw?: boolean;
  model?: string;
  timeoutSec?: number;
}

export interface Job extends JobSpec {
  id: string;
  status: JobStatus;
  chatUrl?: string;
  images: SavedImage[];
  text?: string;
  error?: string;
  debugScreenshot?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  done: Promise<Job>;
}

const POLL_MS = 1000; // DOM check interval (local only, no requests)
const FIRST_CHECK_MS = 8_000; // first conversation check after sending (images take ~6-20 s)
const BACKSTOP_MS = 15_000; // conversation check at least this often per job, even with no signal
const MIN_FETCH_GAP_MS = 3_000; // ...and never more often than this per job
const DOM_STABLE_MS = 4_000;
const STABLE_MS = 5000; // image set must be unchanged this long
const TEXT_ONLY_GRACE_MS = 8_000; // text-only answer must sit idle this long before we call it "no_image"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Semaphore {
  private waiters: Array<() => void> = [];
  constructor(private free: number) {}
  get available(): number {
    return this.free;
  }
  get waiting(): number {
    return this.waiters.length;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

export class JobManager {
  readonly browser: BrowserManager;
  readonly state = new StateStore();
  private jobs = new Map<string, Job>();
  private sem = new Semaphore(config.maxConcurrency);
  private chatLocks = new Map<string, Promise<unknown>>();
  private idleTabs = new Map<string, Page>(); // chatId -> page (LRU by insertion order)
  private sendChain: Promise<unknown> = Promise.resolve();
  private warm: Array<{ page: Page; at: number }> = [];
  private warming = 0;
  private warmTarget = 0;
  private lastSendAt = 0;

  constructor(browser?: BrowserManager) {
    this.browser = browser ?? new BrowserManager();
  }

  // ---------------------------------------------------------------- public

  submit(spec: JobSpec): Job {
    if (spec.kind === "edit") {
      if (!spec.chatId) throw new Error("edit job needs chat_id");
      spec.chatId = normalizeChatId(spec.chatId);
    }
    for (const f of spec.referenceImages ?? []) {
      if (!fs.existsSync(f)) throw new Error(`reference image not found: ${f}`);
    }
    const id = "job_" + randomBytes(4).toString("hex");
    const job = { ...spec, id, status: "queued", images: [], createdAt: Date.now() } as unknown as Job;
    this.jobs.set(id, job);

    const run = async (): Promise<Job> => {
      await this.run(job);
      return job;
    };
    if (job.kind === "edit") {
      // One turn at a time per chat — queue behind any running edit on the same chat.
      const prev = this.chatLocks.get(job.chatId!) ?? Promise.resolve();
      const p = prev.catch(() => {}).then(run);
      this.chatLocks.set(job.chatId!, p);
      job.done = p;
    } else {
      job.done = run();
    }
    return job;
  }

  /**
   * Keep a few ChatGPT "new chat" tabs loaded and ready, so a prompt can be typed the instant a job
   * arrives (no browser start / page load on the critical path). Called by the long-running servers.
   */
  enablePrewarm(n = Math.min(config.warmTabs, config.maxConcurrency)): void {
    this.warmTarget = n;
    this.refillWarm();
  }

  private refillWarm(): void {
    while (this.warm.length + this.warming < this.warmTarget) {
      this.warming++;
      (async () => {
        const page = await this.browser.newIsolatedPage();
        try {
          await openUrl(page, newChatUrl());
          this.warm.push({ page, at: Date.now() });
        } catch (err) {
          await page.close().catch(() => {});
          throw err;
        }
      })()
        .catch((err) => {
          debug("prewarm failed:", (err as Error).message);
          this.warmTarget = 0; // e.g. not logged in — don't retry in a loop
        })
        .finally(() => this.warming--);
    }
  }

  /** A loaded, ready new-chat tab — from the warm pool when possible. */
  private async freshChatPage(model?: string): Promise<Page> {
    if (!model) {
      while (this.warm.length) {
        const { page, at } = this.warm.shift()!;
        const fresh = Date.now() - at < 20 * 60_000;
        if (fresh && !page.isClosed() && !conversationIdFromUrl(page.url())) {
          this.refillWarm();
          return page;
        }
        await page.close().catch(() => {});
      }
    }
    this.refillWarm();
    const page = await this.browser.newIsolatedPage();
    await openUrl(page, newChatUrl(model));
    return page;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  pending(): Job[] {
    return this.list().filter((j) => !FINAL.includes(j.status));
  }

  /** Resolves when all given jobs are final, or when timeoutMs elapses (whichever first). */
  async waitFor(jobs: Job[], timeoutMs: number, onTick?: (jobs: Job[]) => void): Promise<boolean> {
    const all = Promise.all(jobs.map((j) => j.done)).then(() => true);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const r = await Promise.race([all, sleep(Math.min(5000, remaining)).then(() => false)]);
      if (r) {
        onTick?.(jobs);
        return true;
      }
      onTick?.(jobs);
    }
    return jobs.every((j) => FINAL.includes(j.status));
  }

  stats() {
    return {
      running: config.maxConcurrency - this.sem.available,
      queued: this.sem.waiting,
      max_concurrency: config.maxConcurrency,
      idle_tabs: this.idleTabs.size,
      jobs_total: this.jobs.size,
    };
  }

  async shutdown(): Promise<void> {
    this.warmTarget = 0;
    this.state.flush();
    await this.browser.close();
  }

  /** Download every generated image in an existing chat (including ones made by hand in the UI). */
  async fetchChatImages(chatIdOrUrl: string, outputDir?: string): Promise<{ chat_id: string; title?: string; images: SavedImage[] }> {
    const chatId = normalizeChatId(chatIdOrUrl);
    const prev = this.chatLocks.get(chatId) ?? Promise.resolve();
    const work = prev.catch(() => {}).then(async () => {
      await this.sem.acquire();
      let page: Page | undefined;
      try {
        page = await this.takeTab(chatId);
        const r = await fetchConversation(page, chatId);
        if (!r.ok || !r.json?.mapping) throw new Error(`Could not load conversation ${chatId} (HTTP ${r.status})`);
        const pointers = new Set<string>();
        for (const node of Object.values<any>(r.json.mapping)) {
          const m = node?.message;
          if (!m || m.author?.role === "user") continue;
          for (const part of m.content?.parts ?? []) {
            if (part?.content_type === "image_asset_pointer" && part.asset_pointer) pointers.add(part.asset_pointer);
          }
        }
        const dir = this.resolveOutDir(outputDir);
        const images: SavedImage[] = [];
        let i = 0;
        for (const ptr of pointers) {
          i++;
          const url = await resolvePointer(page, ptr, chatId);
          const buf = await downloadUrl(page, url);
          images.push(this.saveImage(buf, dir, `${slug(r.json.title || "chat")}-${chatId.slice(0, 8)}-all-${i}`));
        }
        this.state.upsertChat(chatId, { url: chatUrl(chatId), title: r.json.title });
        this.releaseTab(chatId, page);
        page = undefined;
        return { chat_id: chatId, title: r.json.title as string | undefined, images };
      } finally {
        if (page) await page.close().catch(() => {});
        this.sem.release();
      }
    });
    this.chatLocks.set(chatId, work);
    return work;
  }

  // ---------------------------------------------------------------- internals

  private async run(job: Job): Promise<void> {
    job.status = this.sem.available > 0 ? "opening" : "queued";
    await this.sem.acquire();
    let page: Page | undefined;
    let keepTab = false;
    try {
      job.startedAt = Date.now();
      job.status = "opening";

      let baseUsers = 0;
      if (job.kind === "edit") {
        page = await this.takeTab(job.chatId!);
        const r = await fetchConversation(page, job.chatId!);
        if (r.ok && r.json?.mapping) baseUsers = countUserMessages(r.json);
        else {
          debug(`baseline via API failed (${r.status}); using DOM count`);
          baseUsers = (await pageSignals(page)).userMessages;
        }
      } else {
        page = await this.freshChatPage(job.model);
      }

      debug(`${job.id} page ready at +${Date.now() - job.createdAt}ms`);
      // Images already on the page before we send (earlier turns) — so only new ones count.
      const baselineDom = new Set((await pageSignals(page).catch(() => null))?.domImages ?? []);
      const prompt = buildPrompt(job);
      let chatId = "";
      for (let attempt = 1; ; attempt++) {
        job.status = "sending";
        await this.throttledSend(async () => {
          const t0 = Date.now();
          await sendPrompt(page!, prompt, job.referenceImages ?? []);
          debug(`${job.id} sent in ${Date.now() - t0}ms (at +${Date.now() - job.createdAt}ms)`);
        });
        job.status = "generating";
        try {
          chatId = job.kind === "edit" ? job.chatId! : await waitForConversationId(page);
          break;
        } catch (err) {
          // The send didn't create a chat (nothing was generated) — retry once in a fresh context.
          if (attempt >= 2) throw err;
          log(`${job.id}: ${(err as Error).message} — retrying in a fresh tab`);
          await page.close().catch(() => {});
          page = await this.freshChatPage(job.model);
        }
      }
      job.chatId = chatId;
      job.chatUrl = chatUrl(chatId);
      this.state.upsertChat(chatId, { url: job.chatUrl, label: job.kind === "generate" ? job.label : undefined });

      const outcome = await this.monitor(page, job, chatId, baseUsers, baselineDom);

      job.status = "downloading";
      const dir = this.resolveOutDir(job.outputDir);
      const turnNo = baseUsers + 1;
      const name = `${slug(job.label || this.state.getChat(chatId)?.label || job.prompt)}-${chatId.slice(0, 8)}-t${turnNo}`;
      const sources: Array<() => Promise<string>> =
        outcome.mode === "api"
          ? outcome.st!.images.map((img) => () => resolvePointer(page!, img.pointer, chatId))
          : outcome.domImages.map((src) => async () => src);
      for (let i = 0; i < sources.length; i++) {
        try {
          const buf = await downloadUrl(page, await sources[i]());
          job.images.push(this.saveImage(buf, dir, sources.length > 1 ? `${name}-${i + 1}` : name));
        } catch (err) {
          log(`download failed for ${job.id} image ${i + 1}: ${(err as Error).message}`);
          // Last resort: grab whatever the DOM is showing.
          const dom = (await pageSignals(page).catch(() => null))?.domImages ?? [];
          if (dom[i]) {
            const buf = await downloadUrl(page, dom[i]);
            job.images.push(this.saveImage(buf, dir, `${name}-${i + 1}`));
          }
        }
      }
      job.text = outcome.st?.text || undefined;
      job.status = job.images.length ? "done" : outcome.timedOut ? "timeout" : "no_image";
      if (outcome.title) this.state.upsertChat(chatId, { url: job.chatUrl, title: outcome.title });
      if (job.status === "timeout") {
        job.error = `No image after ${Math.round((Date.now() - job.startedAt) / 1000)}s. It may still finish — call get_chat_images later.`;
      }
      keepTab = true;
    } catch (err) {
      job.status = "error";
      job.error = (err as Error).message;
      log(`${job.id} failed: ${job.error}`);
      if (page && !page.isClosed()) job.debugScreenshot = await captureDebug(page, job.id);
    } finally {
      job.finishedAt = Date.now();
      if (job.chatId) {
        this.state.addTurn(job.chatId, {
          job_id: job.id,
          kind: job.kind,
          prompt: job.prompt,
          status: job.status,
          images: job.images,
          text: job.text,
          at: new Date().toISOString(),
        });
      }
      if (page && !page.isClosed()) {
        if (keepTab && job.chatId) this.releaseTab(job.chatId, page);
        else await page.close().catch(() => {});
      }
      this.sem.release();
    }
  }

  /**
   * Waits for the turn to finish while asking ChatGPT for as little as possible:
   *  - every second: read the page's own DOM + passive activity (free — zero requests)
   *  - a conversation-JSON check only when something changed, plus a rare backstop, all through
   *    the shared rate limiter (see apiGet) so many parallel chats never trip ChatGPT's 429s
   *  - if the data endpoint is unavailable/cooling down, finish from the images the page displays
   */
  private async monitor(
    page: Page,
    job: Job,
    chatId: string,
    baseUsers: number,
    baselineDom: Set<string>,
  ): Promise<{ mode: "api" | "dom"; st: TurnState | null; domImages: string[]; timedOut: boolean; title?: string }> {
    const deadline = (job.startedAt ?? Date.now()) + (job.timeoutSec ?? config.timeoutSec) * 1000;
    const t0 = Date.now();
    let st: TurnState | null = null;
    let title: string | undefined;
    let lastFetch = 0;
    let fetchSoon = t0 + FIRST_CHECK_MS;
    let lastAct = activity(page);
    let wasGenerating = true;
    let apiSig = "";
    let apiSigSince = 0;
    let domSig = "";
    let domSigSince = t0;
    let domImages: string[] = [];
    let quietSince = 0;

    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("The ChatGPT tab was closed while generating.");
      const now = Date.now();
      const signals = await pageSignals(page).catch(() => null);
      const generating = signals?.generating ?? false;
      const pendingText = signals?.imagePendingText ?? false;

      domImages = (signals?.domImages ?? []).filter((src) => !baselineDom.has(src));
      const dsig = domImages.join("|");
      if (dsig !== domSig) {
        domSig = dsig;
        domSigSince = now;
        if (domImages.length) fetchSoon = Math.min(fetchSoon, now + 1500);
      }
      const act = activity(page);
      if (act !== lastAct) {
        lastAct = act;
        fetchSoon = Math.min(fetchSoon, now + 2000);
      }
      if (wasGenerating && !generating) fetchSoon = Math.min(fetchSoon, now + 1500);
      wasGenerating = generating;

      // Conversation JSON: on a trigger or the backstop, never more than once per MIN_FETCH_GAP_MS per job.
      const due = now >= Math.min(fetchSoon, lastFetch + BACKSTOP_MS) && now - t0 >= 3000;
      if (due && now - lastFetch >= MIN_FETCH_GAP_MS && !apiCoolingDown()) {
        lastFetch = now;
        fetchSoon = Infinity;
        const r = await fetchConversation(page, chatId).catch(() => null);
        if (r?.ok && r.json?.mapping) {
          st = analyzeTurn(r.json, baseUsers);
          title = r.json.title ?? title;
          const sig = st.images.map((i) => i.pointer).join("|");
          if (sig !== apiSig) {
            apiSig = sig;
            apiSigSince = Date.now();
          }
          if (st.images.length && !st.endTurn) fetchSoon = Date.now() + STABLE_MS + 500;
        } else {
          debug(`${job.id}: conversation check ${r?.status ?? "error"}`);
        }
      }

      // Done (API): images present and ChatGPT marked the turn complete, or the set stayed put across checks.
      if (st?.images.length && !generating && (st.endTurn || (lastFetch > apiSigSince && Date.now() - apiSigSince >= STABLE_MS))) {
        return { mode: "api", st, domImages, timedOut: false, title };
      }

      // Done (page): new finished image(s) on screen and stable — no data endpoint needed.
      if (!st?.images.length && domImages.length && !generating && !pendingText && Date.now() - domSigSince >= DOM_STABLE_MS) {
        return { mode: "dom", st, domImages, timedOut: false, title };
      }

      // Text-only answer (refusal, limit reached, a question): ChatGPT says done, nothing pending, confirmed after a grace period.
      if (!st?.images.length && !domImages.length) {
        const apiSaysDone = st?.registered && !st.asyncPending && st.endTurn;
        if (apiSaysDone && !generating && !pendingText) {
          quietSince ||= Date.now();
          if (Date.now() - quietSince >= TEXT_ONLY_GRACE_MS) {
            if (lastFetch >= quietSince + TEXT_ONLY_GRACE_MS - 1000) return { mode: "api", st, domImages, timedOut: false, title };
            fetchSoon = 0;
          }
        } else {
          quietSince = 0;
        }
      }
      await sleep(POLL_MS);
    }
    return { mode: st?.images.length ? "api" : "dom", st, domImages, timedOut: true, title };
  }

  /** Serialises the "type + click send" step with a small gap, so a burst of 20 jobs looks human-paced. */
  private throttledSend<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.sendChain.then(async () => {
      const wait = this.lastSendAt + config.sendGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastSendAt = Date.now();
      }
    });
    this.sendChain = p.catch(() => {});
    return p;
  }

  private async takeTab(chatId: string): Promise<Page> {
    const idle = this.idleTabs.get(chatId);
    this.idleTabs.delete(chatId);
    if (idle && !idle.isClosed()) {
      try {
        await ensureReady(idle);
        return idle;
      } catch {
        await idle.close().catch(() => {});
      }
    }
    const page = await this.browser.newIsolatedPage();
    try {
      await openUrl(page, chatUrl(chatId));
    } catch (err) {
      await page.close().catch(() => {});
      throw err;
    }
    return page;
  }

  private releaseTab(chatId: string, page: Page): void {
    if (config.maxIdleTabs <= 0) {
      void page.close().catch(() => {});
      return;
    }
    const old = this.idleTabs.get(chatId);
    if (old && old !== page) void old.close().catch(() => {});
    this.idleTabs.delete(chatId);
    this.idleTabs.set(chatId, page);
    while (this.idleTabs.size > config.maxIdleTabs) {
      const [oldestId, oldestPage] = this.idleTabs.entries().next().value as [string, Page];
      this.idleTabs.delete(oldestId);
      void oldestPage.close().catch(() => {});
    }
  }

  private resolveOutDir(dir?: string): string {
    const d = path.resolve(dir || config.outputDir);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private saveImage(buf: Buffer, dir: string, base: string): SavedImage {
    const ext = sniffExt(buf);
    let file = path.join(dir, `${base}.${ext}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-v${n}.${ext}`);
    fs.writeFileSync(file, buf);
    return { path: file, bytes: buf.length, ...imageSize(buf) };
  }
}

export function buildPrompt(job: JobSpec): string {
  const extras: string[] = [];
  if (job.aspectRatio) extras.push(`Aspect ratio: ${job.aspectRatio}.`);
  if (job.transparent) extras.push("Use a transparent background.");
  const body = [job.prompt.trim(), extras.join(" ")].filter(Boolean).join("\n\n");
  if (job.raw) return body;
  if (job.kind === "generate") {
    return `Generate an image. Don't ask clarifying questions — make sensible choices and create it right away.\n\n${body}`;
  }
  return `${body}\n\n(Generate the updated image right away — no clarifying questions.)`;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "image"
  );
}

export function summarizeJob(j: Job) {
  return {
    job_id: j.id,
    status: j.status,
    chat_id: j.chatId,
    chat_url: j.chatUrl,
    label: j.label,
    prompt: j.prompt.length > 140 ? j.prompt.slice(0, 140) + "…" : j.prompt,
    images: j.images.map((i) => ({ path: i.path, width: i.width, height: i.height })),
    text: j.text ? (j.text.length > 800 ? j.text.slice(0, 800) + "…" : j.text) : undefined,
    error: j.error,
    debug_screenshot: j.debugScreenshot,
    elapsed_s: j.startedAt ? Math.round(((j.finishedAt ?? Date.now()) - j.startedAt) / 1000) : 0,
  };
}
