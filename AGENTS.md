# AGENTS.md

Pantograph packages skills for Figma-to-web work, `figma-transpose` (the pipeline) and `figma-review-page` (the design-vs-build comparison page), plus `figpipe`, a dependency-free Node CLI that watches Figma for handoffs, batches them and runs one guarded Claude session per batch, with its two skills: `figma-setup` (onboarding and doctor) and `figma-batch` (what a batch session does). Nothing needs building; `figpipe` needs Node 22.5 or newer.

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
4. **Surface designer questions, never resolve them silently.** Breakpoint copy conflicts, annotations, hidden layers, placeholder content: each becomes a flagged question in the spec. Two frames that disagree on the same copy (a page frame and a section's own spec frame, or two generations of one frame): build the spec frame, else the later one (version history shows when a node appeared; node ids grow within a session), and record the other wording as a question without waiting on it.
5. **States come from component sets.** A frame shows each control in one state. Hover, focus, checked, filled, error, disabled and open, and the prototype interactions between them (trigger, target state, duration, easing), are read from the component sets behind its instances and built as designed, without asking. For a state with no design the builder proposes one from the same element elsewhere in the file, then the project's own component, then on a project with nothing to follow the platform's usual states, and records the source. In an interactive session it asks the user once, listing each element with its proposed states; in a figpipe batch it builds the proposal and the report asks. A file without component sets is ordinary.

## figpipe

- `figpipe/REFERENCE.md` holds the commands, file layout, state tables, the session contract and the rails.
- Tests: `node --test tests/figpipe/*.test.mjs`. They run against recorded Figma responses in `tests/figpipe/fixtures/tern/`, with every name, copy string, comment, person and file key rewritten to a made-up site (Tern). Re-record with `tests/figpipe/record-fixtures.mjs` (read-only, scrubs URLs and emails only); a recording of a client file carries its names and copy, so rewrite them the same way before committing. This repo is public.
- The Figma REST tools live once, in `skills/figma-transpose/scripts/figma-rest.mjs`, `figma-nodes.mjs`, `figma-components.mjs` and `figma-read.mjs`. figpipe imports them; do not copy them elsewhere.
- figpipe never pushes, posts, messages or writes to Figma, and the code enforces it. Keep it that way in every change.
- `figpipe report --sample` renders a made-up batch with every report block; use it to check report changes by eye.

## Reference

- `skills/figma-transpose/SKILL.md` — access diagnosis, extraction, distillation, build, image export, verification gates.
- `skills/figma-review-page/SKILL.md` — capture, Figma references, image budget, page rules, multi-page tabs.
- `figpipe/REFERENCE.md` — the handoff watcher, batcher and session runner.
- `skills/figma-setup/SKILL.md` — onboarding a project to figpipe, and doctor mode.
- `skills/figma-batch/SKILL.md` — one batch: triage, build lanes, verify at three widths, review, record.

The skills are stack-agnostic and hold for any framework, CMS or none. Project specifics belong in the host repo's own AGENTS.md, not here.
