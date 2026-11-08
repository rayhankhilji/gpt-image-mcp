/**
 * Remote mode: expose the MCP server over Streamable HTTP so agents on other machines can use it.
 * The ChatGPT browser runs headless on this box — nothing has to be open on your own computer.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./config.js";
import type { JobManager } from "./jobs.js";
import { buildPayload, createServer, logStartup, toSpec } from "./server.js";
import { config } from "./config.js";
import type { Job } from "./jobs.js";

export interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  publicUrl?: string;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export async function serveHttp(manager: JobManager, opts: HttpOptions): Promise<http.Server> {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(opts.host);
  if (!loopback && !opts.token) {
    throw new Error("Refusing to listen on a non-loopback address without --token (or GPT_IMAGE_HTTP_TOKEN).");
  }
  const base = (opts.publicUrl || `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`).replace(/\/+$/, "");

  // Capability URLs for saved images (unguessable id → file), so remote agents can download results.
  const files = new Map<string, string>();
  const byPath = new Map<string, string>();
  const fileUrl = (p: string) => {
    let id = byPath.get(p);
    if (!id) {
      id = randomBytes(16).toString("hex");
      byPath.set(p, id);
      files.set(id, p);
    }
    return `${base}/files/${id}/${encodeURIComponent(path.basename(p))}`;
  };

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const authorized = (req: http.IncomingMessage) => {
    if (!opts.token) return true;
    const h = String(req.headers.authorization ?? "");
    const given = Buffer.from(h.replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(opts.token);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");

      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...manager.stats() }));
        return;
      }

      const fm = url.pathname.match(/^\/files\/([0-9a-f]{32})\//);
      if (fm && req.method === "GET") {
        const p = files.get(fm[1]);
        if (!p || !fs.existsSync(p)) return void res.writeHead(404).end("not found");
        res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream" });
        fs.createReadStream(p).pipe(res);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req)) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized");
        return void (await handleRest(req, res, url, manager, fileUrl));
      }

      if (url.pathname !== "/mcp") return void res.writeHead(404).end("not found");
      if (!authorized(req)) return void res.writeHead(401, { "www-authenticate": "Bearer" }).end("unauthorized");

      const sid = req.headers["mcp-session-id"] as string | undefined;
      if (req.method === "POST") {
        const body = await readJson(req);
        let transport = sid ? transports.get(sid) : undefined;
        if (!transport) {
          if (sid || !isInitializeRequest(body)) {
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session" }, id: null }),
            );
            return;
          }
          const t = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => void transports.set(id, t),
          });
          t.onclose = () => {
            if (t.sessionId) transports.delete(t.sessionId);
          };
          await createServer(manager, { fileUrl }).connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const t = sid ? transports.get(sid) : undefined;
        if (!t) return void res.writeHead(400).end("invalid session");
        await t.handleRequest(req, res);
        return;
      }
      res.writeHead(405).end();
    } catch (err) {
      log("http error", err);
      if (!res.headersSent) res.writeHead(500).end(String((err as Error).message));
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));
  logStartup(`http ${base}/mcp`);
  return server;
}

/**
 * Plain REST for agents/tools that don't speak MCP (custom DeepSeek/OpenRouter agents, scripts, n8n, ...).
 *   POST /api/generate {"jobs":[{"prompt":"..."}] | "prompts":["..."], "wait":true, "timeout_seconds":600}
 *   POST /api/edit     {"edits":[{"chat_id":"...","prompt":"..."}], "wait":true}
 *   GET  /api/jobs?ids=job_a,job_b&wait=300
 *   GET  /api/chats?limit=20
 *   POST /api/chats/<chat_id>/images
 */
async function handleRest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  manager: JobManager,
  fileUrl: (p: string) => string,
): Promise<void> {
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body, null, 2));
  };
  const finish = async (jobs: Job[], body: any) => {
    if (body.wait === false) return send(202, buildPayload(jobs, false, fileUrl));
    const ok = await manager.waitFor(jobs, (Number(body.timeout_seconds) || config.timeoutSec) * 1000);
    send(200, buildPayload(jobs, ok, fileUrl));
  };
  try {
    if (req.method === "POST" && url.pathname === "/api/generate") {
      const body: any = (await readJson(req)) ?? {};
      const list: any[] = body.jobs ?? (body.prompts ?? (body.prompt ? [body.prompt] : [])).map((p: string) => ({ prompt: p }));
      if (!list.length || list.some((j) => !j?.prompt)) return send(400, { error: "need jobs[].prompt or prompts[]" });
      return finish(list.map((j) => manager.submit(toSpec("generate", j, body))), body);
    }
    if (req.method === "POST" && url.pathname === "/api/edit") {
      const body: any = (await readJson(req)) ?? {};
      const list: any[] = body.edits ?? (body.chat_id ? [body] : []);
      if (!list.length || list.some((e) => !e?.chat_id || !e?.prompt)) return send(400, { error: "need edits[].chat_id and .prompt" });
      return finish(list.map((e) => manager.submit(toSpec("edit", e, body))), body);
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const jobs = ids.length ? ids.map((id) => manager.get(id)).filter((j): j is Job => !!j) : manager.pending();
      const wait = Number(url.searchParams.get("wait") ?? 0);
      const ok = wait > 0 ? await manager.waitFor(jobs, wait * 1000) : jobs.every((j) => ["done", "no_image", "timeout", "error"].includes(j.status));
      return send(200, buildPayload(jobs, ok, fileUrl));
    }
    if (req.method === "GET" && url.pathname === "/api/chats") {
      return send(200, { chats: manager.state.listChats().slice(0, Number(url.searchParams.get("limit") ?? 20)) });
    }
    const m = url.pathname.match(/^\/api\/chats\/([\w-]+)\/images$/);
    if (req.method === "POST" && m) {
      const r = await manager.fetchChatImages(m[1]);
      return send(200, { ...r, images: r.images.map((i) => ({ ...i, url: fileUrl(i.path) })) });
    }
    send(404, { error: "unknown endpoint" });
  } catch (err) {
    send(500, { error: (err as Error).message });
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}
