---
name: figma-transpose
description: Deterministic Figma-to-web transposition for full page sets — durable local extraction, verbatim copy transcription, licensed-icon matching, and bulk 2x image export with placeholder slots. Use when implementing designed pages from a Figma file, extracting a Figma board for later builds, exporting Figma node images in bulk, or when the user mentions transposing/implementing Figma designs, placeholder-image workflows, or Figma asset extraction.
---

# Figma → web transposition

A pipeline for turning a Figma board of designed pages into shipped pages with 1:1 copy, licensed vector icons, and pixel-exact imagery — without vision-model improvisation. Everything is pulled once into durable local files; the build reads disk, never live Figma. Stack-agnostic: the rules hold for any framework and for any CMS or none.

## Core principles

- **Diagnose access before planning anything.** Route, seat, and export permission decide which phases are even possible. See Phase 0.
- **Pull once, persist, build from disk.** Every Figma read is saved verbatim under `.figma/<page>/` in the repo (gitignored). The build and all verification reference these files, never re-hit Figma.
- **Pull wide, not deep.** One page-level call beats forty section calls; per-node calls are the exception, not the unit of work.
- **Deterministic over visual.** Copy comes from extracted text nodes, dimensions from node attributes, icons from name+geometry matching. Screenshots are for orientation and QA only. Never hand-draw an SVG, never transcribe copy from pixels.
- **Distill with a script, not by reading.** Parse the returned markup mechanically. Eyeballing 200k chars is how copy drifts.
- **Placeholders are first-class.** Every image slot renders a labeled placeholder (dashed box showing its expected file name + aspect ratio) until a file exists at that path. Dropping the export in is the entire switch — no call-site edits.
- **Surface designer questions, never resolve them silently.** Conflicting copy across breakpoints, `data-annotations`, hidden layers: each becomes a flagged question in the spec.
- **Verify with fresh eyes.** After transcription, spawn independent agents to diff the shipped content against the RAW pulls character-by-character. They audit the fix log too. This catches real bugs (swapped card bodies, silent apostrophe swaps).

## Phase 0 — Access diagnosis (do this first; it is cheap and it gates everything)

Three routes exist and fail for different reasons:

- **REST API + PAT** needs view access AND the file's "Allow viewers to copy, share, and export" toggle. Without the toggle every node and image endpoint returns 403 "File not exportable" while `/meta` still answers and reports your `role`. Use `/meta` as the probe.
- **Remote MCP** (`mcp.figma.com`, OAuth) and **desktop Dev Mode MCP** (`localhost:3845`) gate on the OAuth'd user's *seat*: Dev or Full on the plan that owns the file. The MCP path can succeed on files REST calls "not exportable".

When access fails, run `whoami` before anything else — it lists every plan and seat. OAuth binds silently to whichever Figma account the browser is logged into, so "access denied" is usually the wrong account, not a missing grant. Confirm the email matches the account that was invited, then check its seat on the file's org.

Rate limits: Dev/Full seat on an Organization plan = 200 reads/day, 20/min. View seats get 6/month. Budget calls before spending them.

## Phase 1 — Extraction (Figma MCP)

1. `get_metadata` on the board node → full topology (ids, names, x/y/w/h). Save it. This is the map; never ask Figma "what's here" again.
2. **Pull the whole page frame in ONE `get_design_context`** with `forceCode: true` and `excludeScreenshot: true`. A 1440x12000 page returns complete (~220k chars, ~70 asset URLs) in a single call. The harness auto-persists oversized results to the session's tool-results dir — copy that file into `.figma/<page>/raw/` verbatim rather than retyping the response.
3. Reserve per-section `get_design_context` calls for (a) nodes the page pull omitted, (b) QA screenshots.
   - **Budget the screenshots up front.** Each per-section `get_screenshot` costs one call. Take the full set immediately after the page pull, before builders start. Hitting the cap mid-review leaves half the reference images as low-res crops of the whole-frame render.
