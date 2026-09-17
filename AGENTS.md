# AGENTS.md

Pantograph packages two skills for Figma-to-web work: `figma-transpose` (the pipeline) and `figma-review-page` (the design-vs-build comparison page). The skills are the product; there is nothing to build here.

## Setup

Run `./install.sh --harness <claude|codex|cursor|grok|project|all>`, or copy `skills/*` into the harness's skills directory. Symlinks are the default so repo updates propagate; `--copy` and `--uninstall` are available.

Load `figma-transpose` before any Figma-to-code work, and `figma-review-page` when a comparison page is wanted.

## Verify before starting a run

- Figma MCP server connected, remote OAuth or desktop Dev Mode.
- `whoami` returns the expected account, with a Dev or Full seat on the plan that owns the file. A View seat has roughly six reads a month.
- `npm i playwright` in the working directory, and Google Chrome installed. The capture scripts use `channel: "chrome"`.
- `npm i sharp` in the working directory, for the review page assembler.
- `curl` present.
- Somewhere to publish the review page: a harness that can publish an Artifact, or any static host.

## The rules that matter most

1. **Pull once, persist, build from disk.** Every Figma read lands verbatim in `.figma/<page>/`. The build and all verification read those files.
2. **Distill with the script, not by reading.** `scripts/distill.mjs` parses the export mechanically. Eyeballing the markup is how copy drifts.
3. **Never invent copy, icons or dimensions.** Copy comes from text nodes, dimensions from node attributes, icons from the project's own licensed source matched by name and geometry.
4. **Surface designer questions, never resolve them silently.** Breakpoint copy conflicts, annotations, hidden layers, placeholder content: each becomes a flagged question in the spec.

## Reference

- `skills/figma-transpose/SKILL.md` — access diagnosis, extraction, distillation, build, image export, verification gates.
- `skills/figma-review-page/SKILL.md` — capture, Figma references, image budget, page rules, multi-page tabs.

The skills are stack-agnostic and hold for any framework, CMS or none. Project specifics belong in the host repo's own AGENTS.md, not here.
