# gpt-image-mcp

Let any AI agent generate and iterate on images **through your own ChatGPT account**, using the image
generations included in your Free / Go / Plus / Pro plan instead of API credits.

- **Parallel.** One call can start 10–20 prompts. Each one gets its own new ChatGPT chat, and they all generate at the same time.
- **Iterative.** Every result comes back with a `chat_id`. Send follow-up edits into that exact chat ("make the sky purple", "same character, now running"), and it keeps the full context of the image.
- **Cheap on tokens.** No computer use, no screenshots, no vision loops. The agent sends a prompt and gets back file paths. You can opt in to small JPEG previews when the agent needs to look.
- **Full resolution.** Images are downloaded as the original PNGs from ChatGPT.
- **Log in once.** Sign in with Google, Apple, Microsoft or email. The login is saved, and you can carry it into cloud agents or remote servers.
- **Works with almost any agent.** It's an MCP server (Claude Code, Cursor, Codex, Windsurf, Devin, Conductor, Cline, VS Code, Gemini CLI…), plus a CLI and a REST API for everything else.

> **Unofficial.** This drives the chatgpt.com website for you. It can break when OpenAI changes the site, and
> automated use of the consumer app may conflict with OpenAI's terms. It's your account, so keep the volume
> reasonable. Your plan's normal image limits apply.

## How it works

```
agent ──MCP / CLI / REST──▶ gpt-image-mcp ──▶ Chrome (your ChatGPT login)
                                │                 ├─ tab 1: new chat ─ "a cozy cabin…"
                                │                 ├─ tab 2: new chat ─ "a cozy cabin, night…"
                                │                 └─ tab N …
                                └─ polls ChatGPT's own conversation JSON, then downloads the
                                   full-res files and saves them to disk
```

- **Sending** goes through the real ChatGPT page: it types into the composer and clicks send. ChatGPT's own front end handles its security checks, and your plan's quota is used.
- **Reading** uses ChatGPT's internal JSON endpoints (`/backend-api/conversation/{id}`, `/backend-api/files/download/{id}`), called from inside the logged-in page. That's how it knows when an image is finished and gets the original file. The DOM is only a fallback.
- **Parallel for real:** every chat runs in its own isolated browser context carrying your login. ChatGPT's web app shares one "new chat in progress" slot across tabs of a profile, so ordinary tabs would queue behind each other.
- **No waiting on our side:** the server starts Chrome and keeps ready-to-type tabs loaded (`GPT_IMAGE_WARM_TABS`), and finishes a job the moment the image is done.
- **Gentle on your account:** completion is detected mostly passively, from what the page itself renders and receives, which costs zero requests. ChatGPT's data endpoint is only asked occasionally, through one shared, adaptive rate limit. Polling it hard makes ChatGPT throttle the whole account (429, "Could not load this conversation") until it stops.

## Claude Code on the web: no terminal needed

This repo is already set up for web sessions: [`.mcp.json`](.mcp.json) and [`scripts/mcp-launch.sh`](scripts/mcp-launch.sh)
install, build and start the server automatically, and the cloud container runs Chrome on a virtual screen.
You only need to hand it your ChatGPT login once:

