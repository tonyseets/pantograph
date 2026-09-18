# Pantograph

A pantograph copies a drawing by linkage, not by eye. This does the same for Figma pages: pulled once, distilled by script, built from disk, verified against the source.

Two skills for a coding agent that turn a Figma board of designed pages into shipped web pages, without letting the agent guess at anything it could read.

The method is deterministic. The agent pulls the design once into durable local files, distills copy and image slots out of them with a script instead of reading 200k characters by eye, builds from disk, and verifies with independent audits. Copy comes from the design's text nodes, dimensions from node attributes, icons from name and geometry matching. Screenshots are for orientation and QA, never for transcription.

The second skill turns the result into a review page: the Figma frame beside the build, section by section, with the height deltas that show where they diverge. The page is mobile friendly, so the work can be checked at a desk or on the go.

## Who this is for

Anyone rebuilding a designed site from Figma with a coding agent, in any framework, with any CMS or none. The skills carry the method. Project specifics stay in the host repo.

Pantograph grew up on marketing sites, mostly B2B, and that is where it has worked well. Other kinds of projects may need some massaging, and your mileage may vary.

## Prerequisites

- **A Figma seat that can read the file.** Dev or Full on the plan that owns it. View seats get roughly six MCP reads a month, which is not enough for a page. Dev or Full on an Organization plan gets 200 reads a day, 20 a minute.
- **The Figma MCP server connected in your harness.** Either the remote server over OAuth, or the desktop app's Dev Mode server on localhost. OAuth binds to whichever Figma account the browser is signed into, so check the email before blaming permissions.
- **Node 18 or newer** for every script, with `npm i playwright` in the working directory. The scripts launch `channel: "chrome"`, so they use installed Google Chrome and download no browser.
- **sharp** (`npm i sharp`, next to Playwright) for the review page assembler. The distiller has no dependencies.
- **curl**, for asset downloads.
- **Somewhere to publish the review page**: a harness that can publish an Artifact, or any static host.

## Install

One command, from a clone of this repo:

```sh
./install.sh --harness claude     # ~/.claude/skills/
./install.sh --harness codex      # ~/.agents/skills/
./install.sh --harness cursor     # ~/.cursor/skills/
./install.sh --harness grok       # ~/.grok/skills/
./install.sh --harness project --target /path/to/repo   # <repo>/.claude/skills/
./install.sh --harness all
```

Symlinks by default, so a `git pull` here updates every harness at once. Pass `--copy` for independent copies, and `--uninstall` to remove the symlinks again (copies are left alone). An existing real directory at the destination is moved aside to `<name>.bak-<epoch>` first.

For a harness the script does not know, copy `skills/figma-transpose` and `skills/figma-review-page` into wherever it reads skills from.

## How to use

Copy a link to the frame you want built. In Figma, select the page frame, right-click, and choose Copy link to selection. Hand that link to your agent with a plain instruction:

```
Build this page with figma-transpose: <figma link>
It goes at /pricing in this repo.
```

The agent checks its Figma access, pulls the frame once into `.figma/`, distills it, and builds from there. Anything the design leaves unclear comes back as a question, not a guess.

When the build is up, ask for the comparison:

```
Make a review page for /pricing with figma-review-page.
```

That gives you one link with the Figma frame beside the build, section by section.

A few things that help:

- Link the whole page frame, not a single layer. The pipeline is built around one pull per page.
- Say where the page lives in your repo and which framework or CMS conventions to follow, or keep those in your repo's own AGENTS.md.
- For several pages, give all the links at once. The agent can pull them in parallel and share one asset folder.

## How a run goes

**Access first.** The agent checks which Figma account it is actually authenticated as and what seat that account holds on the file. Route, seat and export permission decide which phases are possible at all, and this check is cheap. A file that the REST API calls "not exportable" often still answers over MCP.

**Extraction.** One metadata call maps the board. One design-context call pulls a whole page frame, often 200k characters and seventy asset URLs at once, and the result is saved verbatim under `.figma/<page>/`. Per-node calls are the exception. Screenshots for QA get budgeted and taken up front, before the read limit is spent. Every asset URL is downloaded and named by content hash, which deduplicates hard and reveals the design's real icon set.

**Distillation.** A script walks the exported markup and emits a spec per page: designer annotations first, then every copy line in document order with its node id and type styles, then image slots with pixel dimensions, icons, and the design tokens each section uses. Conflicts between breakpoints, hidden layers and placeholder content become flagged questions instead of quiet decisions.

**Build.** One component per section, one content file per page, copy verbatim with every typo fix logged. Image slots render a labeled dashed placeholder until a real file exists at the path, so dropping in an export is the whole switch. The skill also lists what the Figma export silently flattens: progressive blurs that arrive as one flat value, full-bleed sections whose copy still belongs in the page container, dividers that are not really there.

**Export and verify.** Images come out at true 2x where the file allows it, and the skill is explicit about what a view-only file can and cannot produce. Then the gates: independent agents diff the shipped copy against the raw pulls character by character, every asset is checked for the empty-file hash the Figma CDN sometimes returns, every image is checked against its slot ratio, every route is linted and screenshotted.

**Review.** The review skill captures the build with Playwright, crops each section by its live bounding box, pairs it with the Figma render, and assembles one page with height deltas, findings, and open questions for the designer.

Read `skills/figma-transpose/SKILL.md` for the pipeline and `skills/figma-review-page/SKILL.md` for the review page.

## The scripts

- `skills/figma-transpose/scripts/distill.mjs` — parses a raw design-context pull into a per-section spec, in Markdown and JSON.
- `skills/figma-transpose/scripts/fetch-asset.sh` — downloads one Figma asset URL with a browser user agent, names it by content hash, refuses empty bodies.
- `skills/figma-review-page/scripts/sections.mjs` — full-page desktop capture plus the bounding box of every section.
- `skills/figma-review-page/scripts/shot.mjs` — plain full-page capture at any viewport.
- `skills/figma-review-page/scripts/shot2x.mjs` — DPR-2 capture in vertical chunks, under Chrome's height ceiling.
- `skills/figma-review-page/scripts/build_page.mjs` — crops, pairs and encodes everything into one self-contained review page.

`examples/` holds a review config to copy and a short example of what a distilled section spec looks like.

## What this is not

It does not generate design. It does not look at an image and guess at pixels. Nothing here invents copy, and no icon gets drawn by hand. When the design is ambiguous, the answer is a question for the designer, not a decision by the agent.

## License

MIT. See `LICENSE`.
