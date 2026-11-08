/**
 * search_prompts: proven example prompts from open collections.
 *  - bundled: data/prompt-index.json (EvoLink CC0 + ZeroLu MIT, ~900 prompts with sample images)
 *  - youmind: YouMind-OpenLab/ai-image-prompts-skill (MIT, ~16k prompts), downloaded on first use and cached for 7 days
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, log } from "./config.js";

export interface PromptEntry {
  id: string;
  source: string;
  category: string;
  title: string;
  description?: string;
  prompt: string;
  author?: string;
  url?: string;
  image?: string;
  reference?: boolean;
}

const here = path.dirname(fileURLToPath(import.meta.url));
let bundled: PromptEntry[] | null = null;
let youmind: PromptEntry[] | null = null;
let youmindLoading: Promise<PromptEntry[]> | null = null;

const YOUMIND = "https://raw.githubusercontent.com/YouMind-OpenLab/ai-image-prompts-skill/main/references";
const WEEK = 7 * 86400_000;

function loadBundled(): PromptEntry[] {
  if (bundled) return bundled;
  for (const p of [path.join(here, "..", "data", "prompt-index.json"), path.join(process.cwd(), "data", "prompt-index.json")]) {
    try {
      bundled = (JSON.parse(fs.readFileSync(p, "utf8")).entries ?? []) as PromptEntry[];
      return bundled;
    } catch {
      /* try next */
    }
  }
  bundled = [];
  return bundled;
}

async function fetchCached(url: string, file: string): Promise<string> {
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < WEEK) return fs.readFileSync(file, "utf8");
  } catch {
    /* not cached */
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const text = await r.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

async function loadYouMind(): Promise<PromptEntry[]> {
  if (youmind) return youmind;
  if (!youmindLoading) {
    youmindLoading = (async () => {
      const dir = path.join(config.home, "cache", "youmind");
      const manifest = JSON.parse(await fetchCached(`${YOUMIND}/manifest.json`, path.join(dir, "manifest.json")));
      const cats: Array<{ slug: string; file: string }> = manifest.categories ?? [];
      const out: PromptEntry[] = [];
      const queue = [...cats];
      const worker = async () => {
        for (let c = queue.shift(); c; c = queue.shift()) {
          try {
            const list = JSON.parse(await fetchCached(`${YOUMIND}/${c.file}`, path.join(dir, c.file))) as any[];
            for (const e of list) {
              if (!e?.content) continue;
              out.push({
                id: `youmind-${e.id}`,
                source: "youmind",
                category: c.slug,
                title: String(e.title ?? "").slice(0, 200),
                description: e.description,
                prompt: String(e.content),
                image: Array.isArray(e.sourceMedia) ? e.sourceMedia[0] : undefined,
                reference: Boolean(e.needReferenceImages),
              });
            }
          } catch (err) {
            log(`search_prompts: couldn't load YouMind category ${c.slug}: ${(err as Error).message}`);
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      youmind = out;
      return out;
    })().finally(() => (youmindLoading = null));
  }
  return youmindLoading;
}

const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);

export async function searchPrompts(opts: { query: string; category?: string; source?: "all" | "bundled" | "youmind"; limit?: number }) {
  const source = opts.source ?? "all";
  const pools: PromptEntry[][] = [];
  const notes: string[] = [];
  if (source !== "youmind") pools.push(loadBundled());
  if (source !== "bundled") {
    try {
      pools.push(await loadYouMind());
    } catch (err) {
      notes.push(`YouMind library unavailable (${(err as Error).message}); searched the bundled library only.`);
    }
  }
  const q = tokens(opts.query);
  const phrase = opts.query.toLowerCase().trim();
  const cat = opts.category?.toLowerCase();
  const scored: Array<{ e: PromptEntry; s: number }> = [];
  for (const pool of pools) {
    for (const e of pool) {
      if (cat && !e.category.toLowerCase().includes(cat)) continue;
      const title = e.title.toLowerCase();
      const desc = (e.description ?? "").toLowerCase();
      const body = e.prompt.toLowerCase();
      let s = 0;
      for (const t of q) {
        if (title.includes(t)) s += 4;
        if (desc.includes(t)) s += 2;
        if (body.includes(t)) s += 1;
      }
      if (q.length > 1) {
        const all = q.every((t) => title.includes(t) || desc.includes(t) || body.includes(t));
        if (all) s += 6 + (q.every((t) => title.includes(t)) ? 6 : 0);
        else s *= 0.4; // partial matches rank well below entries that contain every word
      }
      if (!q.length) s = 1;
      if (phrase.length > 3 && (title.includes(phrase) || body.includes(phrase))) s += 5;
      if (s > 0) scored.push({ e, s: s + (e.image ? 0.5 : 0) - (e.prompt.length > 4000 ? 1 : 0) });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  return {
    results: scored.slice(0, limit).map(({ e }) => ({
      title: e.title,
      source: e.source,
      category: e.category,
      prompt: e.prompt.length > 1800 ? e.prompt.slice(0, 1800) + "…" : e.prompt,
      needs_reference_image: e.reference || undefined,
      sample_image: e.image,
      author: e.author,
      url: e.url,
    })),
    total_matches: scored.length,
    notes: notes.length ? notes : undefined,
  };
}