4. **Completeness check**: the code ends with its closing brace, and every top-level child id from `get_metadata` appears as a `data-node-id`.
5. **Hidden layers**: `get_metadata` lists them; the page-level context OMITS them. A direct call on a hidden node returns code plus a blank screenshot. Record them in `meta/hidden-sections.md` instead of building them.
6. **Truncation**: if a per-node pull cuts mid-tree, `get_metadata` the section, then re-pull missing child subtrees into lettered companions (`03b-…`) until covered.
7. **Breakpoints**: pull the primary (desktop) frame by default. Pull mobile/tablet only to find (a) alternate copy, (b) lockups that cannot reflow (compare table → stacked rows, carousel → slider, tabs). Then make the desktop component responsive to that behavior. Diff the text sets across breakpoints with a script and FLAG every difference as a designer question ("which copy is canonical?"); mobile frames routinely carry a different H1, different product naming, and different numbers.
8. **Variables**: `get_variable_defs` on the page frame once → `meta/variables.json`. It yields the file's named type styles (`Desktop/headline-1: 40px/1.15/-4%`) and semantic colors, which is the correct source for mapping onto the repo's tokens.
9. **Assets**: download every `figma.com/api/mcp/asset/*` URL (same CDN as screenshots; they expire ~7 days). Send a browser User-Agent. Name files by content sha256 (first 16 hex) — dedupe is large (202 references → 98 files is typical) and repeated hashes reveal the design's real icon set. Keep `assets-map.json` (url → file → occurrences by node id).
   - **WAF trap**: the CDN intermittently returns EMPTY bodies to plain curl. The empty-content hash `e3b0c44298fc1c14…` in the asset dir means downloads silently failed — audit for it (`file assets/*` shows "empty").
10. Parallelize with one extraction agent per page; they share the asset dir safely via content-hash names.

## Phase 1b — Distillation (script, not reading)

Scripts ship with this skill: `node scripts/distill.mjs <breakpoint> <raw.full.txt> <out.md> <out.json> [assets-map.json]` (the tokenizer below) and `scripts/fetch-asset.sh <url> [ext]` (browser-UA download into `assets/` named by content hash; set `FIGMA_PAGE_DIR` or run it from the page dir). Capture scripts for QA live in the `figma-review-page` skill.


`get_design_context` returns React + Tailwind JSX whatever the target stack, so the distiller parses that export format, not the repo's. Walk the JSX with a tag tokenizer, split on the page frame's top-level children, and emit per section:

- `data-annotations` FIRST — designer notes ("Price soon to be final", "Logos coming", "Don't map button yet") are build instructions, so they head the section.
- Verbatim copy in document order, each line with its node id and the style classes on its text node.
- Image slots with the parent frame's pixel dimensions and the local asset file.
- Icon/vector list.
- The set of `var(--token)` names used.

That output is `spec.md` per page: a verbatim semantic outline plus layout notes, repeated-template observations, and explicit flags for placeholder content ("XXX" testimonials), empty frames, hidden sections, breakpoint copy conflicts, and source typos.

## Phase 2 — Build (components + content files)

- One props-driven component per section, plus one typed content file per page (copy verbatim; fix only obvious typos and log every fix in a per-page `copy-fixes.md`). A registry maps slug → content. Text inside mock illustrations is NOT page copy — it lives in the exported image.
- With a CMS in play, the section component stays framework-only and a thin adapter maps CMS fields onto its props, so the same component serves a code-driven preview route and a CMS story.
- Media slots: `{ name, width, height, alt }` with dims from the design's INNER visual frames. Optional per-slot knobs that earn their keep: `src` (reuse an existing site asset), `overhang` (art that spills past its frame), `fade: false` (opt out of the bottom melt).
- **Alignment rule**: side-by-side cards must share identical media dims — the container owns geometry (aspect-ratio + object-cover), images can never shift text. Normalize a few-px outlier dims to the row's value; cover absorbs it invisibly.
- **Icons: detect the project's source before matching.** Never assume a licensed library is in use. Check in order: an npm icon package in the manifest (phosphor, lucide, heroicons, iconify, tabler); a static icon directory (`public/icons/*.svg`, often Phosphor-named exports at 32px viewBox); inline SVG components using `currentColor`. Match the design's icons against THAT source by name and geometry.
- Matching against a real library: search the aria-label taxonomy, then VERIFY geometry — rasterize both sides and compare ink overlap (IoU ≥ ~0.92 = match). Name-only search misses ~half, and anonymous `imgVector` layers are matchable by geometry alone.
- When the design's icons are a handful of simple 1.5px-stroke glyphs (arrow-right, plus, check, star, close) and the project's set is a filled 32px export that doesn't match geometrically, render the extracted SVGs as inline `currentColor` components. Never force a lookalike from the project set.
- **Parallel lanes touch only their own files.** Pre-wire the section registry with no-op stub files so every lane renders as it lands. A lane that "helpfully" rewrites a shared file costs a restore and a broadcast to everyone mid-edit. Say this in every lane brief.

## Phase 2b — Build-time rules the export hides

The exported code flattens effects and drops layout context. These are the recurring gaps.

