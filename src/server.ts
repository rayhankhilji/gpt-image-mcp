import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config, log } from "./config.js";
import { getSession, newChatUrl } from "./chatgpt.js";
import { JobManager, slug, summarizeJob, type Job, type JobSpec } from "./jobs.js";
import { PRESETS, PROMPTING_RULES, REFERENCE_USES, STYLES } from "./presets.js";
import { searchPrompts } from "./prompt-search.js";

const DEFAULT_KIT = ["brand-app-icon", "brand-stationery", "brand-social-post", "ui-web", "brand-packaging", "brand-signage"];
import type { SavedImage } from "./state.js";

export const VERSION = "0.1.0";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ServerOptions {
  /** When set (HTTP mode), image results also carry a URL the remote agent can download. */
  fileUrl?: (absPath: string) => string | undefined;
}

const jobShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "The brief. With a preset: describe the subject (what list_presets says to describe). Without: write a full brief in the order " +
        "intended use → scene → subject → key details → constraints. Be concrete (medium, materials, lens, light); one job per image.",
    ),
  label: z.string().optional().describe("Short name used in the saved filename (e.g. 'hero-banner')."),
  preset: z
    .string()
    .optional()
    .describe("Preset id from list_presets (e.g. 'logo-mark', 'product-packshot', 'fashion-editorial', 'interior-render', 'video-start-frame'). Structures the prompt for that use case."),
  styles: z
    .array(z.string())
    .optional()
    .describe("Style modifier ids from list_presets (e.g. 'film-35mm', 'golden-hour', 'swiss-grid', 'clay-3d') or short free-text styles."),
  text: z.string().optional().describe("Exact text to render in the image (rendered once, verbatim)."),
  reference_images: z
    .array(z.string())
    .optional()
    .describe(
      "Images to attach to the ChatGPT chat: local file paths, http(s) URLs, or data:image/... URIs. If the user attached or pasted an " +
        "image in this conversation, pass its file path here (shown as `[Image: source: /path/...]`).",
    ),
  reference_usage: z
    .string()
    .optional()
    .describe(
      "How to use the reference image(s): 'style' (default for new images), 'subject', 'composition', 'logo', 'character', 'product', " +
        "'brand', 'edit' (default for edits), or a short free-text instruction.",
    ),
  aspect_ratio: z.string().optional().describe("e.g. '1:1', '3:2', '2:3', '4:5', '16:9', '9:16'. Presets have sensible defaults."),
  transparent_background: z.boolean().optional().describe("Ask for a transparent PNG (logos, icons, stickers, cut-outs)."),
  raw: z.boolean().optional().describe("Send the prompt verbatim with no wrapper (advanced)."),
};

const commonShape = {
  output_dir: z.string().optional().describe(`Folder to save images into. Default: ${config.outputDir}`),
  wait: z
    .boolean()
    .default(true)
    .describe("Wait for the images before returning (default). false = return job ids immediately; collect later with wait_for_jobs."),
  timeout_seconds: z
    .number()
    .int()
    .min(5)
    .max(3600)
    .optional()
    .describe(
      `Max seconds this call blocks (capped at ${config.maxCallWaitSec}s so it never hits client tool timeouts). ` +
        "Unfinished jobs keep running — collect them with wait_for_jobs.",
    ),
  return_images: z
    .boolean()
    .default(true)
    .describe("Return small JPEG previews inline (~500 tokens each) so you can see the results. Set false to save tokens. Files are always saved."),
};

