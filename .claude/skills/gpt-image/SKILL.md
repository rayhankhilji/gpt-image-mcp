---
name: gpt-image
description: Generate, edit and iterate high-quality images through the user's ChatGPT account with the gpt-image MCP tools — brand identities, logos, mascots, product shots, fashion/models, portraits, interiors, architecture, gardens, cars, planes, nature, close-ups, backgrounds, video start frames, UI/layouts. Use whenever the user asks for images, or attaches an image to restyle, edit or use as a reference.
---

# Making great images with gpt-image

## Workflow
1. **Pick the structure.** Call `list_presets` once per session if you haven't yet. Choose the preset that matches the job (e.g. `logo-mark`, `product-packshot`, `fashion-editorial`, `interior-render`, `video-start-frame`). Add 1–3 `styles` (e.g. `film-35mm`, `golden-hour`, `swiss-grid`, `clay-3d`).
2. **Borrow proven wording when useful.** Run `search_prompts` with the subject ("perfume ad", "isometric room", "character sheet"). Adapt the structure and specific details; never paste blindly.
3. **Write the brief** in `prompt`. With a preset, describe the subject only (what `list_presets` says to describe). Without one, use this order: intended use → scene → subject → key details → constraints. Be concrete about medium, materials, lens and light. One subject per image. Put any words that must appear in `text` (exact, short).
4. **Generate in parallel.** Use ONE `generate_images` call with all variations as separate jobs. If `all_finished` is false, keep calling `wait_for_jobs` with no arguments. Show every finished image to the user as soon as it arrives.
5. **Iterate.** Use `edit_images` with the image's `chat_id`, one change at a time ("warmer light; keep composition, logo and colours the same").

## Reference images from the chat
When the user attaches or pastes an image, it appears as `[Image: source: /path/to/file.png]`. Pass that path in `reference_images` and say how to use it with `reference_usage`:
- `style`: borrow palette, light and medium only
- `subject`, `character` or `product`: keep the exact thing and put it in a new scene
- `composition`: same framing, new content
- `logo` or `brand`: reproduce their existing identity exactly
- `edit`: change only what's asked

URLs and `data:image/...` URIs also work.

## Brand identities
Use `generate_brand_kit`, not one crowded board. It makes a logo-system sheet first, then builds every asset from it (app icon, stationery, social post, website, packaging, signage, or any asset presets you pass), so everything matches. To explore looks, pass several `directions` (specific: era, medium, palette, references). For quick direction comparison alone, use `generate_images` with the `brand-direction-board` preset.

## Quality rules
- Vague hype words ("beautiful", "innovative", "contrarian") do nothing. Translate them into concrete choices: materials, era, layout and palette with hex codes.
- Photorealism: say "photorealistic", describe a real moment captured on camera, and ask for real texture. Avoid studio-polish words.
- Keep text short and exact. Too many elements in one image degrades everything.
- Fetch old chats with ONE `get_chat_images` call listing all `chat_ids`, never parallel calls.