- **Progressive blurs.** Figma's "Background blur (progressive)" (blur ramping 0 → N along an axis) exports as ONE flat `backdrop-blur-[N/2]`, so treat every backdrop-blur value in a pull as a candidate ramp. Confirm in the inspector (Shadows and blurs → "Background blur (progressive)", X/Y start–end, start/end blur); with no inspector, read the exported value as the midpoint (0 → 2N). Implement it code-driven: a stack of masked `backdrop-filter` layers, radii doubling 1→N, mask windows stepping down the band. Never bake it into an asset — the design's photos stay untouched, and text over the band sits above the stack, crisp. Hero bottom bands and card description bands are the usual sites.
- **Layer blurs are not backdrop blurs.** A layer blur on an illustration piece belongs on the fill element only, clipped to the chart or illustration box, never on text inside the same group.
- **Full-bleed sections keep copy in the page container.** A hero whose photo and blur bands run edge to edge still positions its headline, buttons and USP row inside the site container the nav uses. At frame width the difference is invisible, so QA every full-bleed section at a viewport wider than the frame (1920).
- **No dead controls.** An accordion, tab set or carousel whose items have no copy in the design gets an explicit placeholder string ("[Placeholder] answer copy not yet provided in the design"), logged in `copy-fixes.md`, so the control still expands. Never ship a control that does nothing; never invent the missing copy.
- **Dividers are per-page options, not section chrome.** Metadata "Divider" vectors say a line exists in THAT frame. Verify against the render before adding one — a line at a band edge between two different backgrounds usually is not there. Where the repo treats dividers as their own blocks, the page composes them explicitly and no section draws a trailing hairline unless the frame draws it inside the section.
- **Focus-mounted third-party widgets go out of flow.** Turnstile, reCAPTCHA and chat widgets that mount on first focus shift bottom-pinned or fixed-height layouts. Position them absolutely, or use the provider's invisible / interaction-only mode.
- **Design values beat repo spacing tokens when they differ.** "1:1" means the frame's 60px, not the token's 80px. Tokens are a vocabulary for naming what the design uses, not an override. Log every place a token was chosen over the frame value as a deviation.
- **Unspecced surfaces ship as the frame.** An embed with no API, a form with no target: render the frame's static image, or a `#` link, behind a single prop or slot the real thing replaces later. Spend no effort past matching the frame.
- **Viewport-dependent sizing is set after mount.** A ref assigned from `window` during setup differs between server and client render, and frameworks that skip patching attribute mismatches leave the server value in the DOM (a 670px card on a 390px screen). Set it in the mounted hook so a real re-render runs.
- **Breakpoint-bounded variants use ranges.** A style meant for one breakpoint band only (`md:` up to `2xl:`) is written as a range (`md:max-2xl:`), never as a plain `md:` expecting `2xl:` to win; utility order in the compiled cascade decides otherwise and both variants render at once.
- **Comment density matches the repo.** One header per component (what it is, its CMS name, at most one node id). No per-block node-id comments, no narrative about the brief or the design. Run a comment-hygiene pass over the whole diff before review, and codify the rule in the repo's agent instructions file when it lacks one.

## Phase 3 — Bulk image export

`get_screenshot` renders 1x only. Two routes give true 2x:

- **MCP `download_assets`** (`defaultFormat`, `defaultScale` up to 4, one node per call): returns a node render plus its raw source images and vector SVGs, but it is gated on EDIT access, the same as REST export. `get_design_context` and `get_screenshot` keep working on view-only files; `download_assets` does not.
- **REST** `GET /v1/images/:fileKey?ids=…&scale=2&format=png` with `X-Figma-Token`: batches many ids per call, but needs the viewer-export toggle (Phase 0).
- **View-only fallback**: the asset URLs inside `get_design_context` are the ORIGINAL uploaded fills (a 1727x911 photo behind a 1440 hero, 840x1480 behind a 420x740 card), so they often already exceed 2x; use them. Check each slot's asset dims against its frame first — a 1727-wide photo behind a 1440 hero is ~1.2x, and that is the maximum the file holds. Never promise "2x exports" a view-only file cannot produce. For composed illustrations with no single image fill, rebuild the composition from its vector pieces (`get_screenshot` never upscales: `maxDimension` only caps, and the reply's `width` equals `original_width` for small nodes).

