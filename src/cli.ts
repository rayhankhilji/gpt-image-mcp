#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserManager } from "./browser.js";
import { config, log } from "./config.js";
import { getSession, newChatUrl } from "./chatgpt.js";
import { JobManager, summarizeJob } from "./jobs.js";
import { createServer, logStartup, VERSION } from "./server.js";
import { exportSession, importSession, toEnvValue } from "./session.js";
import { runLogin } from "./login.js";

const HELP = `gpt-image-mcp v${VERSION} — let AI agents generate images with your ChatGPT account

Usage:
  gpt-image-mcp                          start the MCP server on stdio (what MCP clients run)
  gpt-image-mcp serve --http             start a remote MCP server (Streamable HTTP)
        [--host 127.0.0.1] [--port 8787] [--token <secret>] [--public-url https://...]
  gpt-image-mcp login                    open a browser window and sign in to ChatGPT (one time)
  gpt-image-mcp status                   check login + plan
  gpt-image-mcp export-session [file]    save your login to a file (to move it to a server)
        [--env]                          also print a one-line GPT_IMAGE_SESSION value for cloud secrets
  gpt-image-mcp import-session <file|->  load a login from export-session, a Cookie-Editor export,
                                         or a raw __Secure-next-auth.session-token value
  gpt-image-mcp generate "<prompt>" ["<prompt>" ...] [--out dir] [--aspect 16:9]
  gpt-image-mcp edit <chat_id|url> "<prompt>" [--out dir]
        (generate/edit print JSON with saved paths + chat_id. With GPT_IMAGE_SERVER_URL set they call a remote
         server instead of a local browser and download the results into --out.)

Environment: see README (GPT_IMAGE_HEADLESS, GPT_IMAGE_CDP_URL, GPT_IMAGE_OUTPUT_DIR, GPT_IMAGE_MAX_CONCURRENCY, ...)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  const rest = cmd === argv[0] ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      http: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      token: { type: "string" },
      "public-url": { type: "string" },
      out: { type: "string", short: "o" },
      aspect: { type: "string" },
      env: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help || cmd === "help") return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  switch (cmd) {
    case "serve":
      return values.http
        ? serveHttpCmd(values)
        : serveStdio();
    case "login":
      return login();
    case "status":
      return status();
    case "export-session":
      return exportCmd(positionals[0] || "chatgpt-session.json", !!values.env);
    case "import-session":
      if (!positionals[0]) throw new Error("usage: gpt-image-mcp import-session <file|->");
      return importCmd(positionals[0]);
    case "generate":
      if (!positionals.length) throw new Error('usage: gpt-image-mcp generate "<prompt>" ...');
      return runJobs(positionals.map((prompt) => ({ kind: "generate" as const, prompt, aspectRatio: values.aspect, outputDir: values.out })));
    case "edit":
      if (positionals.length < 2) throw new Error('usage: gpt-image-mcp edit <chat_id|url> "<prompt>"');
      return runJobs([{ kind: "edit" as const, chatId: positionals[0], prompt: positionals.slice(1).join(" "), aspectRatio: values.aspect, outputDir: values.out }]);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

function onExit(fn: () => Promise<void>): void {
  let done = false;
  const handler = async () => {
    if (done) return;
    done = true;
    await Promise.race([fn(), new Promise((r) => setTimeout(r, 5000))]);
    process.exit(0);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("SIGHUP", handler);
  return void handler; // referenced for stdin close
}

async function serveStdio(): Promise<void> {
  const manager = new JobManager();
  const server = createServer(manager);
  const shutdown = async () => manager.shutdown();
  onExit(shutdown);
  process.stdin.on("close", () => void shutdown().then(() => process.exit(0)));
  await server.connect(new StdioServerTransport());
  logStartup("stdio");
  manager.enablePrewarm(); // start Chrome + ready tabs now, so the first request has no startup delay
}

async function serveHttpCmd(values: Record<string, unknown>): Promise<void> {
  const { serveHttp } = await import("./http.js");
  const host = (values.host as string) || process.env.GPT_IMAGE_HTTP_HOST || "127.0.0.1";
  const port = parseInt((values.port as string) || process.env.GPT_IMAGE_HTTP_PORT || "8787", 10);
  let token = (values.token as string) || process.env.GPT_IMAGE_HTTP_TOKEN || "";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!token && !loopback) {
    token = randomBytes(24).toString("base64url");
    log(`generated bearer token (set GPT_IMAGE_HTTP_TOKEN to pin it): ${token}`);
  }
  const manager = new JobManager();
  onExit(() => manager.shutdown());
  manager.enablePrewarm();
  await serveHttp(manager, { host, port, token: token || undefined, publicUrl: (values["public-url"] as string) || process.env.GPT_IMAGE_PUBLIC_URL });
}

async function login(): Promise<void> {
  if (config.cdpUrl) {
    console.log(`Using your own Chrome via CDP (${config.cdpUrl}) — just make sure you're signed in to ChatGPT there.`);
    return status();
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      "No display found. Log in on a computer with a screen, then run `gpt-image-mcp export-session --env` there and " +
        "either set GPT_IMAGE_SESSION here or run `gpt-image-mcp import-session <file>`.",
    );
  }
  const s = await runLogin();
  console.log(`✓ Logged in as ${s.email ?? "unknown"} (plan: ${s.plan ?? "unknown"}).`);
  console.log(`Saved to ${config.profileDir} — every agent on this machine can use it now.`);
  console.log("For cloud agents / other machines: gpt-image-mcp export-session --env");
}

