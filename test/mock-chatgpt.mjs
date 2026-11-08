// A small stand-in for chatgpt.com, used by the e2e test. It mimics the parts gpt-image-mcp
// relies on: the 2026 "octane" composer DOM, /api/auth/session, the async image-gen conversation
// JSON at /backend-api/conversation/{id}, and the /backend-api/files/download/{id} -> download_url hop.
import http from "node:http";
import zlib from "node:zlib";
import { randomUUID, randomBytes, createHash } from "node:crypto";

const conversations = new Map(); // id -> { mapping, current_node, title, generating }
const stats = { sends: 0, maxConcurrent: 0, concurrent: 0, uploads: 0, unauthorized: 0 };

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const colorFor = (id) => [...createHash("md5").update(id).digest().subarray(0, 3)];

function msg(role, content, extra = {}) {
  return { id: randomUUID(), author: { role }, content, create_time: Date.now() / 1000, status: "finished_successfully", end_turn: null, recipient: "all", metadata: {}, ...extra };
}
function append(conv, message, parentId = conv.current_node) {
  conv.mapping[message.id] = { id: message.id, message, parent: parentId, children: [] };
  conv.mapping[parentId].children.push(message.id);
  conv.current_node = message.id;
  return message.id;
}

function newConversation() {
  const id = randomUUID();
  const root = "client-created-root";
  const conv = { id, title: "New chat", mapping: { [root]: { id: root, message: null, parent: null, children: [] } }, current_node: root };
  append(conv, msg("system", { content_type: "text", parts: [""] }, { metadata: { is_visually_hidden_from_conversation: true } }));
  // Hidden user-context message, like the real thing.
  append(conv, msg("user", { content_type: "user_editable_context", user_profile: "" }, { metadata: { is_visually_hidden_from_conversation: true } }));
  conversations.set(id, conv);
  return conv;
}

function handleSend(conv, text, attachments) {
  stats.sends++;
  const userParts = [...attachments.map((a) => ({ content_type: "image_asset_pointer", asset_pointer: `sediment://${a}`, width: 64, height: 64 })), text];
  const userId = append(conv, msg("user", { content_type: attachments.length ? "multimodal_text" : "text", parts: userParts }));
  if (conv.title === "New chat") conv.title = text.replace(/^Generate an image\..*?\n\n/s, "").slice(0, 30);

  if (/refuse/i.test(text)) {
    setTimeout(() => append(conv, msg("assistant", { content_type: "text", parts: ["I can't help create that image."] }, { end_turn: true })), 800);
    return;
  }
  stats.concurrent++;
  stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
  conv.generating = true;
  // Tool call + async "processing" marker, then the image lands a few seconds later.
  const callId = append(conv, msg("assistant", { content_type: "code", text: "{\"prompt\":\"...\"}" }, { recipient: "t2uay3k.sj1i4kz", metadata: { image_gen_async: true, trigger_async_ux: true } }));
  append(conv, msg("tool", { content_type: "text", parts: ["Processing image"] }, { metadata: { image_gen_task_id: "task_" + randomBytes(4).toString("hex"), async_task_type: "image_gen" } }), callId);
  const count = /two images/i.test(text) ? 2 : 1;
  const delay = Number(process.env.MOCK_GEN_MS ?? 9000) + Math.floor(Math.random() * 4000);
  setTimeout(() => {
    for (let i = 0; i < count; i++) {
      const fid = "file_" + randomBytes(12).toString("hex");
      append(conv, msg("tool", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: `sediment://${fid}`, width: 96, height: 64, size_bytes: 1000, metadata: { dalle: { gen_id: fid } } }] }, { metadata: { image_gen_title: "img" } }));
    }
    append(conv, msg("assistant", { content_type: "text", parts: [""] }, { end_turn: true }));
    conv.generating = false;
    stats.concurrent--;
  }, delay);
  void userId;
}