1. **Copy your login from your normal browser** (on a computer where you're signed in to chatgpt.com):
   install the free **Cookie-Editor** extension (Chrome / Edge / Firefox / Safari). Open chatgpt.com, click
   Cookie-Editor, then **Export → Header String**. That copies one line to your clipboard.
2. **Save it in the cloud environment, not in the chat**: in Claude Code on the web, open the cloud
   environment menu in the session's title bar, then **Edit**, and add an environment variable:
   `GPT_IMAGE_SESSION=<paste>`. Save.
3. **Start a new session** on this repo and ask, e.g.: *"Use gpt-image to make 6 logo concepts for a coffee
   brand called Ember, then make #3 warmer."* Images land in `generated-images/`.

That line is your ChatGPT login, so keep the environment private. When ChatGPT eventually logs it out, repeat
step 1 and update the variable. To use it from **other** repos' sessions, add the same `.mcp.json` entry
there with `"command": "npx", "args": ["-y", "github:rayhankhilji/gpt-image-mcp"]`. That works if this repo
is public or published to npm.

## Quick start (your own computer)

Requires Node 18+ and Google Chrome. If you don't have Chrome, run `npx playwright install chromium` and set `GPT_IMAGE_BROWSER_CHANNEL=chromium`.

```bash
npx -y github:rayhankhilji/gpt-image-mcp login
```

This opens your normal Chrome with a separate profile. Sign in to ChatGPT any way you like, and the command
finishes on its own. The login is stored in `~/.gpt-image-mcp/profile`, and every agent on this machine
shares it. You never need to log in again unless ChatGPT logs you out.

Then add it to your agent (see [Connect your agent](#connect-your-agent)). For Claude Code:

```bash
claude mcp add gpt-image -s user -- npx -y github:rayhankhilji/gpt-image-mcp
```

While the agent works, a Chrome window runs **minimized**. On a machine with no display it runs headless.
Want it fully off your computer? See [Cloud & remote](#cloud--remote-log-in-once-use-everywhere).

> If the repo is private, or you prefer a local checkout:
> `git clone … && cd gpt-image-mcp && npm install`, then use `node /abs/path/gpt-image-mcp/dist/cli.js`
> instead of `npx -y github:rayhankhilji/gpt-image-mcp` everywhere below.

## Tools (MCP)

| Tool | What it does |
|---|---|
| `generate_images` | `jobs: [{prompt, preset?, styles?, text?, label?, reference_images?, reference_usage?, aspect_ratio?, transparent_background?}]`. Each job is a **new chat**, and all of them run in parallel. Returns `{status, chat_id, images:[{path,width,height}], text}` per job. |
| `edit_images` | `edits: [{chat_id, prompt, …}]`. Sends a follow-up into existing chats to refine their image. Edits to different chats run in parallel, and edits to the same chat run in order. `chat_id` can also be a `chatgpt.com/c/…` URL, including chats you made by hand. |
| `wait_for_jobs` | Collects jobs started with `wait: false`, or ones that outlasted a call's timeout. |
| `get_chat_images` | Downloads every image from one or many chats (`chat_ids`) at full resolution, in one call (late finishers, hand-made chats). |
| `list_presets` | Presets, style modifiers and prompting rules. |
| `search_prompts` | Proven example prompts with sample images, about 17,000 of them. |
| `generate_brand_kit` | A consistent brand identity: logo sheet first, then assets built from it. |
| `list_chats` | Lists chats created so far, with each turn's prompt and saved files. Survives restarts. |
| `chatgpt_status` | Shows whether you're logged in, which plan, and the queue stats. |

Common options: `output_dir`, `wait` (default `true`), `timeout_seconds`, and `return_images`. With
`return_images`, small JPEG previews come back inline so the agent can see the results. Files are always
saved either way.

If ChatGPT answers with text instead of an image (a refusal, a hit limit, a question), the job ends as
`no_image` and the reply is in `text`. The agent can follow up with `edit_images` on the same `chat_id`.

Example: what an agent sends

```json
{ "jobs": [
  { "prompt": "Flat vector app icon of a paper plane, teal gradient", "label": "icon-a", "aspect_ratio": "1:1" },
  { "prompt": "Same concept, isometric 3D clay style",                 "label": "icon-b", "aspect_ratio": "1:1" },
  { "prompt": "Hero banner: paper planes over a city at dusk",         "label": "hero",   "aspect_ratio": "16:9" }
]}
```

…then `edit_images` with `{"edits":[{"chat_id":"<from icon-b>","prompt":"warmer colors, thicker outline"}]}`.

## Better prompts: presets, proven examples, references

- **58 presets** (`list_presets`) cover these use cases:
  - brand identity and assets, logos (wordmark, symbol, monogram, badge)
  - mascots and character sheets, stickers
  - realistic and phone photos, portraits (studio, environmental, headshot)
  - fashion (editorial, on-model e-commerce, lookbook)
  - products (packshot, cut-out, hero, lifestyle, flat lay)
  - interiors (render, floor plan, isometric, moodboard), architecture, gardens
  - cars, aircraft, landscapes, macro, food
  - backgrounds (blur, gradient, texture, wallpaper)
  - video start frames and storyboards
  - UI (web, app), posters, infographics, slides, thumbnails, icon sets, illustration and game assets

  Each preset follows [OpenAI's GPT Image prompting guide](https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide.md): intended use → scene → subject → key details → constraints, plus what to avoid. **40 style modifiers** (film stock, lighting, design movements, 3D/illustration media) combine with any preset.
- **`search_prompts`** searches about 17,000 real-world prompts with sample images. It covers ~900 bundled offline (EvoLink, CC0; ZeroLu, MIT) and ~16,000 from YouMind (MIT), which are downloaded once and cached. See [`data/THIRD_PARTY_NOTICES.md`](data/THIRD_PARTY_NOTICES.md).
- **Reference images:** `reference_images` accepts local paths, URLs or `data:` URIs. An image the user attaches in Claude Code chat is a local file, so the agent passes its path. `reference_usage` says how to use it: `style`, `subject`, `composition`, `logo`, `character`, `product`, `brand` or `edit`.
- **`generate_brand_kit`** makes a logo-system sheet first, then generates every asset from it, so they all share one logo, palette and type. You can request several creative directions in parallel.
- **`text`** is exact copy, rendered once and verbatim.
- A Claude Code skill ([`.claude/skills/gpt-image/SKILL.md`](.claude/skills/gpt-image/SKILL.md)) teaches the agent this workflow.

## Connect your agent

Local (stdio): the command is `npx -y github:rayhankhilji/gpt-image-mcp`.
Remote (HTTP): the URL is `https://your-host/mcp`, with the header `Authorization: Bearer <token>`.

| Client | Local | Remote |
|---|---|---|
| **Claude Code** (also **Conductor**, which runs Claude Code) | `claude mcp add gpt-image -s user -- npx -y github:rayhankhilji/gpt-image-mcp` | `claude mcp add --transport http gpt-image https://your-host/mcp --header "Authorization: Bearer TOKEN"` |
| **Cursor** (`~/.cursor/mcp.json`) | `{"mcpServers":{"gpt-image":{"command":"npx","args":["-y","github:rayhankhilji/gpt-image-mcp"]}}}` | `{"mcpServers":{"gpt-image":{"url":"https://your-host/mcp","headers":{"Authorization":"Bearer TOKEN"}}}}` |
| **Codex CLI** (`~/.codex/config.toml`) | `[mcp_servers.gpt-image]`<br>`command = "npx"`<br>`args = ["-y","github:rayhankhilji/gpt-image-mcp"]` | use the CLI/REST, or your Codex version's HTTP MCP support |
| **VS Code / Copilot** (`.vscode/mcp.json`) | `{"servers":{"gpt-image":{"command":"npx","args":["-y","github:rayhankhilji/gpt-image-mcp"]}}}` | `{"servers":{"gpt-image":{"type":"http","url":"https://your-host/mcp","headers":{"Authorization":"Bearer TOKEN"}}}}` |
| **Windsurf**, **Claude Desktop**, **Cline / Roo / Kilo**, **Gemini CLI**, **Goose**, **opencode**, **Zed**, **LM Studio** | the same `mcpServers` → `command`/`args` JSON | `url` (Windsurf calls it `serverUrl`) + `headers` |
| **Devin** | Settings → MCP → add a custom server (STDIO command above) | add a custom server with the HTTP URL + header |

**DeepSeek, OpenRouter, Meta/Llama, local models…** are models, not agents. Use them inside any MCP-capable
client above (Cline, Roo, opencode and Goose all accept an OpenRouter or DeepSeek key), or have your custom
agent call the [CLI or REST API](#no-mcp-cli--rest).

## Cloud & remote: log in once, use everywhere

Cloud agents (Claude Code on the web, Devin, Cursor background agents, Codex cloud, CI…) start in a fresh,
empty container every time. There are two ways to give them your login once.

### Option A: a secret that every new session loads automatically

On your own computer, after `login`:

```bash
npx -y github:rayhankhilji/gpt-image-mcp export-session --env
```

Copy the long one-line value it prints into your cloud environment's secrets / environment variables as
**`GPT_IMAGE_SESSION`**. Every new session then starts logged in, and once loaded the login is saved into that
session's profile. Also add the MCP server to the agent there (for Claude Code on the web, commit a
`.mcp.json` like [`examples/mcp.json`](examples/mcp.json) to your project). The container needs network access to `chatgpt.com`.

The value is your ChatGPT login, so treat it like a password. Logins expire eventually (typically after weeks
to a few months, or if you sign out everywhere). When that happens, re-run `export-session --env` and update
the secret.

### Option B: one always-on server, and every agent points at it

Run the server on a machine that stays on (home server, VPS, Raspberry Pi, a spare Mac…). Its browser keeps
renewing your login, so this is the most "set and forget" option.

```bash
# on the server (no screen needed)
npx -y github:rayhankhilji/gpt-image-mcp import-session chatgpt-session.json   # file from export-session, or set GPT_IMAGE_SESSION
GPT_IMAGE_HTTP_TOKEN=some-long-secret npx -y github:rayhankhilji/gpt-image-mcp serve --http --host 0.0.0.0 --port 8787
```

Or with Docker. The image runs a real Chrome on a virtual display (Xvfb):

```bash
docker build -t gpt-image-mcp .
docker run -d --name gpt-image -p 8787:8787 -v gpt-image-data:/data \
  -e GPT_IMAGE_HTTP_TOKEN=some-long-secret -e GPT_IMAGE_SESSION='<value from export-session --env>' gpt-image-mcp
```

Then connect any agent to `http://server:8787/mcp` with `Authorization: Bearer some-long-secret`. Put it
behind HTTPS (Caddy, Cloudflare Tunnel, Tailscale…) if it's reachable from the internet. In remote mode,
every image result also has a `url` the agent can download from.

Datacenter IPs get more Cloudflare checks than home connections. If the server gets stuck on "verify you are
human", run it on a home or residential network.

### Other login options

- `import-session` and `GPT_IMAGE_SESSION` also accept a **Cookie-Editor** export (JSON or one-line "Header String") from chatgpt.com, or the raw value of the `__Secure-next-auth.session-token` cookie.
- `GPT_IMAGE_CDP_URL=http://127.0.0.1:9222` uses your own running Chrome (started with `--remote-debugging-port=9222 --user-data-dir=…`) instead of launching one.

## No MCP? CLI & REST

Anything that can run a shell command or make an HTTP request can use it.

```bash
gpt-image-mcp generate "a red fox, watercolor" "a red fox, pixel art" --out ./art --aspect 1:1
gpt-image-mcp edit <chat_id> "make the fox smile" --out ./art
```

Both print JSON with saved paths and `chat_id`s. Set `GPT_IMAGE_SERVER_URL=http://server:8787` (plus
`GPT_IMAGE_HTTP_TOKEN`) to use a remote server instead of a local browser. Results are downloaded into `--out`.

REST (on `serve --http`, same bearer token):

```
POST /api/generate   {"prompts":["...","..."]}  or  {"jobs":[{"prompt":"...","aspect_ratio":"16:9"}], "wait":true}
POST /api/edit       {"edits":[{"chat_id":"...","prompt":"..."}]}
GET  /api/jobs?ids=job_a,job_b&wait=300
GET  /api/chats
POST /api/chats/<chat_id>/images
```

A snippet for an `AGENTS.md` / system prompt:

```
To create images, run: gpt-image-mcp generate "<detailed prompt>" ["<prompt 2>" ...] --out ./images
Each prompt runs in its own ChatGPT chat in parallel. The JSON output lists saved image paths and a chat_id.
To refine an image: gpt-image-mcp edit <chat_id> "<change>" --out ./images
```

## Configuration

| Env var | Default | |
|---|---|---|
| `GPT_IMAGE_HOME` | `~/.gpt-image-mcp` | profile, state, debug captures |
| `GPT_IMAGE_OUTPUT_DIR` | `$GPT_IMAGE_HOME/images` | default save folder |
| `GPT_IMAGE_MAX_CONCURRENCY` | `10` | chats generating at once (extra jobs queue) |
| `GPT_IMAGE_SEND_GAP_MS` | `250` | minimum gap between prompt submissions |
| `GPT_IMAGE_WARM_TABS` | `3` | ready-to-type ChatGPT tabs the server keeps loaded so jobs start instantly |
| `GPT_IMAGE_API_GAP_MS` | `300` | starting gap between ChatGPT data requests; adapts automatically (slows down 2× on a 429, then eases back) |
| `GPT_IMAGE_MAX_PAGE_LOADS` | `5` | ChatGPT pages loading at once |
| `GPT_IMAGE_MAX_CALL_WAIT` | `50` | longest one tool call blocks (stays under 60 s client timeouts); unfinished jobs are collected with `wait_for_jobs` |
| `GPT_IMAGE_TIMEOUT` | `600` | per-job timeout (seconds) |
| `GPT_IMAGE_MAX_IDLE_TABS` | `4` | finished chats kept open for instant edits |
| `GPT_IMAGE_HEADLESS` | auto | `1` = headless. Auto: on Linux without a screen, a virtual display (Xvfb) is used if installed, else headless |
| `GPT_IMAGE_WINDOW` | `minimized` | `minimized` / `normal` / `offscreen` (headed mode) |
| `GPT_IMAGE_BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or `chromium` (Playwright's) |
| `GPT_IMAGE_EXECUTABLE_PATH` | | explicit browser binary |
| `GPT_IMAGE_MODEL` | account default | `?model=` slug for new chats |
| `GPT_IMAGE_SESSION` / `GPT_IMAGE_SESSION_FILE` | | login to seed an empty profile (see Option A) |
| `GPT_IMAGE_CDP_URL` | | attach to an existing Chrome |
| `GPT_IMAGE_HTTP_TOKEN` / `_HOST` / `_PORT` / `GPT_IMAGE_PUBLIC_URL` | | remote server settings |
| `GPT_IMAGE_SERVER_URL` | | make the CLI use a remote server |
| `GPT_IMAGE_DEBUG` | `0` | verbose logs on stderr |

## Troubleshooting

- **"Not logged in"**: run `login` again, or refresh `GPT_IMAGE_SESSION`.
- **"profile is already in use"**: only one process can use a profile at a time. Close the other instance, or give this one its own `GPT_IMAGE_PROFILE_DIR`. To share one login between many agents on one machine, run `serve --http` once and point them all at it.
- **Something broke after a ChatGPT update**: failed jobs save a screenshot and the page HTML in `~/.gpt-image-mcp/debug/` (the path is in `debug_screenshot`). Every DOM hook lives in [`src/selectors.ts`](src/selectors.ts). It already covers both the 2026 "octane" composer and the classic one.
- **Text instead of an image**: you may have hit your plan's image limit. The `text` field shows what ChatGPT said.

## Development

```bash
npm install
npm test        # builds, then runs an end-to-end suite against a local mock of chatgpt.com
```

The mock (`test/mock-chatgpt.mjs`) reproduces the composer DOM, session endpoint, async image-generation
conversation JSON and file-download endpoints. The suite covers 12 parallel chats, reference uploads,
refusals, multi-image turns, queued edits on one chat, previews, the HTTP/REST/remote-CLI paths, login,
session export/import, and a fresh container starting logged in from `GPT_IMAGE_SESSION`. If Playwright's
browser isn't installed, set `GPT_IMAGE_EXECUTABLE_PATH` to a Chromium binary.

## License

MIT
