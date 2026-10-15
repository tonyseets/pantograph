# figpipe reference

`figpipe` is the non-AI core of the Figma handoff pipeline. It watches Figma over REST, turns what changed into events, batches them once the designer is quiet, extracts the design and the component sets behind it, and runs one guarded `claude -p` session per batch. Each batch ends in a local report. Nothing is pushed, posted or sent.

Node 22.5 or newer (it uses `node:sqlite`). No dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `figpipe tick [--dry-run] [--backfill] [--project <slug>]` | Reconcile every project whose check is due under its `[schedule]` (every `poll_minutes` without one), batch what is ready, start the oldest ready batch. Silent when nothing is due; `--project` checks that project now. `--dry-run` rolls back every write and prints what it would pick up. `--backfill` treats open threads and current ready marks as new (the first tick on a project is otherwise a silent baseline). |
| `figpipe add <figma-link> [--note "..."] [--project <slug>]` | Queue a node (`?node-id=`) or comment (`#<id>`) by hand; always overrides `[scope]`. Refuses links into a known stale copy. |
| `figpipe own <name\|link> mine\|others [--who "A, B"]` / `own --list [--json]` | Answer whose a section is (saved as a rule, applied at once), or list every ready section with its inferred owner and why. See Scope and ownership. |
| `figpipe watch [<slug>] [--json]` / `watch baseline <slug> [<name\|node>...]` / `watch baseline <slug> --all` | List the watched sections (in-progress designs you pre-built) with where each builds, its state and the last change seen; or record the current Figma design as what your build was made from, after you updated the build by hand. Changes and ready marks that waited for the section are settled; comments stay. Without names: every watched section. `--all`: every watched section and every ready section that is yours (see Scope and ownership), which then count as built from the design as it is. A name may be a watched section or a ready section that is yours. Figma reads only. See Watched sections. |
| `figpipe status [--json]` | Projects, each one's schedule and next check (in this Mac's time and the project's time; in follow mode also the derived working blocks in the designers' time and yours, and when they were derived), waiting items and why they wait, the watched sections with the last change seen and where a moved one sits, the last check's warnings (a page that did not come back, a page renamed away, a stale copy edited), a Figma rate-limit wait, open batches with report paths (a batch that waits for Claude reads `waiting · Claude usage limit hit; retries after <time>`), today's spend. |
| `figpipe run <project> [--now] [--dry-run] [--foreground]` | Batch and start now. `--now` skips the quiet window, review backlog, active hours and pacing; PAUSE, a blocked project, the daily cap and a running batch still apply. |
| `figpipe run --batch <id> [--dry-run]` | Start or retry one batch (resets a stuck one). A batch that is extracting or running with a live process is refused, never started twice. A batch that waits for Claude is tried now; a usage meter that is still full refuses it again. |
| `figpipe extract <batch>` | Redo the REST extraction for a batch. |
| `figpipe record <batch> <result.json> [--partial]` | Store a session result (see `schema/result.schema.json`) and render the report. `--partial` takes any subset (items, not_done, checks, summary) and replaces only what it names; sessions record each item this way as soon as it is settled. |
| `figpipe result <batch>` | The result recorded so far, rebuilt from state.db in `result.schema.json` shape. A session returns it as its final answer. |
| `figpipe capture <batch> --item <id> \| --lane <lane> --as <name> --phase before\|after --url <local url> [--selector css] [--widths ...]` | Headless screenshots at every review width into `captures/<item or name>/<phase>-<width>.png`; prints the rows for the result. `--state <name>` in place of `--phase` saves one state of a built element (`captures/<item>/states/<name>-<width>.png`, at `extract.component_render_scale`, the first review width unless `--widths` is given) after `--click`, `--fill <css> --text "..."`, `--focus`, `--hover` and `--press <css>`, in that order, to set beside a component set's render. Local URLs only. Playwright comes from `FIGPIPE_PLAYWRIGHT`, `~/.figpipe` (install once: `npm i --prefix ~/.figpipe playwright && npx --prefix ~/.figpipe playwright install chromium`), the repo, or Pantograph; never from a lane worktree. The page may load anything but may only send data (POST and the like) to localhost. |
| `figpipe report <batch>` / `--index` / `--sample [--out <dir>]` | Re-render a report or `~/.figpipe/index.html`, or render the sample batch (a made-up project with one of every item kind) into `<dir>` (default `$TMPDIR/figpipe-sample`). |
| `figpipe probe [<repo>] [<figma-link>...] [--pages "A,B"] [--json]` | What setup can infer: stack, dev command and port, checks, CMS, tokens, preview route, worktrees, Figma keys named in the repo; who the token is, each file's identity (same-name copies included), pages, ready-mark depth, breakpoints. Read-only. |
| `figpipe activity [<figma-link>] [--project <slug>] [--days 30] [--tz Zone] [--user-tz Zone] [--user-start 08:00] [--every 60] [--json]` | When the designers of a file work: saved versions, comments and (with `--project`) ready marks of the last N days, per person, in their time and yours, plus what follow mode would do with that activity and a fixed `[schedule]` as the alternative. Your own saves and comments are left out. With `--project`, a file's stale copies are read too (the same designers worked there earlier). Read-only. |
| `figpipe doctor [<slug>] [--json]` | Re-check a project: config, token, schedule (follow mode: the derived blocks; other modes: against recent activity), whether the Mac keeps sleeping through checks, files and stale copies, pages, repo, branches, checks, port, Playwright, Claude, the Claude login (this terminal's against the one the last batch ran under), background check, blocked, stuck or waiting batches. One line per check, each problem with its fix. Exit 1 on any failure. |
| `figpipe ack <batch>` / `reject <batch>` `[--note "..."]` | Mark a batch reviewed or rejected; its queued items never run. The note is kept on the report and the index. Branches with commits are never deleted; a lane the batch made that got no commit and holds no edits is removed (worktree and `figma/` branch). |
| `figpipe pause` / `resume` | Stop or restart new batches. Checks keep recording. |
| `figpipe budget [mcp] [--batch <id> \| --project <slug>]` | Today's spend. `mcp` answers `yes: N left` (exit 0) or `no` (exit 1); sessions ask it before each Figma MCP call. |
| `figpipe config check <slug\|file>` / `config example` | Validate a config, or print the annotated example. |
| `figpipe launchd plist \| install \| uninstall [--minutes N]` | Print the LaunchAgent, or write it under `~/.figpipe/launchd/` and print the `launchctl` commands. The job wakes `tick` every 15 minutes (shorter only when a project polls or runs windows more often, or with `--minutes`); schedules are not written into it. figpipe never runs the commands. |
| `figpipe guard --batch <id>` | PreToolUse hook for batch sessions (exit 2 denies). |
| `figpipe supervise <batch>` | Internal: runs the session with the wall-clock kill, records, reports, notifies. |

`figpipe help` lists your commands first and the ones batch sessions use second.

`FIGPIPE_HOME` overrides `~/.figpipe`. `FIGPIPE_CLAUDE_BIN` overrides the `claude` binary. `FIGMA_API_BASE` overrides `https://api.figma.com` (tests).

## Files

```
figpipe/
  figpipe.mjs                 entry; hides the node:sqlite experimental warning
  lib/cli.mjs                 commands
  lib/config.mjs, toml.mjs    config schema, defaults, strict TOML subset
  lib/schedule.mjs            [schedule]: time zones, due checks, next check, catch-up, follow-mode slots
  lib/follow.mjs              follow mode: derive the designers' blocks, cache them, refresh cadence, status view, wake command
  lib/activity.mjs            when designers work (versions, comments, ready marks), zone guess, suggested schedule
  lib/db.mjs                  state.db schema
  lib/reconcile.mjs           Figma state -> events (meta, comments, ready marks, deep checks, versions, identity)
  lib/batcher.mjs             batching rules, items, lanes
  lib/watch.mjs               watched sections: baselines, the snapshot a build was made from, following a moved section, status view
  lib/names.mjs               section names across languages: "Location_EN" and "Location_GER" share the base "location"
  lib/extract.mjs             node JSON, verbatim copy, tree, structural diff, 2x renders, component sets, threads, motion hints
  lib/run.mjs                 worktrees, push rails, manifest, the free check that Claude can run, session command, supervisor, notification
  lib/guard.mjs               PreToolUse rules, PATH shims, pre-push hook
  lib/record.mjs              result.json (whole or partial) -> items, notes, captures, ledger; and back
  lib/report.mjs              per-batch report and index (static HTML)
  lib/capture.mjs             headless screenshots per review width (Playwright, resolved at run time)
  lib/setup.mjs               probe (repo and Figma facts for setup) and doctor
  lib/sample.mjs              the sample batch behind `report --sample` (generated SVG mock-ups)
  lib/launchd.mjs             plist template and install/uninstall commands
  schema/result.schema.json   what a batch session returns
  templates/prompt.md         the batch prompt
  templates/project.example.toml
skills/figma-transpose/scripts/
  figma-rest.mjs              the shared REST client: GET only, 429 backoff
  figma-nodes.mjs             tree, structural diff, verbatim copy, ready scan, fingerprints, link parsing
  figma-components.mjs        the component sets behind a frame: variants, states not on the page, interactions, elements with no component, the set cache
  figma-read.mjs              CLI over all three, for interactive sessions
tests/figpipe/                node --test tests/figpipe/*.test.mjs; fixtures are recorded Figma responses, renamed to a made-up site (Tern)
```

State, outside every repo:

```
~/.figpipe/
  state.db                    SQLite (below)
  projects/<slug>.toml        per-project config
  batches/<project>/<batch>/  batch.json, extract.json, prompt.md, session/ (rules the session cannot
                              change), broker/ (figpipe commands handed to the supervisor), install-<lane>.log,
                              batch.log (per attempt: the Claude login and usage meters the session ran under,
                              why it waits, lanes removed), transcript.jsonl, result.json, results/, captures/,
                              patches/, media/, report.html
  cache/npm/                  npm cache for sessions (writable inside the sandbox)
  hooks/<project>/<lane>/     pre-push and pass-through hooks for pipeline worktrees
  watch/<project>/<node>/<baseline id>/   a watched section's baseline: node JSON, copy.md, render/
  components/<file key>/<set id>/          a component set, read once per file version: meta.json, set.json, node.json,
                                           render@3x.png; and catalogue.json, the sets on the file's component pages
  index.html                  every batch, unreviewed first
  logs/                       figpipe.log, tick.log
  PAUSE                       present = no new batches
```

Extractions land in `<repo>/<extract_dir>/<lane>/pipeline/<batch>/` so interactive sessions see the same files. figpipe adds `/.figma/` to `.git/info/exclude` when it is missing.

## State tables

Schema 4 (columns added in place on first open): `batches.pid_started`, `figma_mcp`, `reviewed_by`, `review_note`, `wait_kind`, `wait_source`, `retry_after`, `wait_note`, `probed_at`, `account`; `project_state.blocked_until`, `warnings`; `files.last_watch_at`; `items.watch`, `figma_before`, `components`; `snapshots.renders`; the `watches` table with `moved_from`, `moved_at`, `page_name`.

`files` (live or stale, last edit, cursors), `nodes` (every devStatus seen, shallow fingerprint), `node_areas` (node id to the area it sits in), `comments`, `versions`, `events` (deduped signals: `ready`, `changed`, `comment`, `version`, `manual`, `identity`; role `trigger` or `context`), `batches`, `items` (one per node or per thread, plus report fields), `captures`, `notes` (decision, question, flag, not_done, check), `ledger` (what each batch did per node and thread), `snapshots` (node JSON and renders per build, or per watch baseline with batch id `baseline-<time>`, for structural and copy diffs and Figma before/after), `watches` (per watched section: last design fingerprint, status, baseline, last change seen), `budget` (per local day: batches, dollars, MCP calls, REST 429s), `project_state`, `follow_blocks` (follow mode: derived blocks, zone, work days, when derived and last attempted), `denials`.

## Scope and ownership

figpipe only builds what is yours (`lib/scope.mjs`). Each ready section is `mine`, `others` (with who) or `unknown`, from these signals, strongest first:

1. Answers: `figpipe own <name|figma-link> mine|others [--who "A, B"]`, stored in state.db, never asked twice.
2. Rules in `[scope]`: `exclude` (globs, case-insensitive, whole name, matched on the node and its ancestors) makes a section others'; `include` makes it yours; exclude wins.
3. Tracker mapping: `[scope.assign]` maps a section pattern to an implementer (`"Booking*" = "Galina"`); your own name means mine. `scope.tracker` is a note on where the mapping came from (a Notion or Linear URL); figpipe never fetches it, the setup skill reads it and writes the mapping.
4. The name: the same section under another language tag has that section's owner. "Location_GER" beside a "Location" you pre-built (a watched section) is yours; "Main_FR" takes the answer given for "Main_EN" (the latest one when answers differ). An answer for the exact name still wins.
5. Comments: the last 5 comments pinned to the section. Tagging you means mine. Tagging only people in `scope.others` means others (an "@Ada" counts for "Ada Brooks"; two or more tags is high confidence, one is medium).
6. Nothing: unknown.

Names are compared by their base (`lib/names.mjs`): a language tag at the end is set aside (`_EN`, `_GER`, `_DE`, `_FR`, `(it)`, `/ ES`, also ` EN` and `-EN` in upper case), and so are case, accents and separators. "Check it" and "Sign-in" keep their last word. Rules and the tracker mapping see a name with and without its tag, so `include = ["Contact"]` covers "Contact_EN". Language variants are separate items: each has its own node, lane and build.

```toml
[scope]
include = ["Homepage*", "Navigation*"]
exclude = ["*Funnel*", "*Checkout*"]
others  = ["Ada Brooks", "Arlo"]
unknown = "ask"                          # "ask" holds unknown sections; "mine" (default) builds them
tracker = ""
[scope.assign]
"Booking*" = "Galina"
```

What happens: others' events get status `out_of_scope` (reason in `note`) and are skipped, shown only as a count. Unknown events with `unknown = "ask"` get status `needs_owner` and are held. Both are never batched, and are re-judged on every check and every `figpipe status`, so a new answer or rule brings them back. With no `[scope]` rules at all and `unknown = "mine"`, everything counts as yours. Comment threads are judged apart: a thread whose last 3 comments tag only `others` is theirs; threads that tag you or that a past batch handled stay in; `exclude` and `include` do not apply to threads. `figpipe add` events are never judged.

Where it shows: `figpipe status` prints `N out of scope (latest: <name>, <reason>)` and one `Is this yours? <name>: <reason>. Answer: figpipe own "<name>" mine|others` line per held section; `index.html` shows the same lines; `tick --dry-run` lists each. `figpipe own --list [--json]` reads the watched pages (nothing kept) and prints every ready section with owner, confidence, reason and drift. `figpipe doctor` warns about drift (a section set to mine whose last comments tag only others, twice or more, or the reverse) and about sections waiting for an owner.

Not built: Figma dev resources as a signal.

## Watched sections

A section the designer is still working on (not marked ready) that you have already built from the in-progress design. figpipe keeps that build in step with the designer.

```toml
[[figma.files.watch]]
node = "7431:81099"                       # the section, read by id from any page
name = "Location"                         # lane "location", branch figma/location
branch = "feat/plans-r2"            # the local branch that holds the pre-built page
route = "/en-gb/preview/locations"        # preview for the lane and the captures
page = "Design In Progress"               # where to look if the id goes missing
built = true                              # false: nothing built yet; the first real design is a new page
lane = ""                                 # another section's lane, e.g. a variant frame of the same page
notes = ""                                # for the session
```

- Baseline: the first check after a watch is added records the current design (node JSON, copy, renders of the section and its breakpoint frames under `~/.figpipe/watch/`), a snapshot row and, for a built section, a ledger row. Nothing is raised, so the first real change is a diff, not a rebuild. `figpipe watch baseline <slug> [<name>]` records it again after you updated the build by hand, and settles the changes and ready marks that waited for the section. `figpipe watch baseline <slug> --all` does it for every watched section and every ready section that is yours. A dry run lists sections without a baseline instead.
- Sections that move: designers move a section from the in-progress page to the ready page, which gives it a new node id and often a new name ("Location" is "Location_EN" there). After the ready read of each check, a watched section whose node is gone, or that still sits on a page that is not watched, is matched against the ready sections on the watched pages that no watch points at:
  1. By name: the base names match and no other language is named ("Location" may be "Location_EN"; "Location_EN" is never "Location_GER"). Among several (an EN and a GER copy), the one closest to the baseline wins and the others are separate items, yours by their name. A candidate that names the language of another watch is left to that watch. A match on the layer's Figma name alone (a watch named "Stories regular section" on a layer called "Desktop") also needs a similarity of 0.5.
  2. By structure, only for a node that is gone and that no name matches: one ready section that appeared since the node was last seen, with a similarity of 0.8 or more and 0.1 ahead of the next. Weighed once, when the node vanishes or the candidate appears.
  Similarity is the share of visible layers (type and name) and texts two sections have in common. One full-depth read covers all candidates of a check.
- Following a move: the watch row, the baseline, the build history (snapshots and ledger rows are copied to the new id), the pending changes and comments, and a ready mark already seen on the new node all move to the new node; the ready mark is a pre-built handoff and yours. The `node` (and `page`) of that `[[figma.files.watch]]` entry are rewritten in the config file, with a comment line that says what moved; nothing else in the file changes, and the new text must parse before it replaces the file. When the file cannot be written nothing moves and the warning names the node to set. The watch keeps its `name`, lane, branch and route. The design is compared with ids set aside (node ids and references to them, ready marks, the section's own name, the position and render bounds are ignored): unchanged, nothing is raised and a ready item closes as already built; changed, a `changed` event waits and the batch diffs against the kept baseline. `figpipe status` and `figpipe watch` say `now "Location_EN" on "Development Ready (Latest)" (moved in Figma, followed <when>; the baseline is kept)`; the check logs it; a dry run prints what it would re-point and changes nothing.
- A built section that is not watched (a ready section a batch built, or one recorded with `watch baseline --all`) is followed the same way when it comes back under a new id with the same name, language included, under the same parents: the new node takes over the build history and an ownership answer, so it is diffed against the build, or closed as already built when nothing changed.
- The read: one full-depth `/nodes` call for every watched section of a file when `last_touched_at` moved, hourly, on `--backfill`, or while one has no baseline. It runs before the comment read, and maps every layer inside a section to it (`node_areas`).
- Triggers, all batched with the same quiet window, max wait and caps as ready items:
  1. Design changed: the section's fingerprint differs from the last read. It ignores where the section sits on the canvas and ready marks, so a move or a mark alone is not a change.
  2. A comment on the section or any layer inside it from anyone but you (replies included). The event carries `addressed_to`, the @names in it.
  3. A ready mark on the section or a frame inside it: a `ready` item marked pre-built. Removing the mark cancels it. A ready node on a watched page with the section's id or Figma name (the designer copied it to the ready page) is matched to the section too.
- Ownership: watched sections are yours. Their events skip `[scope]`, the thread rule and the unknown policy.
- The batch: items carry `watch` (node, name, lane, branch, route, built). Their lane is the watch's (`lane`, else the name as a slug) on `figma/<lane>`, started from the watch's `branch` (never stacked on another feature branch); a missing branch blocks the lane. The preview is the watch's `route`. Extraction diffs node JSON and copy against the snapshot the build was made from (the last build in the ledger, else the baseline) and passes that design's renders on. An item whose design equals it (a ready mark alone, or an edit undone) closes before any AI runs: already built, or FYI when nothing was built yet. The session updates the existing page, records comments meant for the designer as FYI, and captures the build before and after. A built item moves the baseline to its own snapshot. Nothing is pushed.
- The report: a "Design change in Figma" block with Figma before (dated) and now per breakpoint frame and how many copy and layout lines changed, then "Build before and after" per width, copy changes included.
- Where it shows: `figpipe status` and `figpipe watch` list each section with its route, base branch, state (moved, marked ready, not built yet, gone) and the last change seen (design changed, comment from someone, marked ready, moved) with what waits and which batch has it. A section whose id vanished and that nothing matches is a warning naming where a layer with its name sits, if any; `figpipe doctor` checks the sections exist, have a baseline, and that their branches are local branches.

## Component sets

A page frame shows each control in one state. Extraction reads the rest (`skills/figma-transpose/scripts/figma-components.mjs`, the same code `figma-read.mjs components` runs), for every node item, before any AI:

1. Walks the node's instances and resolves each to its main component and its component set, from the `components` and `componentSets` the `/nodes` response carries. Hidden instances are kept apart; a set that only sits in hidden layers is named and not read.
2. Reads each distinct set at full depth (ids batched, 8 per request) and renders it at 3x (6 per request). A set in a library file is found through its key (`/v1/component_sets/<key>`) and read from that file.
3. Finds interactive elements that are not instances of a set: plain layers named like a control (button, input, checkbox, toggle, tab, dropdown and the like, and small enough to be one), a part of an instance switched on by a property, a component without variants, and text with a hyperlink, an underline or a link style. These are "no component: states not designed". A detached copy of a component is a plain layer to Figma's API, so it is seen only while its name still says what it is.
4. For those, lists the sets on the file's component pages (pages named like Components, Library or Design system, or `component_pages` on the file) that are named like the element, and reads the first four: a set the frame does not instance can still be that element's design. Sets with states that only show inside variants still to build (a dropdown's list items) are read too, one step deep.
5. Reads the prototype interactions of every variant (`interactions`, else the legacy `transitionNodeID`, `transitionDuration` and `transitionEasing`): the trigger (hover, click, press, mouse enter or leave with its delay, after a delay), each action's navigation and destination, named as a variant of the set or marked `outside_set`, the transition, its duration in ms and its easing, with the bezier or spring values when they are custom. Interactions placed on the frame's instances are kept where they differ from their variant's. For a set that cannot be read, its instances' interactions are all that is known, so all of them are kept.

Written under the item's extraction folder:

```
components/
  components.md               the table: set, variant axes, variants on the page, variants not on the page; then the interactions,
                              one line each ("Default -> Hovered on hover, smart animate 200 ms ease-out"); then the elements with no component
  index.json                  the same, as data
  <set name>/set.json         axes, properties, every variant: its lines, what it changes against the resting variant, where it sits in the render,
                              its interactions; on_the_page, not_on_the_page, to_build (the states at the sizes and colours the page uses),
                              states_not_designed, interaction_lines, instance_interactions (the frame's own, where they differ)
  <set name>/node.json        the set's /nodes entry, verbatim
  <set name>/render@3x.png    the whole set
```

The manifest carries it as `items[].extraction.components`: `table`, `index`, `render_scale`, `sets[]` (name, role `used`, `candidate` or `nested`, axes, `on_the_page`, `not_on_the_page`, `to_build`, `states_not_designed`, paths, or `unreadable` with the reason; `interactions`, one line each, when the set or the frame's instances have any) and `no_component[]` (element, where, why, how many, the distinct looks on the frame, `sets_named_like_it`).

An axis is a state axis when its name or a value is a state word (State, Checked, Filled, Hovered, Open); size, colour and breakpoint axes are other designs, not states to build. `states_not_designed` is by name only (hover, focus, pressed, disabled, checked, filled, error, open, selected, per kind of control), so the session decides whether another variant covers it.

Nothing here can fail a batch. A node with no instances costs no calls and gets an empty table. A set Figma cannot return, a library the token cannot read and a set past `max_component_sets` (sets with states are read first) are rows that say so, with the variants the page shows. Only a Figma rate limit stops the extraction, as it does for every other read.

Cache: `~/.figpipe/components/<file key>/<set id>/`, keyed by the file version the `/nodes` response reports and the shape of `set.json`. The same version reads nothing. A new version reads the sets again in one batched request and keeps each render whose set did not change. Within a batch every set is read once however many items use it. The list of a file's sets is kept for a day. Library sets, whose file version is not known up front, are kept for a day.

```toml
[extract]
component_sets = true            # false: skip all of this
component_render_scale = 3
max_component_sets = 30          # per node

[[figma.files]]
component_pages = []             # page names or ids; empty: pages named like Components, Library, Design system
```

The session builds every designed state and interaction as designed, without asking. For an interactive element with a state that has no design it proposes the states the element should have, from the same element elsewhere in the file, then the project's existing component or tokens, then on a project with nothing to follow the platform's usual states for that kind of element. Nobody can answer during a batch, so it builds the proposal and records the source per element in the result's `components`; `figpipe record` turns each proposed row into a question that says what was used. See `skills/figma-batch/SKILL.md`.

## When checks run

`[schedule]` sets when a project is checked, in the designers' time zone:

```toml
[schedule]
timezone = "Europe/Berlin"                 # IANA name; default: this Mac's zone
days = ["mon", "tue", "wed", "thu", "fri"] # default: every day
times = ["06:00", "14:00", "22:00"]        # fixed checks, or
windows = [{ start = "08:00", end = "19:00", every = 60 }]   # a check every N minutes from start to end, inclusive
```

`mode` names the shape (`"follow"`, `"times"` or `"windows"`); empty infers it from `times` and `windows`. `times` and `windows` are exclusive; several windows are allowed and overlapping checks run once; a window cannot cross midnight (split it in two; `start = end` is a single check). Without times or windows a project is checked every `batching.poll_minutes` all day (with `days`, only on those days).

How it runs: the background job wakes `figpipe tick` every 15 minutes, and `tick` decides per project whether a check is due. A check is due when the latest scheduled moment that has already passed is later than the project's last check (`project_state.last_tick_at`), or when the last check failed and 15 minutes have passed, or when there has never been a check (the first check records a baseline).

Why the decision lives in `tick` and not in launchd calendar entries:

- Daylight saving. A schedule is wall-clock time in the project's zone. Computing it at tick time with the zone database gives the right instants on both sides of a clock change, in either zone, with nothing to regenerate. Calendar entries are fixed to the Mac's local clock; converting "06:00 Los Angeles" to Berlin time is wrong for the weeks when only one of the two zones has changed its clock, and nobody reinstalls the job on those days.
- Several projects. Each project has its own zone, days and times. One job that wakes often and asks each project is a union of any number of schedules without computing or merging calendar entries.
- A Mac that travels or changes zone needs nothing: the project's zone, not the Mac's, defines the schedule.
- Sleep. Nothing is replayed. After sleep the next wake finds the latest passed moment later than the last check and runs one check, however many were missed, and logs one line saying it is a catch-up. This holds for every schedule shape and needs no launchd feature.
- Cost. A wake that finds nothing due reads the config and one row of state.db and prints nothing. It never calls Figma.

Resolution: a scheduled check runs at the first wake at or after its time, so up to 15 minutes late (or up to the wake interval, after waking from sleep). A wall-clock time that does not exist (02:30 on the day clocks jump from 02:00 to 03:00) happens at the instant 03:30 would; a time that happens twice (02:30 when clocks fall back from 03:00 to 02:00) happens at the first of the two.

The quiet window (`batching.quiet_minutes`) and `max_wait_minutes` are evaluated at a check. With three checks a day a batch starts at the first check at which the designer has been quiet for `quiet_minutes`, or at which the oldest item has waited `max_wait_minutes`; a batch already `ready` starts at the next wake after the previous batch finishes, not at the next check.

`figpipe status` prints `schedule:` and `next check:` per project, the latter in this Mac's zone and the project's zone. `figpipe doctor` compares the schedule with the last 14 days of edits and comments and warns when 40% or more waited over 4 hours for the next check, naming the hours designers work in both zones. Instant pickup (a webhook receiver) is not built.

### Follow mode

```toml
[schedule]
mode = "follow"
every = 60                       # minutes between checks inside the designers' working blocks
my_day_starts = "08:00"          # your day; one check lands 60-90 minutes before it
my_timezone = "America/Los_Angeles"   # default: this Mac's zone
refresh_days = 7                 # re-derive the blocks this often
# timezone = "Europe/Berlin"     # optional: pin the designers' zone instead of guessing it
# days = [...]                   # optional: narrows the days the designers work
```

figpipe derives the working blocks from what the designers of the watched files (stale copies included) did in the last 30 days: saved versions, comments and ready-for-dev changes, your own left out. The blocks are runs of hours with activity on at least 35% of the busiest hour's days, joined across a one-hour dip; the work days are the weekdays with at least half the busiest weekday's activity; the zone is guessed from their hours unless `timezone` pins it. The result is cached in `follow_blocks` and used until `refresh_days` have passed.

- Checks run every `every` minutes from the start to the end of each block, on the work days, in the designers' zone.
- One more check lands before your day starts: `PRE_DAY_LEAD` (75) minutes before `my_day_starts` in `my_timezone`, so a build can finish. A block check 60 to 90 minutes before your day already counts and nothing is added. The check is placed per date in your zone, so a clock change in either zone moves nothing by hand.
- Derivation happens at a check, from the version and comment lists only (two Tier 2 reads per watched file, plus paging). At most one derivation a day. A failed read is retried after an hour and the last blocks stay in use. While the activity is too thin (fewer than 8 events or fewer than 5 active days) the blocks are every `every` minutes from 08:00 to 20:00 in the guessed designer zone (yours when there is nothing to guess from), re-tried daily; `status` says it is a fallback and why. Pinning another `timezone` re-derives.
- `figpipe status` shows the blocks in the designers' time and yours, when they were derived, and the next check. `figpipe activity` quotes what follow would do before it is chosen.
- `figpipe doctor` shows the blocks. When the log has three or more catch-up lines in 14 days (the Mac was asleep at check times) it advises keeping the Mac awake with an app such as Amphetamine, and gives `sudo pmset repeat wakeorpoweron <days> <time>` as the alternative: one minute after the check before your day starts, in this Mac's zone. It needs a password and works best on power. figpipe never runs it, and doctor says nothing about sleep when no catch-ups are logged.
- The background job is unchanged: it wakes `tick` every 15 minutes (or `every` when shorter), and `tick` decides.

## How a tick decides

1. Per watched file: `/meta` always. Watched sections at full depth when the file moved, hourly or before a baseline (one call). `/comments` always. Page names are resolved to page ids on the first check and again hourly (`/files?depth=1`), so a page renamed to "(Old)" with a new "(Latest)" moves the watch to the new page, with a warning. The page read (`/nodes?ids=<pages>&depth=<ready_depth>`) only when `last_touched_at` moved, on the first run, or hourly. Built nodes still marked ready get a full-depth re-read at most every `deep_check_minutes`. `/versions` always. `/meta` on each stale copy.
2. Triggers: a node newly marked ready; a built node that changed while still marked; a comment that mentions you (`@handle` or `@name`); a reply in a thread you started, were mentioned in, replied to, or a batch handled; for watched sections, a design change, a comment from anyone else, or a ready mark (see Watched sections). Context: other comments on ready nodes, named versions, a stale copy edited after the live file.
3. Cancels: un-marked nodes, resolved threads, deleted comments. Events already in a running batch get a note the report shows. A page that did not come back (or came back empty) cancels nothing: its marks keep their state until a read that does. An edited comment updates its stored text and the waiting event, or adds a note when it is already in a batch.
4. A batch starts when the designer has been quiet for `quiet_minutes` (no new events, no edits), or a named version was saved, or the oldest item waited `max_wait_minutes`; and no batch for the project is active or waiting for review (`max_unreviewed_batches`), the daily cap is not hit, no PAUSE, inside `active_hours`, and the usage meter is not ahead of pace (except at max wait). Today's spend below `limits.usd_per_day` and no Figma rate-limit wait are hard stops too. A batch that waits for Claude (see When Claude cannot run a session) holds the project's next batch back and lets other projects' batches start.
6. A finished batch with nothing built, failed, pending or needing your decision is marked reviewed by figpipe (`reviewed_by = 'auto'`), so it does not hold up new work. It stays listed in status and at the top of the index while it holds questions or news.
7. A 429 whose `Retry-After` is longer than `figma.backoff.max_s` is not retried: figpipe saves `blocked_until` and skips that project's checks and extractions until then.
5. Fingerprints ignore where a node sits on the canvas, so moving a section is not a change. An item whose full-depth fingerprint matches the last build is closed as already built before any AI runs.

## When Claude cannot run a session

A session that meets a usage limit, a signed-out login or an empty credit balance ends at once with an error result and no work. figpipe reads that from the transcript: the result line (`is_error` with `api_error_status` 429, 401, 403 or 402, or `terminal_reason: api_error`), the API's message, and the `rate_limit_event` that carries the reset time (`resetsAt`; else the time in the message, "resets Oct 13 at 9am (America/Los_Angeles)", read in the zone it names).

- The batch waits. It stays `ready` with its items and events, with `wait_kind` (`usage`, `auth`, `credit`), `retry_after` and what Claude said (`wait_note`). The attempt is not counted, nothing is added to the spend, and a refusal that cost nothing comes off today's batch count. A batch never becomes stuck this way.
- Where it shows: `figpipe status` (`<batch> · waiting · Claude usage limit hit; retries after Tue 13 Oct 09:00 PDT`), the index (the same line on top), the report (the status "Waiting for Claude usage", the line, what Claude said, and `figpipe run --batch <id>` to start it by hand), `figpipe doctor`, one notification, and the reason new items wait.
- The free check. Before any worktree, install or session, figpipe asks the CLI whether a session can run, with the session's own environment and no model call: `claude auth status` (signed in, and as whom) and `claude -p /usage` (the meters). A signed-out login, or a full meter the session draws on (its 5-hour window, the weekly all-models meter, the meter of its own model), holds the batch right there with the meter's reset time. Meters that cannot be read (an API key login has none) hold nothing.
- Retry. The tick starts a waiting batch at the first wake after `retry_after`. Before that it looks again at most once an hour, and only when the free check is what saw the limit: room on the meters ends the wait early. When a session was refused although the meters had room, they cannot tell, so the batch waits for the reset time and no lanes are prepared in between. A usage limit without a reset time is tried after an hour; a signed-out login is checked hourly; a refused key or missing credit is tried every 6 hours. `figpipe run --batch <id>` tries at any time.
- After the wait. A batch that waited while the file was edited is extracted again before its session, unless a session already recorded work on it, so it builds from the design as it is.
- Lanes. The worktrees and `figma/` branches of a batch that hold nothing are removed when it starts to wait, becomes stuck, is acked or rejected, or is marked reviewed by figpipe: the branch has no commit that is not on the branch it started from, and the worktree has no uncommitted edits. A lane with work in it is kept. The next attempt makes them again.
- The login. Each attempt writes to `<batch>/batch.log` which Claude login the background session runs under (email, plan, organisation, sign-in method, settings folder, from `claude auth status`) and the usage meters, then the Claude Code version, model and API key source the session reported. The login is kept on the batch (`account`), shown in the report's Session block, and `figpipe doctor` warns when it differs from the login of the terminal doctor runs in: the background job has its own environment.

## The session contract

`batch.json` holds: `mode`, `lanes` (lane, branch, base, worktree, port, dev command, preview URL, item ids, or `blocked` with the reason), `items` (kind, title, node, thread, Figma link, extraction paths: node JSON, copy, tree, sdiff, renders, component sets, breakpoint frames, hidden children, threads, motion hints, history from the ledger), `mcp` (used and left today, motion reserve), `stack`, `review`, `models`, `context` (named versions, stale-copy warnings, changes after pickup), `result_schema`.

The session records each item as soon as it is settled (`figpipe record <batch> <part.json> --partial`), then returns `figpipe result <batch>` as its final answer, which matches `schema/result.schema.json`. A session that stops after recording every item still ends `done`; one that stops earlier keeps what it recorded, and the retry only runs the items still pending. Inside a session `figpipe` is a messenger: it writes the command to `<batch>/broker/`, and the supervisor runs it outside the sandbox (where state.db and the screenshot browser are) as a session command of that batch: only `budget`, `record --partial` (files from the batch folder), `result`, `capture`, `report` and `status`. The session itself cannot open state.db.

The result holds, per item, an outcome, `change_kind` (`copy` gets a text diff in the report; `redesign` and `new_page` get before/after captures per width), a one-line verdict, branch and commits, preview links, captures, text diff, decisions with the default applied, questions ready to paste, flags, where each interactive element's states came from (`components`: element, source `figma_component`, `figma_elsewhere`, `project` or `platform_default`, the states covered and what was used; every row with another source than `figma_component` is stored as a question too), and a reply draft for comment items.

## Rails

- REST client has no write methods. Image downloads never carry the token.
- Session: `--permission-mode dontAsk` with an allowlist, `--disallowedTools`, `--strict-mcp-config` (Figma only), `--settings` with the guard hook and the sandbox, `--setting-sources project` (the user's own settings, allow rules and hooks never widen a session; the three skills are linked in as project skills), `--max-budget-usd` with what the batch has left, a new `--session-id` per attempt, a wall-clock kill of the process group, never `--bare`.
- OS sandbox (Claude Code's, Seatbelt on macOS) on every Bash command and its children, `node -e` included: `failIfUnavailable`, no unsandboxed retries, the allowlist still applies. Writes: the batch folder, the extract folder, the lane worktrees, the repo's git store and `~/.figpipe/cache`; never the repo's `config`, `hooks`, `info`, Tony's `index` and `HEAD`, other worktrees' git folders, a lane's `config.worktree`, or the batch's `session/` and `.claude/`. Network: `api.figma.com`, localhost, the CMS's read API (`stack.cms.kind`) and `stack.allowed_domains`, with `strictAllowlist`. Node's fetch uses the sandbox proxy (`NODE_USE_ENV_PROXY=1`). What it leaves open: reads, and a deliberate script moving a branch ref in the shared git store (the guard refuses the git commands that do it; the reflog keeps the old position).
- Dependencies: figpipe installs a lane worktree's dependencies before the session, outside the sandbox, only when the package files match the lane's base branch, with install scripts off (`stack.install` overrides the command). After the session it stops anything still listening on a lane port from inside a lane worktree.
- Guard hook (fails closed: an error is a deny): denies `git push`/`send-email`/remote and push-config changes in any position (pipes, `$( )`, `sh -c`, wrappers), git commands that change things outside the lane worktrees (`cd` and `-C` followed), `git stash`, deleting, renaming or resetting branches outside `figma/`, deploy and CMS tools however launched (`npx`, `npm exec`, `pnpm dlx`, `yarn dlx`, `bunx`), `figpipe` commands outside the session set and any change to `FIGPIPE_*`, edits to the batch's `session/` and `.claude/`, `gh`, `open`, `osascript`, remote shells, deploys, CMS CLIs, any `figma.com` URL, network other than localhost and GET `api.figma.com`, edits outside the lane worktrees, batch folder and extract folder, Figma MCP write tools, and MCP reads past the day's share (the last `reserve_for_motion` calls are kept for `get_motion_context` and `export_video`). Unreadable input is denied.
- Environment: PATH shims for `git` (no push), `gh`, `open`, `osascript`; `GIT_CONFIG_*` rewrites every push URL to `figpipe-blocked://`; GitHub, Slack, npm, Cloudflare, Vercel, Netlify, Storyblok tokens removed.
- Worktree files: `git.worktree_files` (ignored files such as `.env`) are copied from the repo into a new lane worktree; dotenv keys matching `git.worktree_env_omit` (secrets, access tokens) are left out.
- Refusals: calls the session's allowlist refused are read from the transcript and listed in the report with the guard's denials. A session whose Figma MCP is not signed in gets a not-done line saying motion and video were not read.
- Previews: `stack.preview_pages` maps a lane to its page when they differ (a node added by hand is its own lane, named after the node).
- Session skills: `figma-batch`, `figma-transpose` and `figma-review-page` are linked into `<batch>/.claude/skills/` unless the user has them installed, so a session finds them without a global install.
- Worktrees: `extensions.worktreeConfig` on the repo, then per worktree `core.hooksPath` (pre-push refuses, other hooks run the repo's own), `url.figpipe-blocked://.pushInsteadOf ""` and `remote.<name>.pushurl` set to nowhere, so `git push --no-verify` fails too. Tony's own checkout keeps its config. A worktree with uncommitted edits blocks its lane and is left alone, except on a retry of the batch whose attempt left them (and no other batch ran there since): the lane is marked `carried` and the session continues from them.
- Batches: claimed with one conditional update (`status = 'ready'` and nothing else extracting or running), so a tick and a manual run never start the same batch twice. A saved pid counts as alive only while its process start time matches.
- Money: a retry spends what the batch has left of `limits.usd_per_batch`, not a fresh limit; a run stopped at `limits.max_minutes` counts as everything it had left; no batch starts once today's spend reaches `limits.usd_per_day`. A session Claude refused (usage limit, sign-in, credit) is no attempt and no spend.
- Before a session: the free check that Claude can run comes before any worktree or install (see When Claude cannot run a session).

## Install the background check

```
node figpipe/figpipe.mjs launchd install     # writes the plist under ~/.figpipe/launchd and prints:
launchctl bootout gui/$(id -u)/com.<user>.figpipe 2>/dev/null   # only when an older copy is loaded
cp ~/.figpipe/launchd/com.<user>.figpipe.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.<user>.figpipe.plist
```

Remove it with `figpipe launchd uninstall`, which prints the `launchctl bootout` and `rm` commands.

## Skills

- `skills/figma-batch/SKILL.md`: what the session does with `batch.json`: triage, motion, before captures, build lanes, states from component sets, verify at every width and in every state, review lenses, revert-to-patch, recording, notes mode.
- `skills/figma-setup/SKILL.md`: onboarding from `figpipe probe` and the Figma MCP `whoami`, the questions it may ask (including when to check, proposed from `figpipe activity`), config and notes, validation with `config check`, `doctor` and `tick --dry-run`; doctor mode.

## The report

One page per batch at `batches/<project>/<batch>/report.html`, plus `index.html`. The same order every time: project, time and status; the one-line summary; counts; items (needs you, questions, failed, built, already built, FYI), each with its verdict, the comment thread or ready frame with its Figma render, Figma/before/after per width for redesigns and new pages, a text diff for copy changes, the preview link and the command that starts it, decisions with the default applied, questions with copy buttons (each state the build proposed is one: "Phone list has no open state in Figma; the build uses the site's existing dropdown. Should it have one?"), the Components line ("Checkbox: states from Figma component; Phone list open state: not designed, used the site's existing dropdown", written from the result's `components`; without them, what the extraction found in Figma), looks-unconsidered flags and the reply draft; then what changed in the file, not done (including blocked commands), checks, and cost with the resume and ack commands. Empty sections are left out. Screenshots are shown, never scored. Questions count in the totals and colour their item amber whatever its outcome (the notification says "3 questions" for a batch where nothing was built). A redesign, new page or fix without screenshots says why in one line. Motion hints show whenever the batch had no Figma MCP or the item has no screenshots. The footer says new Figma work waits until the batch is reviewed. A batch that waits for Claude shows what it waits for and the command that starts it by hand in place of the review action; a note given with `ack --note` shows under the summary and on the index. The title is `project.name`, else the slug in words. The index lists the last check's warnings on top. Light and dark, offline, no external assets; images are copied into the batch folder.

## Not in figpipe

The webhook receiver is not built; `receiver.enabled = true` is refused.