const PAGE = (loggedIn) => `<!doctype html><html><head><title>ChatGPT</title></head><body>
<main id="thread"></main>
<form action="/conversation" method="post" ${loggedIn ? "" : "data-logged-out"} onsubmit="return false">
  <div data-composer-editor-host><textarea name="prompt" id="composer" aria-label="Chat with ChatGPT" placeholder="Ask ChatGPT" rows="1"></textarea></div>
  <input id="octane-mobile-composer-files-input" type="file" hidden multiple accept="image/png,image/jpeg,image/webp">
  <button type="submit" data-composer-submit aria-label="Send message" hidden>Send</button>
</form>
<div id="att"></div>
<script>
const ta = document.getElementById('composer'), btn = document.querySelector('[data-composer-submit]'), fi = document.getElementById('octane-mobile-composer-files-input');
let uploads = [], uploading = 0;
function sync() {
  const gen = btn.hasAttribute('data-stop-generating');
  if (gen) return;
  btn.hidden = !ta.value.trim();
  if (uploading) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled');
}
ta.addEventListener('input', sync);
fi.addEventListener('change', async () => {
  for (const f of fi.files) {
    uploading++; sync();
    const fid = await new Promise(r => setTimeout(async () => r((await (await fetch('/mock/upload', {method:'POST', body: f.name})).json()).id), 1200));
    uploads.push(fid); uploading--; document.getElementById('att').textContent = uploads.length + ' attached'; sync();
  }
});
async function token() { return (await (await fetch('/api/auth/session')).json()).accessToken; }
function cid() { const m = location.pathname.match(/\\/c\\/([\\w-]+)/); return m && m[1]; }
async function render() {
  const id = cid(); if (!id) return;
  const r = await fetch('/backend-api/conversation/' + id, { headers: { authorization: 'Bearer ' + await token() } });
  if (!r.ok) return;
  const c = await r.json();
  const th = document.getElementById('thread'); th.innerHTML = '';
  const ordered = Object.values(c.mapping).map(n => n.message).filter(Boolean).sort((a,b) => a.create_time - b.create_time);
  for (const m of ordered) {
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    const d = document.createElement('div');
    if (m.author.role === 'user') { d.setAttribute('data-message-author-role', 'user'); d.textContent = m.content.parts.filter(p => typeof p === 'string').join(''); }
    else if (m.content.content_type === 'multimodal_text') {
      for (const p of m.content.parts) { const img = document.createElement('img'); img.alt = 'Generated image'; img.width = 300; img.src = '/backend-api/estuary/content?id=' + p.asset_pointer.split('//')[1] + '&w=512'; d.appendChild(img); }
    } else if (m.author.role === 'assistant' && m.content.parts) { d.setAttribute('data-message-author-role', 'assistant'); d.textContent = m.content.parts.join(''); }
    else if (m.author.role === 'tool' && m.content.parts) { d.textContent = c.generating ? 'Creating image' : ''; }
    th.appendChild(d);
  }
}
btn.addEventListener('click', async (e) => {
  e.preventDefault();
  if (btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('data-stop-generating')) return;
  const text = ta.value; ta.value = '';
  btn.setAttribute('data-stop-generating', ''); btn.setAttribute('aria-label', 'Stop generating');
  const r = await fetch('/mock/send', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ conversation_id: cid(), text, attachments: uploads }) });
  const { conversation_id } = await r.json();
  uploads = []; document.getElementById('att').textContent = '';
  if (!cid()) history.pushState({}, '', '/c/' + conversation_id);
  setTimeout(() => { btn.removeAttribute('data-stop-generating'); btn.setAttribute('aria-label', 'Send message'); sync(); }, 1500);
});
setInterval(render, 1000); render();
</script></body></html>`;

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=").map(decodeURIComponent)));
}

export function startMock(port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const loggedIn = cookies(req)["__Secure-next-auth.session-token"] === "mock-session";
    const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    const body = async () => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString(); };
    const authed = () => {
      if (req.headers.authorization === "Bearer mock-token" && loggedIn) return true;
      stats.unauthorized++;
      json(401, { detail: "Unauthorized" });
      return false;
    };

    if (url.pathname === "/" || url.pathname.startsWith("/c/")) return res.writeHead(200, { "content-type": "text/html" }).end(PAGE(loggedIn));
    if (url.pathname === "/api/auth/session") return json(200, loggedIn ? { accessToken: "mock-token", user: { email: "tester@example.com", name: "Tester" }, account: { planType: "go" }, expires: "2099-01-01" } : {});
    if (url.pathname === "/mock/stats") return json(200, stats);
    if (url.pathname === "/mock/upload" && req.method === "POST") { await body(); stats.uploads++; return json(200, { id: "file_up" + randomBytes(6).toString("hex") }); }
    if (url.pathname === "/mock/send" && req.method === "POST") {
      if (!loggedIn) return json(401, {});
      const { conversation_id, text, attachments } = JSON.parse(await body());
      const conv = conversation_id ? conversations.get(conversation_id) : newConversation();
      if (!conv) return json(404, {});
      // The real site registers the user message a beat after the URL changes.
      setTimeout(() => handleSend(conv, text, attachments ?? []), 300);
      return json(200, { conversation_id: conv.id });
    }
    let m;
    if ((m = url.pathname.match(/^\/backend-api\/conversation\/([\w-]+)$/))) {
      if (!authed()) return;
      const c = conversations.get(m[1]);
      return c ? json(200, { title: c.title, current_node: c.current_node, mapping: c.mapping, generating: !!c.generating }) : json(404, { detail: "not found" });
    }
    if ((m = url.pathname.match(/^\/backend-api\/files\/download\/([\w-]+)$/))) {
      if (!authed()) return;
      if (!conversations.has(url.searchParams.get("conversation_id"))) return json(400, { detail: "Invalid conversation" });
      // Like the real CDN: a different origin than the app (exercises the cross-origin download path).
      const cdn = `http://${String(req.headers.host).replace("127.0.0.1", "localhost")}`;
      return json(200, { status: "success", download_url: `${cdn}/mock/blob/${m[1]}?sig=abc` });
    }
    if ((m = url.pathname.match(/^\/mock\/blob\/([\w-]+)$/))) return res.writeHead(200, { "content-type": "image/png" }).end(png(96, 64, colorFor(m[1])));
    if (url.pathname === "/backend-api/estuary/content") return res.writeHead(200, { "content-type": "image/png" }).end(png(512, 340, colorFor(url.searchParams.get("id") ?? "x")));
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, stats })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock(Number(process.env.PORT ?? 4555)).then(({ port }) => console.log(`mock chatgpt on http://127.0.0.1:${port}`));
}
