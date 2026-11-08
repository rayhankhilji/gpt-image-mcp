#!/usr/bin/env node
// Builds data/prompt-index.json from two open prompt collections:
//   - EvoLinkAI/awesome-gpt-image-2-API-and-Prompts  (CC0-1.0)
//   - ZeroLu/awesome-gpt-image                         (MIT, see data/THIRD_PARTY_NOTICES.md)
// Usage: node scripts/build-prompt-index.mjs [evolinkDir] [zeroluDir]   (clones into a temp dir if omitted)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));

function clone(repo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompts-"));
  execFileSync("git", ["clone", "-q", "--depth", "1", `https://github.com/${repo}.git`, dir], { stdio: "inherit" });
  return dir;
}

const evolink = process.argv[2] || clone("EvoLinkAI/awesome-gpt-image-2-API-and-Prompts");
const zerolu = process.argv[3] || clone("ZeroLu/awesome-gpt-image");

const entries = [];
const norm = (s) => s.replace(/\r/g, "").trim();
const firstImage = (block, base) => {
  const src = (block.match(/<img[^>]+src="([^"]+)"/) || [])[1];
  return src && !/^https?:/.test(src) && base ? `${base}/${src.replace(/^\.?\//, "")}` : src;
};

// EvoLink: cases/<category>.md (English files only) — "### Case N: [Title](url) (by [@x](...))" + **Prompt:** ```...```
for (const file of fs.readdirSync(path.join(evolink, "cases")).filter((f) => /^[a-z-]+\.md$/.test(f))) {
  const category = file.replace(/\.md$/, "");
  const text = fs.readFileSync(path.join(evolink, "cases", file), "utf8");
  for (const chunk of text.split(/^### /m).slice(1)) {
    const head = chunk.split("\n")[0];
    const m = head.match(/^Case (\d+):\s*\[([^\]]+)\]\(([^)]+)\)(?:\s*\(by \[([^\]]+)\])?/);
    const prompt = (chunk.match(/\*\*Prompt:?\*\*:?\s*\n+```[a-z]*\n([\s\S]*?)\n```/) || [])[1];
    if (!m || !prompt) continue;
    entries.push({
      id: `evolink-${m[1]}`,
      source: "evolink",
      category,
      title: m[2],
      prompt: norm(prompt),
      author: m[4],
      url: m[3],
      image: firstImage(chunk, "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main/cases"),
      reference: /reference|uploaded|attached|this (photo|image|person)/i.test(prompt),
    });
  }
}

// ZeroLu: README.md — "## <emoji> Section" then "### Title" + **Prompt:** ```text ... ```
const readme = fs.readFileSync(path.join(zerolu, "README.md"), "utf8");
let section = "general";
let n = 0;
for (const chunk of readme.split(/^(?=##+ )/m)) {
  const h2 = chunk.match(/^## (.+)/);
  if (h2) {
    section = h2[1].replace(/[^\p{L}\p{N}&/ -]/gu, "").trim().toLowerCase().replace(/\s+/g, "-") || section;
    continue;
  }
  const h3 = chunk.match(/^### (.+)/);
  if (!h3) continue;
  const prompt = (chunk.match(/\*\*Prompt:?\*\*:?\s*\n+```[a-z]*\n([\s\S]*?)\n```/) || [])[1];
  if (!prompt) continue;
  entries.push({
    id: `zerolu-${++n}`,
    source: "zerolu",
    category: section,
    title: h3[1].trim(),
    prompt: norm(prompt),
    author: (chunk.match(/Source:?\**\s*\[([^\]]+)\]/) || [])[1],
    url: (chunk.match(/Source:?\**\s*\[[^\]]+\]\(([^)]+)\)/) || [])[1],
    image: firstImage(chunk, "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main"),
    reference: /reference|uploaded|attached|this (photo|image|person)/i.test(prompt),
  });
}

fs.mkdirSync(path.join(root, "data"), { recursive: true });
fs.writeFileSync(path.join(root, "data", "prompt-index.json"), JSON.stringify({ built: new Date().toISOString(), entries }));
const byCat = entries.reduce((a, e) => ((a[`${e.source}/${e.category}`] = (a[`${e.source}/${e.category}`] ?? 0) + 1), a), {});
console.log(`wrote ${entries.length} prompts`, byCat);