export function createServer(manager: JobManager, opts: ServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: "gpt-image", version: VERSION },
    {
      instructions:
        "Generates images with the user's own ChatGPT account (uses their plan's image quota, not API credits). " +
        "Each generate job opens a NEW ChatGPT chat; many jobs in one call run in parallel. " +
        "Every result has a chat_id — pass it to edit_images to iterate on that exact image with full chat context. " +
        "Images are saved to disk; read the returned paths (or set return_images) to look at them. " +
        `Calls return within ~${config.maxCallWaitSec}s; if all_finished is false the images are still generating — ` +
        "call wait_for_jobs (no arguments) until all_finished is true. That's normal, not an error. " +
        "When images finish, show them to the user (e.g. send the saved files with your file-sharing tool). " +
        "Quality: use presets (list_presets), proven wording (search_prompts), one subject per image, exact text in `text`. " +
        "Images the user attaches in chat can be passed as reference_images (their file path). Brand identities: generate_brand_kit.",
    },
  );

  // ------------------------------------------------------------------ helpers

  const previewed = new Set<string>();

  async function render(jobs: Job[], finished: boolean, returnImages: boolean, extra: Record<string, unknown> = {}) {
    const payload = { ...extra, ...buildPayload(jobs, finished, opts.fileUrl) };
    const content: Content[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
    if (returnImages) {
      // Each preview is sent once per session — later polls don't repeat images already shown.
      const fresh = jobs.flatMap((j) => j.images).filter((i) => !previewed.has(i.path));
      fresh.forEach((i) => previewed.add(i.path));
      content.push(...(await previews(fresh)));
    }
    return { content, isError: jobs.length > 0 && jobs.every((j) => j.status === "error") };
  }

  async function previews(images: SavedImage[]): Promise<Content[]> {
    const out: Content[] = [];
    for (const img of images.slice(0, 20)) {
      try {
        const jpg = await manager.browser.makePreview(fs.readFileSync(img.path));
        out.push({ type: "text", text: `preview of ${img.path}` });
        out.push({ type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" });
      } catch (err) {
        out.push({ type: "text", text: `(no preview for ${img.path}: ${(err as Error).message})` });
      }
    }
    return out;
  }

  async function waitAndRender(
    jobs: Job[],
    args: { wait?: boolean; timeout_seconds?: number; return_images?: boolean },
    send: ReturnType<typeof progressSender>,
  ) {
    if (args.wait === false) return render(jobs, false, false);
    const timeoutMs = callWaitMs(args.timeout_seconds);
    const finished = await manager.waitFor(jobs, timeoutMs, (js) => progress(send, js));
    return render(jobs, finished, !!args.return_images);
  }

  function progressSender(extra: any) {
    const token = extra?._meta?.progressToken;
    if (token === undefined) return undefined;
    return (done: number, total: number, message: string) =>
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: done, total, message } })
        .catch(() => {});
  }

  function progress(send: ReturnType<typeof progressSender>, jobs: Job[]) {
    if (!send) return;
    const done = jobs.filter((j) => ["done", "no_image", "timeout", "error"].includes(j.status)).length;
    const c = countBy(jobs.map((j) => j.status));
    send(done, jobs.length, Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", "));
  }

  // ------------------------------------------------------------------ tools

  server.registerTool(
    "generate_images",
    {
      title: "Generate images (parallel, new chats)",
      description:
        "Generate one or many images with ChatGPT. Each job runs in its OWN NEW chat, and all jobs in one call generate " +
        "in parallel (send 10-20 at once for variations or a whole asset set). Returns saved file paths plus a chat_id per " +
        "image for follow-up edits via edit_images. Typical time: 30-120 s; if the call returns before everything is done, " +
        "call wait_for_jobs until all_finished is true. For quality, pick a preset (list_presets) and/or borrow proven wording " +
        "via search_prompts. Attach user-provided images with reference_images.",
      inputSchema: {
        jobs: z.array(z.object(jobShape)).min(1).max(50).describe("One entry per image/chat."),
        model: z.string().optional().describe("Optional ChatGPT model slug for the new chats (default: account default)."),
        ...commonShape,
      },
    },
    async (args, extra) => {
      const jobs = args.jobs.map((j) => manager.submit(toSpec("generate", j, args)));
      return waitAndRender(jobs, args, progressSender(extra));
    },
  );

  server.registerTool(
    "edit_images",
    {
      title: "Edit / iterate images in existing chats",
      description:
        "Send a follow-up prompt into existing ChatGPT chats (by chat_id from an earlier result, or a chatgpt.com/c/... URL) " +
        "to refine the image there — 'make the background darker', 'same character, now running', 'fix the text to say X'. " +
        "The chat keeps full context of previous images. Several edits (different chats) run in parallel; edits to the same " +
        "chat run in order.",
      inputSchema: {
        edits: z
          .array(z.object({ chat_id: z.string().min(1).describe("chat_id or chatgpt.com/c/<id> URL"), ...jobShape }))
          .min(1)
          .max(50),
        ...commonShape,
      },
    },
    async (args, extra) => {
      const jobs = args.edits.map((e) => manager.submit(toSpec("edit", e, args)));
      return waitAndRender(jobs, args, progressSender(extra));
    },
  );

  server.registerTool(
    "wait_for_jobs",
    {
      title: "Wait for / check jobs",
      description: "Check on or wait for jobs started with wait=false (or that outlasted a call's timeout). Omit job_ids to wait for everything still running.",
      inputSchema: {
        job_ids: z.array(z.string()).optional(),
        timeout_seconds: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe(`Seconds to wait (default and max ${config.maxCallWaitSec}). 0 = just report current status.`),
        return_images: z.boolean().default(true),
      },
    },
    async (args, extra) => {
      let jobs: Job[];
      if (args.job_ids?.length) {
        jobs = args.job_ids.map((id) => manager.get(id)).filter((j): j is Job => !!j);
        const missing = args.job_ids.filter((id) => !manager.get(id));
        if (missing.length && !jobs.length) {
          return { content: [{ type: "text" as const, text: `Unknown job ids: ${missing.join(", ")} (jobs live only as long as the server process — use list_chats for older work).` }], isError: true };
        }
      } else {
        jobs = manager.pending();
        if (!jobs.length) jobs = manager.list().slice(-20);
      }
      const send = progressSender(extra);
      const finished =
        args.timeout_seconds !== 0
          ? await manager.waitFor(jobs, callWaitMs(args.timeout_seconds), (js) => progress(send, js))
          : jobs.every((j) => ["done", "no_image", "timeout", "error"].includes(j.status));
      return render(jobs, finished, args.return_images);
    },
  );

  server.registerTool(
    "get_chat_images",
    {
      title: "Download all images from chats",
      description:
        "Download every generated image (full resolution) from one or MANY ChatGPT chats in a single call — " +
        "late finishers after a timeout, or chats made by hand in the ChatGPT UI. Pass all chat ids at once in chat_ids " +
        "(don't call this in parallel). Chats not reached before the call's time limit come back as not_fetched — call again with just those.",
      inputSchema: {
        chat_ids: z.array(z.string().min(1)).max(100).optional().describe("chat_ids or chatgpt.com/c/<id> URLs"),
        chat_id: z.string().min(1).optional().describe("Single chat (same as chat_ids with one entry)."),
        output_dir: z.string().optional(),
        return_images: z.boolean().default(true),
      },
    },
    async (args) => {
      const ids = [...(args.chat_ids ?? []), ...(args.chat_id ? [args.chat_id] : [])];
      if (!ids.length) return { content: [{ type: "text" as const, text: "Pass chat_ids (or chat_id)." }], isError: true };
      const results = await manager.fetchManyChatImages(ids, args.output_dir, Date.now() + callWaitMs() - 8000);
      const chats = results.map((r) => ({
        ...r,
        images: r.images.map((i) => ({ path: i.path, width: i.width, height: i.height, ...(opts.fileUrl ? { url: opts.fileUrl(i.path) } : {}) })),
      }));
      const notFetched = results.filter((r) => r.not_fetched).map((r) => r.chat_id);
      const payload = { chats, ...(notFetched.length ? { hint: `Call get_chat_images again with chat_ids: ${JSON.stringify(notFetched)}` } : {}) };
      const content: Content[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
      if (args.return_images) {
        const fresh = results.flatMap((r) => r.images).filter((i) => !previewed.has(i.path));
        fresh.forEach((i) => previewed.add(i.path));
        content.push(...(await previews(fresh)));
      }
      return { content, isError: results.every((r) => r.error) };
    },
  );

  server.registerTool(
    "list_presets",
    {
      title: "List prompt presets and styles",
      description:
        "Prompt presets (brand, logo, mascot, product, fashion, portrait, interior, architecture, garden, vehicles, nature, macro, food, " +
        "backgrounds, video start frames, UI/layout, illustration…) plus style modifiers and the core prompting rules. Use a preset id in " +
        "generate_images/edit_images jobs. Call this before writing image prompts if you haven't yet.",
      inputSchema: { category: z.string().optional().describe("Filter by category, e.g. 'brand', 'product', 'interior'.") },
    },
    async (args) => {
      const list = PRESETS.filter((p) => !args.category || p.category === args.category.toLowerCase());
      const payload = {
        rules: PROMPTING_RULES,
        presets: list.map((p) => ({ id: p.id, name: p.name, category: p.category, describe: p.describe, default_aspect: p.aspect, transparent: p.transparent || undefined })),
        styles: STYLES.map((st) => `${st.id}: ${st.text}`),
        reference_usage: Object.keys(REFERENCE_USES),
        brand_identities: "Use generate_brand_kit: logo system first, then every asset generated from it (consistent, not one crowded board).",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] };
    },
  );

  server.registerTool(
    "search_prompts",
    {
      title: "Search proven example prompts",
      description:
        "Search ~17,000 real-world image prompts (open collections: EvoLink CC0, ZeroLu MIT, YouMind MIT) with sample-image links. " +
        "Use to borrow structure and wording that's known to work for a subject (e.g. 'perfume ad', 'isometric room', 'character sheet', " +
        "'youtube thumbnail'), then adapt it — don't copy blindly. Categories include portrait, poster, ui, ecommerce, ad-creative, character, " +
        "product-marketing, profile-avatar, social-media-post, infographic, game-asset, comic-storyboard, app-web-design.",
      inputSchema: {
        query: z.string().min(1),
        category: z.string().optional(),
        source: z.enum(["all", "bundled", "youmind"]).default("all").describe("'bundled' is instant and offline; 'youmind' downloads ~47 MB once and caches it."),
        limit: z.number().int().min(1).max(20).default(5),
      },
    },
    async (args) => {
      const r = await searchPrompts({ query: args.query, category: args.category, source: args.source, limit: args.limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 1) }] };
    },
  );

  server.registerTool(
    "generate_brand_kit",
    {
      title: "Generate a consistent brand identity kit",
      description:
        "Brand identity done properly: for each creative direction, first generates a logo-system sheet (logo, palette, type), then " +
        "generates every requested asset FROM that sheet (attached as a reference) so all assets share one logo, palette and type. " +
        "Assets default to app icon, stationery, social post, website hero, packaging and signage. All directions run in parallel; " +
        "assets start as soon as their logo sheet is ready. Collect with wait_for_jobs.",
      inputSchema: {
        brand_name: z.string().min(1).describe("Exact brand name (spelled as it must appear)."),
        brief: z.string().min(1).describe("What the company does, audience, personality, positioning, must-haves."),
        directions: z
          .array(z.string())
          .max(6)
          .optional()
          .describe("Distinct creative directions, one per kit (e.g. '1970s Swiss modernist, orange/cream/navy', 'wabi-sabi ceramics, ash and celadon'). Default: one direction from the brief."),
        assets: z
          .array(z.string())
          .optional()
          .describe(`Asset preset ids. Default: ${DEFAULT_KIT.join(", ")}. Any preset id works (e.g. 'brand-merch', 'brand-pattern', 'mascot').`),
        reference_images: z.array(z.string()).optional().describe("Existing logo / inspiration images (paths, URLs or data URIs)."),
        reference_usage: z.string().optional().describe("How to use those references for the logo sheet (default 'style'; use 'logo' to keep an existing logo)."),
        ...commonShape,
      },
    },
    async (args, extra) => {
      const dirs = args.directions?.length ? args.directions : [""];
      const assets = args.assets?.length ? args.assets : DEFAULT_KIT;
      const unknown = assets.filter((a) => !PRESETS.some((p) => p.id === a));
      if (unknown.length) {
        return { content: [{ type: "text" as const, text: `Unknown asset preset(s): ${unknown.join(", ")}. Call list_presets for ids.` }], isError: true };
      }
      if (dirs.length * (assets.length + 1) > 42) {
        return { content: [{ type: "text" as const, text: "Too many images: directions × (assets + 1) must be ≤ 42." }], isError: true };
      }
      const jobs: Job[] = [];
      dirs.forEach((dir, d) => {
        const tag = dirs.length > 1 ? `d${d + 1}-` : "";
        const brief = `Brand "${args.brand_name}". ${args.brief}${dir ? ` Creative direction: ${dir}.` : ""}`;
        const base = manager.submit({
          ...toSpec("generate", { prompt: brief, preset: "brand-logo-system", text: args.brand_name, label: `${tag}${slug(args.brand_name)}-logo-system`, reference_images: args.reference_images, reference_usage: args.reference_usage }, args),
        });
        jobs.push(base);
        for (const a of assets) {
          jobs.push(
            manager.submit({
              ...toSpec("generate", { prompt: `${brief} Apply this brand identity to the asset.`, preset: a, label: `${tag}${slug(args.brand_name)}-${a}`, reference_usage: "brand" }, args),
              dependsOn: base.id,
            }),
          );
        }
      });
      return waitAndRender(jobs, args, progressSender(extra));
    },
  );

  server.registerTool(
    "list_chats",
    {
      title: "List image chats",
      description: "List chats this server has created/edited (newest first) with every turn's prompt and saved image paths. Use to find a chat_id to keep iterating.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
    },
    async (args) => {
      const chats = manager.state.listChats().slice(0, args.limit).map((c) => ({
        chat_id: c.chat_id,
        url: c.url,
        title: c.title,
        label: c.label,
        updated_at: c.updated_at,
        turns: c.turns.map((t) => ({ kind: t.kind, status: t.status, prompt: t.prompt.slice(0, 160), images: t.images.map((i) => i.path) })),
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ chats }, null, 2) }] };
    },
  );

  server.registerTool(
    "chatgpt_status",
    {
      title: "ChatGPT connection status",
      description: "Check that the ChatGPT session is logged in (and which plan), plus queue stats.",
      inputSchema: {},
    },
    async () => {
      const ctx = await manager.browser.context();
      const page = await ctx.newPage();
      try {
        await page.goto(newChatUrl(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const s = await getSession(page);
        const text = JSON.stringify(
          {
            logged_in: s.loggedIn,
            email: s.email,
            plan: s.plan,
            session_expires: s.expires,
            ...manager.stats(),
            output_dir: config.outputDir,
            ...(s.loggedIn ? {} : { fix: "Run `npx gpt-image-mcp login` on a machine with a screen, or import a session (see README)." }),
          },
          null,
          2,
        );
        return { content: [{ type: "text" as const, text }], isError: !s.loggedIn };
      } finally {
        await page.close().catch(() => {});
      }
    },
  );

  return server;
}

export function toSpec(kind: "generate" | "edit", j: any, args: any): JobSpec {
  return {
    kind,
    prompt: j.prompt,
    chatId: j.chat_id,
    label: j.label,
    referenceImages: j.reference_images,
    aspectRatio: j.aspect_ratio,
    transparent: j.transparent_background,
    raw: j.raw,
    preset: j.preset,
    styles: j.styles,
    text: j.text,
    referenceUsage: j.reference_usage,
    outputDir: args.output_dir,
    model: args.model,
    timeoutSec: config.timeoutSec,
  };
}

export function buildPayload(jobs: Job[], finished: boolean, fileUrl?: (p: string) => string | undefined) {
  const summaries = jobs.map((j) => {
    const s = summarizeJob(j);
    if (fileUrl) (s.images as Array<Record<string, unknown>>).forEach((img) => (img.url = fileUrl(img.path as string)));
    return s;
  });
  return {
    all_finished: finished,
    counts: countBy(jobs.map((j) => j.status)),
    jobs: summaries,
    ...(finished
      ? {}
      : {
          hint:
            "Still generating (normal — images take 30-120 s). Call wait_for_jobs again (no arguments needed) to collect them; " +
            "repeat until all_finished is true.",
        }),
  };
}

/** Per-call blocking time, never above maxCallWaitSec. */
export function callWaitMs(requestedSec?: number): number {
  return Math.min(requestedSec ?? config.maxCallWaitSec, config.maxCallWaitSec) * 1000;
}

export function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

export function logStartup(mode: string): void {
  log(`v${VERSION} ready (${mode}); profile=${config.cdpUrl ? `CDP ${config.cdpUrl}` : config.profileDir}; output=${config.outputDir}; concurrency=${config.maxConcurrency}`);
}
