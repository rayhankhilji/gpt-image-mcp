// End-to-end test against the mock ChatGPT: drives the real MCP server (stdio + HTTP) through a real
// headless Chromium. Run with `npm test`. Set GPT_IMAGE_EXECUTABLE_PATH if Playwright's browser isn't installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMock } from "./mock-chatgpt.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "dist", "cli.js");
const { server: mock, port, stats } = await startMock();
const base = `http://127.0.0.1:${port}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-e2e-"));
const env = {
  ...process.env,
  GPT_IMAGE_HOME: home,
  GPT_IMAGE_BASE_URL: base,
  GPT_IMAGE_HEADLESS: "1",
  GPT_IMAGE_BROWSER_CHANNEL: process.env.GPT_IMAGE_BROWSER_CHANNEL ?? "chromium",
  GPT_IMAGE_SEND_GAP_MS: "150",
  GPT_IMAGE_MAX_CONCURRENCY: "12",
  GPT_IMAGE_TIMEOUT: "120",
};
const results = [];
let envValue;
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    results.push(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    console.log(results.at(-1));
  } catch (err) {
    console.log(`✗ ${name}`);
    throw err;
  }
};
// Async on purpose: the mock server lives in this process, so a sync exec would deadlock it.
const run = async (args) => (await promisify(execFile)("node", [cli, ...args], { env, encoding: "utf8" })).stdout;
const parse = (r) => JSON.parse(r.content.find((c) => c.type === "text").text);

try {
  await step("status before login reports logged out", async () => {
    let code = 0;
    try { await run(["status"]); } catch (e) { code = e.code; if (code !== 2) console.log(String(e.stderr)); }
    assert.equal(code, 2);
  });

  if (process.platform === "linux" && (process.env.GPT_IMAGE_EXECUTABLE_PATH || fs.existsSync("/opt/pw-browsers/chromium"))) {
    await step("login via the user's own Chrome (simulated sign-in) persists into the profile", async () => {
      const real = process.env.GPT_IMAGE_EXECUTABLE_PATH || "/opt/pw-browsers/chromium";
      const wrapper = path.join(home, "fake-chrome.sh");
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${real}" --headless=new "$@"\n`, { mode: 0o755 });
      const lhome = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-login-"));
      const lport = String(port + 7);
      const lenv = { ...env, GPT_IMAGE_HOME: lhome, GPT_IMAGE_LOGIN_BROWSER: wrapper, GPT_IMAGE_LOGIN_PORT: lport, DISPLAY: ":99" };
      const child = promisify(execFile)("node", [cli, "login"], { env: lenv, encoding: "utf8" });
      // Play the human: wait for the browser, then "sign in" (set the auth cookie) and reload.
      const { chromium } = await import("playwright");
      let b;
      for (let i = 0; i < 100 && !b; i++) {
        b = await chromium.connectOverCDP(`http://127.0.0.1:${lport}`).catch(() => null);
        if (!b) await new Promise((r) => setTimeout(r, 200));
      }
      await b.contexts()[0].addCookies([{ name: "__Secure-next-auth.session-token", value: "mock-session", domain: "127.0.0.1", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 86400 }]);
      await b.close();
      const out = (await child).stdout;
      assert.match(out, /Logged in as tester@example.com/);
      const st = JSON.parse((await promisify(execFile)("node", [cli, "status"], { env: { ...env, GPT_IMAGE_HOME: lhome }, encoding: "utf8" })).stdout);
      assert.equal(st.loggedIn, true, "session copied into the automation profile");
      fs.rmSync(lhome, { recursive: true, force: true });
    });
  }

  await step("import-session (Cookie-Editor format) logs in", async () => {
    const f = path.join(home, "cookies.json");
    fs.writeFileSync(f, JSON.stringify([{ name: "__Secure-next-auth.session-token", value: "mock-session", domain: "127.0.0.1", path: "/", secure: false, httpOnly: true, sameSite: "lax", expirationDate: Date.now() / 1000 + 86400 }]));
    const out = await run(["import-session", f]);
    assert.match(out, /Logged in as tester@example.com \(plan: go\)/);
  });

  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [cli], env, stderr: "inherit" }));

  await step("lists tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["chatgpt_status", "edit_images", "generate_images", "get_chat_images", "list_chats", "wait_for_jobs"]);
  });

  await step("chatgpt_status", async () => {
    const s = parse(await client.callTool({ name: "chatgpt_status", arguments: {} }));
    assert.equal(s.logged_in, true);
    assert.equal(s.plan, "go");
  });

  const ref = path.join(home, "ref.png");
  fs.writeFileSync(ref, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));

  let gen;
  await step("generate_images: 12 parallel new chats (incl. reference image, refusal, multi-image)", async () => {
    const jobs = Array.from({ length: 9 }, (_, i) => ({ prompt: `A cozy cabin variation ${i + 1}`, label: `cabin-${i + 1}`, aspect_ratio: "3:2" }));
    jobs.push({ prompt: "Restyle this photo as watercolor", reference_images: [ref], label: "with-ref" });
    jobs.push({ prompt: "please refuse this one", label: "refused" });
    jobs.push({ prompt: "Make two images of a fox", label: "fox" });
    const t = Date.now();
    gen = parse(await client.callTool({ name: "generate_images", arguments: { jobs, output_dir: path.join(home, "out") } }, undefined, { timeout: 300_000 }));
    const secs = (Date.now() - t) / 1000;
    assert.equal(gen.all_finished, true, JSON.stringify(gen, null, 2));
    assert.equal(gen.counts.done, 11, JSON.stringify(gen.counts));
    assert.equal(gen.counts.no_image, 1);
    const refused = gen.jobs.find((j) => j.label === "refused");
    assert.match(refused.text, /can't help/);
    assert.equal(gen.jobs.find((j) => j.label === "fox").images.length, 2);
    for (const j of gen.jobs.filter((j) => j.status === "done")) {
      assert.ok(j.chat_id && j.chat_url.includes("/c/"));
      for (const img of j.images) {
        assert.ok(fs.existsSync(img.path), img.path);
        assert.equal(img.width, 96);
        assert.equal(img.height, 64);
      }
    }
    assert.equal(new Set(gen.jobs.map((j) => j.chat_id)).size, 12, "each job gets its own chat");
    assert.ok(stats.maxConcurrent >= 8, `expected parallel generation, max concurrent was ${stats.maxConcurrent}`);
    assert.equal(stats.uploads, 1);
    assert.ok(secs < 60, `12 jobs took ${secs}s — not parallel?`);
    console.log(`   12 jobs in ${secs.toFixed(1)}s, peak concurrent generations: ${stats.maxConcurrent}`);
  });

  let pending;
  await step("edit_images (wait=false) on 3 chats + a 2nd edit queued on the same chat", async () => {
    const targets = gen.jobs.filter((j) => j.label?.startsWith("cabin")).slice(0, 3);
    const r = parse(await client.callTool({
      name: "edit_images",
      arguments: {
        wait: false,
        edits: [
          ...targets.map((t) => ({ chat_id: t.chat_id, prompt: "Make it snowy" })),
          { chat_id: targets[0].chat_url, prompt: "Now add a red door" }, // URL form, same chat as #1
        ],
      },
    }));
    assert.equal(r.all_finished, false);
    pending = r.jobs.map((j) => j.job_id);
    assert.equal(pending.length, 4);
  });

  await step("wait_for_jobs collects the edits, with previews", async () => {
    const r = await client.callTool({ name: "wait_for_jobs", arguments: { job_ids: pending, timeout_seconds: 120, return_images: true } }, undefined, { timeout: 200_000 });
    const p = parse(r);
    assert.equal(p.all_finished, true);
    assert.equal(p.counts.done, 4, JSON.stringify(p, null, 2));
    const imgs = r.content.filter((c) => c.type === "image");
    assert.equal(imgs.length, 4);
    assert.equal(imgs[0].mimeType, "image/jpeg");
    assert.match(p.jobs[0].images[0].path, /-t2\.png$/);
    assert.match(p.jobs[3].images[0].path, /-t3\.png$/, "second edit on same chat is turn 3");
  });

  await step("get_chat_images downloads the whole history of a chat", async () => {
    const chat = gen.jobs.find((j) => j.label === "cabin-1").chat_id;
    const r = parse(await client.callTool({ name: "get_chat_images", arguments: { chat_id: chat } }));
    assert.equal(r.images.length, 3); // original + 2 edits
  });

  await step("list_chats", async () => {
    const r = parse(await client.callTool({ name: "list_chats", arguments: { limit: 50 } }));
    assert.equal(r.chats.length, 12);
    const c1 = r.chats.find((c) => c.label === "cabin-1");
    assert.equal(c1.turns.length, 3);
  });

  await client.close();
  await new Promise((r) => setTimeout(r, 1500)); // let the stdio server close its browser profile

  await step("remote mode: serve --http with bearer token + image download URLs", async () => {
    const hport = port + 1;
    const proc = spawn("node", [cli, "serve", "--http", "--port", String(hport), "--token", "s3cret"], { env, stdio: ["ignore", "inherit", "inherit"] });
    try {
      const url = new URL(`http://127.0.0.1:${hport}/mcp`);
      for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${hport}/health`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(noAuth.status, 401);
      const hc = new Client({ name: "e2e-http", version: "0" });
      await hc.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer s3cret" } } }));
      const r = parse(await hc.callTool({ name: "generate_images", arguments: { jobs: [{ prompt: "remote test", label: "remote" }] } }, undefined, { timeout: 200_000 }));
      assert.equal(r.counts.done, 1, JSON.stringify(r));
      const imgUrl = r.jobs[0].images[0].url;
      assert.ok(imgUrl, "HTTP results carry a download url");
      const dl = await fetch(imgUrl);
      assert.equal(dl.status, 200);
      assert.equal(dl.headers.get("content-type"), "image/png");
      await hc.close();

      // Plain REST (for non-MCP agents)
      const rest = await (await fetch(`http://127.0.0.1:${hport}/api/generate`, {
        method: "POST",
        headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
        body: JSON.stringify({ prompts: ["rest one", "rest two"] }),
      })).json();
      assert.equal(rest.counts.done, 2, JSON.stringify(rest));

      // CLI pointed at the remote server downloads results locally
      const out = path.join(home, "remote-dl");
      const cliOut = JSON.parse((await promisify(execFile)("node", [cli, "generate", "cli via server", "--out", out], {
        env: { ...env, GPT_IMAGE_SERVER_URL: `http://127.0.0.1:${hport}`, GPT_IMAGE_HTTP_TOKEN: "s3cret" }, encoding: "utf8",
      })).stdout);
      assert.equal(cliOut[0].status, "done");
      assert.ok(cliOut[0].images[0].path.startsWith(out) && fs.existsSync(cliOut[0].images[0].path));
    } finally {
      proc.kill("SIGTERM");
    }
  });

  await step("export-session round-trips", async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const f = path.join(home, "export.json");
    const out = await run(["export-session", f, "--env"]);
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.ok(data.cookies.some((c) => c.name === "__Secure-next-auth.session-token"));
    envValue = out.trim().split("\n").at(-1);
  });

  await step("fresh container (empty profile) starts logged in from GPT_IMAGE_SESSION secret", async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-fresh-"));
    const out = (await promisify(execFile)("node", [cli, "status"], { env: { ...env, GPT_IMAGE_HOME: fresh, GPT_IMAGE_SESSION: envValue }, encoding: "utf8" })).stdout;
    assert.equal(JSON.parse(out).loggedIn, true);
    // ...and it stays logged in on the next start even without the secret (saved to the profile).
    const out2 = (await promisify(execFile)("node", [cli, "status"], { env: { ...env, GPT_IMAGE_HOME: fresh }, encoding: "utf8" })).stdout;
    assert.equal(JSON.parse(out2).loggedIn, true);
    fs.rmSync(fresh, { recursive: true, force: true });
  });

  console.log(`\nAll ${results.length} checks passed.`);
} finally {
  mock.close();
  if (!process.env.KEEP) fs.rmSync(home, { recursive: true, force: true });
}
process.exit(0);
