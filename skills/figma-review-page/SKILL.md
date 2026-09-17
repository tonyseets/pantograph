---
name: figma-review-page
description: Build a mobile-friendly Figma-vs-build review page — per-section design/build pairs, a whole-page pair, a mobile strip, findings and open questions — captured with Playwright and published as an Artifact, one page or several behind tabs. Use when the user asks for a design-parity page, a Figma vs build comparison, screenshots of the build to review, or a QA page on one link they can open anywhere.
---

# Figma vs build review page

One mobile-friendly link the reviewer can open anywhere: the design next to the build, section by section, with the numbers that show where they diverge. Screenshots and findings carry the review. Prose does not.

## What the page contains, in order

1. Title, one lead line, status pills (gates passed, page height vs frame height, anything deliberately untouched).
2. A jump-link row for the sections.
3. Whole-page pair: Figma frame beside the full build capture, both scaled to ~720 wide.
4. Per-section pairs, one card each: name, status pill, `Figma px → build px`, the two images, and at most two or three notes on what the section does or defers.
   A page with no Figma references renders the same cards single-column, build only, with the height alone in the header and one line saying why.
5. Mobile strip: the build at 390, cut into readable chunks.
6. Findings table (area → state): reuse vs new, tokens, primitives, out of scope.
7. Open questions for the designer — every conflict the build could not resolve.
8. Next steps.

Principles:

- **Height deltas are the finding.** `868px → 869px` says parity; `768px → 800px` says look here. Put them in every card header.
- **A note earns its place by naming a decision.** What was rebuilt, what is a placeholder, what the design says that the build deliberately ignores. Never narrate the obvious.
- **Every unresolved conflict becomes an open question, never a silent choice.** Breakpoint copy that disagrees, duplicated labels, placeholder addresses, assets that do not match the design.
- **One artifact per review, not one per page.** Several pages go behind tabs so the reviewer has a single link.
- **Publish once.** The page is a deliverable, not a draft to iterate on in front of the reviewer.

## Inputs to gather first

- Preview URL of the built page, plus the wrapper selector whose children are the sections (default `main > div`; `header` and `footer` are picked up separately).
- The Figma frame's top-level section list with `y` and `height` in frame coordinates, from the page's `spec` if the transposition produced one, otherwise `get_metadata` on the frame.
- Any crisp per-section Figma renders already on disk (`.figma/<project>/screenshots/sections/*.png`).
- Viewport widths: 1440 desktop and 390 mobile unless the design says otherwise.
- Per section: display name, status pill (`new`, `existing`, `existing + variant`, `new · global component`), notes.

Write all of it into one JSON config and drive the build from that. See `scripts/config.example.json`.

## Capture

`npm i playwright` in the working directory. All three scripts launch `channel: "chrome"`, so nothing downloads a browser.

- `node scripts/sections.mjs <url> out.png [w] [h] [wrapper] [header] [footer]` — desktop full-page capture plus `out.json` with the bounding box of every wrapper child, the header and the footer. Build crops come from these boxes.
- `node scripts/shot.mjs <url> out.png [w] [h] [scale] [hideSelector]` — plain full-page capture for the mobile pass or any extra shot.
- `node scripts/shot2x.mjs <url> out.png [w] [h] [chunkCssPx]` — DPR-2 capture in vertical chunks.

Rules the scripts already encode, and which matter if you write your own:

- **Scroll the whole page before shooting.** Lazy images decode on intersection; a cold `fullPage` screenshot returns blank slots.
- **Hide dev overlays.** Nuxt devtools pill, Next build watcher, Vite error overlay. The scripts inject a hiding stylesheet.
- **Chrome refuses a screenshot taller than ~16k device pixels.** At DPR 1 a tall page is fine. At DPR 2 it is not, so capture clipped chunks of ~5000 CSS px each.
- **Headless Chrome's CLI cannot lay out below 500px.** Mobile widths only work through Playwright's viewport, never `--window-size` or `--screenshot` flags.
- 1x is enough for the desktop page and for the section crops. Reserve 2x for the mobile strip, where the reviewer reads real text.

## Figma references

- **Prefer crisp per-node `get_screenshot` renders.** One call per node, each one rate-limited: a Dev or Full seat gets 200 reads/day, a View seat 6/month. Pull them early in the build, while budget exists, not at review time.
- **Fall back to the whole-frame render cropped by node `y`/`height`,** scaled by `render.width / frameWidth`. Label those `Figma · low-res render` so nobody reads blur as a build defect. The assembler does this automatically when no per-section render exists.
- **Never re-pull renders that are on disk.** Point `figma.sectionDir` at them.
- Crisp renders go in at the frame width (1440), never upscaled past it.

## Image budget

Native width, progressive JPEG, quality 80–85, `loading="lazy"` on everything below the first pair. Rough encoded size per image, base64 included:

