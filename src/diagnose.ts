/**
 * `gpt-image-mcp diagnose [chat_id|url]` — prints what the live ChatGPT page and endpoints return,
 * so breakages after ChatGPT updates can be fixed from facts. Opens an existing chat; generates nothing.
 */
import { BrowserManager } from "./browser.js";
import { analyzeTurn, apiGet, chatUrl, getSession, newChatUrl, normalizeChatId, pageSignals } from "./chatgpt.js";

function summarize(c: any) {
  const msgs = Object.values<any>(c.mapping ?? {})
    .map((n) => n.message)
    .filter(Boolean)
    .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  return {
    title: c.title,
    current_node: c.current_node,
    nodes: Object.keys(c.mapping ?? {}).length,
    analyzeTurn_from_0: (() => {
      const t = analyzeTurn(c, 0);
      return { registered: t.registered, images: t.images.length, asyncPending: t.asyncPending, endTurn: t.endTurn, text: t.text.slice(0, 120) };
    })(),
    messages: msgs.map((m) => ({
      role: m.author?.role,
      name: m.author?.name,
      ct: m.content?.content_type,
      recipient: m.recipient,
      status: m.status,
      end_turn: m.end_turn,
      parts: (m.content?.parts ?? []).map((p: any) =>
        typeof p === "string" ? `str(${p.length}): ${p.slice(0, 60)}` : { ct: p?.content_type, ptr: String(p?.asset_pointer ?? "").slice(0, 60), w: p?.width, h: p?.height, keys: Object.keys(p ?? {}) },
      ),
      md: Object.keys(m.metadata ?? {}).slice(0, 30),
    })),
  };
}

export async function diagnose(chat?: string): Promise<void> {
  const browser = new BrowserManager();
  const net: string[] = [];
  try {
    const page = await browser.newIsolatedPage();
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (/backend-api|\/api\/|conversation/.test(u.pathname)) net.push(`${r.request().method()} ${u.pathname} -> ${r.status()}`);
    });
    const id = chat ? normalizeChatId(chat) : "";
    await page.goto(id ? chatUrl(id) : newChatUrl(), { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(8000);
    const report: any = { url: page.url(), title: await page.title(), session: await getSession(page) };
    if (id) {
      report.api = {};
      for (const p of [`/backend-api/conversation/${id}`, `/backend-api/f/conversation/${id}`]) {
        const r = await apiGet(page, p);
        report.api[p] = { status: r.status, text: r.text, summary: r.json?.mapping ? summarize(r.json) : r.json ? JSON.stringify(r.json).slice(0, 600) : null };
      }
    }
    report.signals = await pageSignals(page).catch((e) => String(e));
    report.dom = await page.evaluate(() => {
      const attrs: Record<string, number> = {};
      document.querySelectorAll("*").forEach((e) => {
        for (const a of Array.from(e.attributes)) {
          if (/^data-/.test(a.name) && /message|turn|author|role|image|asset/i.test(a.name)) {
            const k = `${e.tagName.toLowerCase()}[${a.name}=${a.value.slice(0, 30)}]`;
            attrs[k] = (attrs[k] ?? 0) + 1;
          }
        }
      });
      const attrStr = (el: Element) => Array.from(el.attributes).filter((a) => a.name !== "class" && a.name !== "style").map((a) => `${a.name}=${a.value.slice(0, 50)}`).join(" ");
      return {
        data_attrs: attrs,
        images: Array.from(document.images)
          .filter((i) => i.naturalWidth >= 200)
          .map((i) => ({ src: (i.currentSrc || i.src).slice(0, 160), alt: i.alt, w: i.naturalWidth, h: i.naturalHeight, filter: getComputedStyle(i).filter, parent: attrStr(i.parentElement!) })),
        composer: Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).map(attrStr),
        buttons: Array.from(document.querySelectorAll("form button, button[data-composer-submit], button[data-testid]")).map(attrStr).slice(0, 25),
      };
    });
    report.network = Array.from(new Set(net));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}