1. Build an `export-map.json` per page: slot name → node id of the **inner visual frame** (never the card container — corner radius, borders, and captions are code-drawn; exporting them double-bakes chrome).
2. Batch ids per API call; verify every download is a real PNG at exactly 2x the slot dims before placing it under the site's public asset dir. Refuse mismatches.
3. **Overflow classes** (renders that don't match frame dims):
   - Check `GET /v1/files/:key/nodes?ids=…`: `absoluteRenderBounds` vs `absoluteBoundingBox` classifies every slot up front.
   - Unclipped frames whose art/shadows overflow → default export inflates to the union bbox. `use_absolute_bounds=true` crops to the frame — but that AMPUTATES art Figma actually displays. For art meant to spill (badges, tiles), export boundless and render with the `overhang` mode (container keeps frame aspect; image extends; the card clips at its rounded bounds, same as Figma).
   - Compositions with no clean wrapper node (rotated screenshot + floating card; stacked variant pair) → export pieces and composite locally (sharp), or find the smallest parent that clips correctly.
4. **Bleed layouts** (art positioned inside a column and cropped by its edges): reproduce with width-relative units. CSS `top: %` resolves against HEIGHT and breaks when the row flexes — use `margin-top: %` (resolves against WIDTH) so the crop fraction matches Figma at any size.
5. Harsh bottom edges on full-bleed mocks: a tunable mask utility — `mask-image: linear-gradient(black calc(100% - var(--media-fade)), transparent)` with the strength as a design token and a per-slot opt-out. ~12% reads intentional for flush-to-edge app windows; 5% is too shallow.
6. Token hygiene: keep the PAT in a chmod-600 scratch file outside the repo, delete after, tell the user to revoke it.

## Multi-language files (only when the board has them)

Most projects have none; skip this section unless `get_metadata` shows per-language page frames or asset sections (names like `Home_DE`, `Pricing_Assets → EN / FR / DE`). When it does:

- Treat one language as canonical for the build (the operator says which; usually the one the page frames were pulled in) and pull the other language sections once, by the Phase 1 rules, into the same `.figma/<page>/` tree.
- Pair frames across languages by name (`Hero_EN_asset_01` ↔ `Hero_FR_asset_01`) into `assets-locales.json` (slot → locale → file); a slot present in one language only is a designer question, not a fallback.
- How translated copy and per-locale images are stored is project-specific: read the repo's own docs before touching anything (field-level translation on one entry, separate entries per locale, or code-side i18n files are all common). Write the locale values in the same script that writes the default ones, never as a separate manual pass. (Example: Storyblok field-level translation stores them as `<field>__i18n__<locale>` on the entry, and only for fields flagged translatable.)
- A page showing one language's mockups or copy on another language's URL is this step skipped, not a rendering bug; log it as a content gap.

## CMS-backed sites

Snapshot the CMS side into `.figma/<page>/cms/` via its read/delivery API with a preview token: the live page entry, a "kitchen sink" entry if one exists, and site settings. (With the CMS's own MCP connected, the preview token is usually one call away — Storyblok's `getSpace` returns it as `first_token` — so a missing `.env` is not a blocker.) The spec then states which existing sections/blocks each design section maps to, instead of proposing new ones. When a section repeats across pages (logo cloud, footer bands) and the CMS has a shared-block mechanism, the spec names it a shared component from the start, so the block lands in the right place instead of being duplicated per page. Check for entries or blocks modified on the extraction date — a client dev may already be building against the same file.

## Screenshot QA mechanics

- Capture with Playwright on `channel: "chrome"` — it uses the installed browser and downloads nothing.
- Scroll the page top to bottom before capturing so lazy images load.
- Hide dev overlays first: the framework's devtools pill, the build watcher, the error overlay.
- Use a real viewport for mobile: the headless Chrome CLI clamps width at 500px.
- Chunk 2x captures to stay under 16k device pixels per shot.
- First numeric parity check is section height, Figma → build, section by section.

## Verification gates (each is cheap; skipping them is how errors ship)

- Access: `whoami` seat + `/meta` role recorded before any bulk pull is planned.
- Copy: independent per-page verify agents against raw pulls (exact strings, nothing missing, order, no invented text, fix-log accuracy).
- Assets: `file` every download; grep for the empty hash.
- Images: dims == 2x slot, then a final aspect audit (slot ratio vs placed PNG ratio) to surface anything silently relying on cover-crop.
- Pages: lint + typecheck + smoke every route; screenshot the tricky regions yourself (headless browser) and compare against the user's Figma screenshots rather than asking them to re-check your math.
- Full-bleed: every edge-to-edge section re-checked at 1920 — copy still inside the container, art still bleeding.
- Interaction: every accordion, tab and carousel control exercised once; nothing dead.
- Forms: focus into each field and confirm no layout shift.
- Blur bands: read as ramps, not as a hard edge at the band boundary.
- Comments: density audited across the diff before review.