| image | encoded |
|---|---|
| section pair, 1440 wide | 70–170 KB each |
| whole-page pair at 720 wide | 250–500 KB each |
| mobile chunk, 5000 CSS px at DPR 2 | ~700 KB each |

A fifteen-section page with a whole-page pair and four 2x mobile chunks lands near 5 MB, so three or four pages fit in one artifact. The Artifact cap is 16 MB and the assembler warns past 14. When a build approaches it, narrow the whole-page pairs first, then drop a mobile strip to 1x, then cut sections from the least interesting page.

## Page rules

The page is an Artifact, so the Artifact contract applies:

- No `<html>`, `<head>` or `<body>` wrapper. `<title>` is a name of two to four words, not a sentence.
- Colors are tokens on `:root`, redefined under both `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`. `body` carries an explicit background.
- 16px side gutters, `img { max-width:100% }`, no horizontal page scroll. The pair grid is one column and goes two-up at 760px, so a phone gets Figma above build.
- Look at the page at 390 before publishing. Then publish once, with a favicon, and stop.
- Keep it bare. Text holds to a reading measure (`--measure`, 64ch) and never runs the full width. Sections are separated by a rule, not boxed. Status notes are one plain line of text, not badges.
- Every image opens in the template's lightbox on tap or click. Previous and next buttons, the left and right arrow keys, and Escape step through every image on the page. The script is a few dozen lines with no dependencies; leave it in.

`scripts/template.html` holds this structure and its CSS; the assembler fills the placeholders.

## Assembling

```
node scripts/build_page.mjs config.json -o review.html
```

Needs `npm i sharp` in the working directory, next to Playwright. It crops each build section out of the full capture by bounding box, picks the crisp or low-res Figma reference per section, encodes both as progressive JPEG data URIs, and writes the filled template. It prints the page size and warns past 15 MB.

Config notes:

- `desktop.sectionTag` filters the wrapper's children (`"SECTION"` skips stray divs). Sections map onto the filtered list in config order; `"rect": "footer"`, `"rect": "header"` or an integer index overrides one.
- A section uses `figma.sectionDir/<id>.png` when that file exists, otherwise `y`/`h` against `figma.wholeRender`.
- `"buildOnly": true` on a page allows sections with no Figma reference at all: each card renders one build figure, the header shows the build height alone, and the section note explains the absence.
- `lead`, `findings[].state`, `questions[]` and `next[]` render as inline HTML. Section names, statuses and notes are escaped.
- Omitting `mobile`, `questions` or `next` drops that block from the page.
- Re-running after a fresh capture rebuilds the page; nothing is incremental.

## Multi-page

Several pages ship as one artifact with a tab switcher. The config grows a `pages` array; each entry is a single-page config plus `id` and `label`. A single-page config still works unchanged.

```json
{
  "title": "Design Parity Review",
  "lead": "Three pages, one artifact.",
  "defaults": { "desktop": { "width": 1440, "sectionTag": "SECTION" }, "mobile": { "width": 390 } },
  "pages": [
    { "id": "home", "label": "Home", "desktop": { "png": "home-1440.png", "rects": "home-1440.json" }, "sections": [] },
    { "id": "pricing", "label": "Pricing", "buildOnly": true, "desktop": { "png": "pricing-1440.png", "rects": "pricing-1440.json" }, "sections": [] }
  ]
}
```

What the switcher does, all of it already in the template:

- Pill buttons in a `role="tablist"`, so Tab reaches them and Left/Right moves between them. Panels toggle the `hidden` attribute, never a display style, so nothing renders or decodes in a closed tab.
- The chosen tab is remembered in `localStorage` inside try/catch, and the URL hash wins over it on load. `#pricing` opens that page; `#pricing-hero` opens it and jumps to the section.
- Every section id, and the mobile, findings, questions and next anchors, are prefixed with the page id, so anchors never collide across pages.
- Every image below the first page's whole-page pair is `loading="lazy"`, so a closed tab costs nothing until it opens.

`defaults` is shallow-merged under each page, so shared capture settings are written once. The assembler prints the byte size of each page and warns past 14 MB.

## Checklist

- [ ] Sections captured with bounding boxes; the count matches the config.
- [ ] Every section has a Figma reference, and the low-res ones are labelled.
- [ ] Height deltas read `Figma → build` and are drawn from the live capture, not typed.
- [ ] Mobile strip covers the full page, top to footer.
- [ ] Every conflict the build could not resolve appears as an open question.
- [ ] Multi-page: tabs reachable by keyboard, hash deep link opens the right tab, no duplicate ids.
- [ ] Page under 16 MB, per-page sizes printed, checked at 390, no horizontal scroll.
- [ ] Published once; the URL goes back to the operator.