async function status(): Promise<void> {
  const browser = new BrowserManager();
  try {
    const page = await browser.newPage();
    await page.goto(newChatUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    const s = await getSession(page);
    console.log(JSON.stringify({ ...s, profile: config.cdpUrl || config.profileDir, output_dir: config.outputDir }, null, 2));
    if (!s.loggedIn) process.exitCode = 2;
  } finally {
    await browser.close();
  }
}

async function exportCmd(file: string, asEnv: boolean): Promise<void> {
  const browser = new BrowserManager();
  try {
    const page = await browser.newPage();
    await page.goto(newChatUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    const s = await getSession(page);
    if (!s.loggedIn) throw new Error("Not logged in — run `gpt-image-mcp login` first.");
    const n = await exportSession(await browser.context(), path.resolve(file));
    console.log(`✓ Exported ${n} cookies for ${s.email} to ${path.resolve(file)}`);
    console.log("Treat this file like a password. On the other machine: gpt-image-mcp import-session " + path.basename(file));
    if (asEnv) {
      console.log("\nOr set this as the secret GPT_IMAGE_SESSION in any cloud/agent environment (auto-loaded on start):\n");
      console.log(toEnvValue(path.resolve(file)));
    }
  } finally {
    await browser.close();
  }
}

async function importCmd(src: string): Promise<void> {
  const raw = src === "-" ? fs.readFileSync(0, "utf8") : fs.existsSync(src) ? fs.readFileSync(src, "utf8") : src;
  const browser = new BrowserManager();
  try {
    const n = await importSession(await browser.context(), raw);
    const page = await browser.newPage();
    await page.goto(newChatUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2000);
    const s = await getSession(page);
    if (!s.loggedIn) throw new Error(`Imported ${n} cookies but ChatGPT still says logged out — the session may be expired.`);
    console.log(`✓ Imported ${n} cookies. Logged in as ${s.email} (plan: ${s.plan ?? "unknown"}). Saved to ${config.profileDir}.`);
  } finally {
    await browser.close();
  }
}

/** If GPT_IMAGE_SERVER_URL is set, generate/edit go to that (remote) server and results are downloaded here. */
async function runRemote(specs: Parameters<JobManager["submit"]>[0][], outDir: string): Promise<void> {
  const base = process.env.GPT_IMAGE_SERVER_URL!.replace(/\/+(mcp)?\/?$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.GPT_IMAGE_HTTP_TOKEN) headers.authorization = `Bearer ${process.env.GPT_IMAGE_HTTP_TOKEN}`;
  const edit = specs[0].kind === "edit";
  const body = edit
    ? { edits: specs.map((s) => ({ chat_id: s.chatId, prompt: s.prompt, aspect_ratio: s.aspectRatio })) }
    : { jobs: specs.map((s) => ({ prompt: s.prompt, aspect_ratio: s.aspectRatio })) };
  const r = await fetch(`${base}/api/${edit ? "edit" : "generate"}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`server said ${r.status}: ${await r.text()}`);
  const payload: any = await r.json();
  fs.mkdirSync(outDir, { recursive: true });
  for (const j of payload.jobs) {
    for (const img of j.images ?? []) {
      if (!img.url) continue;
      const file = path.join(outDir, path.basename(img.path));
      fs.writeFileSync(file, Buffer.from(await (await fetch(img.url)).arrayBuffer()));
      img.remote_path = img.path;
      img.path = file;
    }
  }
  console.log(JSON.stringify(payload.jobs, null, 2));
  if (payload.jobs.some((j: any) => j.status === "error")) process.exitCode = 1;
}

async function runJobs(specs: Parameters<JobManager["submit"]>[0][]): Promise<void> {
  if (process.env.GPT_IMAGE_SERVER_URL) return runRemote(specs, path.resolve(specs[0].outputDir || "gpt-images"));
  const manager = new JobManager();
  onExit(() => manager.shutdown());
  try {
    const jobs = specs.map((s) => manager.submit(s));
    await manager.waitFor(jobs, config.timeoutSec * 1000 + 60_000, (js) =>
      log(js.map((j) => `${j.id}:${j.status}`).join("  ")),
    );
    console.log(JSON.stringify(jobs.map(summarizeJob), null, 2));
    if (jobs.some((j) => j.status === "error")) process.exitCode = 1;
  } finally {
    await manager.shutdown();
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
