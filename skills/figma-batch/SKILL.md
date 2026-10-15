---
name: figma-batch
description: Turn one figpipe batch of Figma handoffs (ready-for-dev frames, comments, links added by hand) into local, reviewed commits and a proof-packet report. Loaded by the batch prompt in a headless `claude -p` session that figpipe starts; also use interactively when the user says "check Figma", "build what's ready", "pick up this Figma link", or asks why a batch did what it did.
---

# Figma batch

One session, one batch. figpipe has already watched Figma, grouped the work, extracted every design over REST and prepared one git worktree per page area. This skill does the judgment part: decide what each item needs, build it, prove it at three widths, review it, commit locally, and record every result as rows in figpipe's database. figpipe renders the report from those rows. Nothing is pushed, posted or sent.

The build method is not repeated here. Build under `figma-transpose` (copy, icons, image slots, the traps the export hides, verification gates). Capture mechanics come from `figma-review-page`. Motion follows `figma-implement-motion` when it is installed. Regression baselines follow `design-parity`, except its token snapping: here the design value wins and every deviation is written down. Every lane brief embeds the `ownership` doctrine.

## Interactive use

Outside a batch session, do not build by hand around the rails. Use figpipe:

- "What's waiting?" → `figpipe status`.
- "Pick up this link" → `figpipe add <figma link> [--note "..."]`, then `figpipe run <project> --now`. It starts the guarded session in the background and prints where the report will be.
- "Why did it do that?" → read `~/.figpipe/batches/<project>/<batch>/` (`batch.json`, `result.json`, `transcript.jsonl`, `report.html`), or `claude --resume <session id>` from the report footer.
- No project config yet → offer the `figma-setup` skill.

The rest of this file is for the batch session.

## Rules (hooks enforce them; a denied call shows up in the report)

- Read Figma only through the REST read tools (`manifest.read_tools`, `node figma-read.mjs ...`) and the Figma MCP read tools. Never open figma.com, the Figma app or any browser on Figma.
- No `mcp__figma__*` tools in this session means the Figma MCP is not signed in: treat it as no MCP budget (figpipe notes it in the report).
- Before every Figma MCP call except `whoami`, run `figpipe budget mcp --batch <batch>`. On `no`, stop calling MCP and list what waited under not done. The last `mcp.reserve_for_motion` calls only go to `get_motion_context` and `export_video`.
- Never push, open a pull request, message anyone, or write to Figma or a CMS. CMS changes are prepared as local content files and listed for Tony.
- Edit only inside the lane worktrees, the batch folder and the extract folder. Tony's own checkout is read-only.
- Localhost only. Captures and dev servers run on the lane's port.
- No `git stash`: the stash list is shared with Tony's checkout and other sessions. Commit, or leave the edits in place.
- Every Bash command runs in an OS sandbox. Writes land only in the folders above; the network reaches Figma's API, localhost and the CMS's read API, nothing else. `figpipe` commands are handed to the batch supervisor, which runs them outside the sandbox for this batch only.

## Inputs

`batch.json` in the session's working folder (the batch folder) is the whole contract:

| Field | What it holds |
| --- | --- |
| `mode` | `build` or `notes` (`notify` never starts a session) |
| `lanes[]` | one per page area: `lane`, `branch`, `base`, `worktree`, `port`, `dev` (start command, port filled in), `preview` URL, `items`, `watch` (the pre-built sections the lane updates, with their routes), or `blocked` with the reason. `carried: true` means the worktree holds uncommitted edits from this batch's previous attempt: read `git status` and continue from them |
| `items[]` | `id`, `kind` (`ready`, `changed`, `comment`, `manual`), `title`, `lane`, `area`, `figma_link`, `events` (the ready description or Tony's note), `watch` (set when the item is on a section Tony pre-built, see below), `extraction`, `history` (what earlier batches did to this node or thread) |
| `items[].extraction` | `node.json` (full-depth REST), `copy.md` and `copy.json` (verbatim), `tree-*.txt`, `sdiff` (structural diff against the design the last build was made from, when one exists), `copy_diff` (the same for copy, one line per text), `baseline` (that design: snapshot, date, node JSON, renders), `renders[]` (2x PNGs of the node and its child frames, with widths), `components` (the component sets behind the node: every variant, the states the node does not show, their prototype interactions, 3x renders, and the interactive elements that have no component; see step 4), `breakpoint_frames`, `hidden_children`, `threads[]` (whole comment threads), `motion[]` (nodes a still cannot explain), `already_done` |
| `models` | `coordinator`, `build`, `build_hard`, `review`, as `model:effort` |
| `stack`, `review` | dev command, gates (checks to run), preview route, CMS, widths, extra widths, regression routes, shared paths, lenses, fix rounds |
| `files[]` | live key, breakpoints, `canonical_copy`, `stale_copies` |
| `context` | named versions, same-name copies edited after the live file, items un-marked or changed after pickup |
| `notes_file` | the project's prose rules; read it first and follow it |

Items whose `outcome` is not `pending` were settled before any AI ran (already built with this exact design, or gone from Figma). Leave them alone.

## Steps

### 1. Read and triage (coordinator)

Read the project notes, then every item. Decide one outcome and one change kind per item before building anything.

| Outcome | When |
| --- | --- |
| `applied` | the change is made and committed |
| `already_done` | the build already matches; say where (file and line, or a capture) |
| `question` | needs the designer; the question and a reply are drafted, never posted |
| `needs_you` | a decision outside design: scope, content source, engineering, CMS; apply the default when one exists |
| `fyi` | nothing to do (and, in notes mode, a planned change) |
| `failed` | still fails checks after the fix round; reverted and saved as a patch |
| `skipped` | out of scope for this project, with the reason |

| Change kind | Report shows |
| --- | --- |
| `copy` | a text diff, no screenshots. Minor copy, label and link changes |
| `redesign` | Figma, before and after at every width. An existing section or page changes layout or visuals |
| `new_page` | Figma and after at every width, no before |
| `fix` | before and after, when a small visual fix is worth seeing; otherwise none |
| `motion` | the motion data and what changed; screenshots only when the still frame changed too |
| `none` | nothing visual |

Comments:

- Read the whole thread. The latest message wins: "this animation broke ... ok fixed" means read the motion data again, not fix the old report.
- Check `history` first. A thread a previous batch answered is never re-asked; a "done" reply about earlier work is matched to that work.
- Copy and asset requests ("change this to ...", "color code for the badges") are applied directly. Anything ambiguous is a question, never a guess.
- A comment pinned to a whole section usually means the section; the thread text decides.

Ready and changed frames:

- `changed` items: build the delta in `sdiff`, not the whole section again.
- Copy differs across breakpoint frames: use the `canonical_copy` breakpoint's text everywhere, record a decision with that default, and ask the designer.
- Copy differs between a page frame and a section's own spec frame (or two generations of one frame): use the spec frame, else the later one by version history, and record a decision with that default.
- `hidden_children` and placeholder text in the design are questions, not content.
- Identity warnings in `context` (a same-name copy edited after the live file) become a flag on every affected item and one question: which file is current.

Watched sections (`item.watch` set): Tony pre-built this section from the designer's in-progress work, on `watch.branch` at `watch.route`. The lane starts from that branch, so the page already exists in the worktree. Keep it in step; never rebuild it.

- `changed`: the design moved on since the build. Build only what `extraction.copy_diff` and `extraction.sdiff` show against `extraction.baseline` (the design the build was made from); copy verbatim from `copy.json`. Change kind `copy` or `redesign`.
- `watch.built` is false: the section was empty or unbuilt. A first real design is a `new_page` at `watch.route`; read `watch.notes` and any spec under the repo's extract folder for the section first.
- `ready` on a watched section: it is now a normal handoff. The build exists; verify it against the design at every width, fix what differs, and say in the verdict that it was pre-built.
- `comment` on a watched section: comments there are often a reviewer's feedback to the designer. A comment addressed to the designer (`events[].payload.addressed_to` names them, or it asks for a design change) that needs no change in code is `fyi`, verdict "For the designer: <what>", no reply, no question. Build only what the comment asks of the page as it stands (copy, a link, an asset); a design change it asks for arrives later as a `changed` item.
- Before and after captures at the lane preview for every watched item that changes code, copy included: the report shows Figma before and after for the design and the build before and after.
- Never push, never open a pull request: the lane branch stays local, like every lane.

### 2. Motion (only where it moves)

Stills can mislead. For items with `motion` hints or a comment about animation: check the budget, call `get_motion_context` on the moving node (recursive), and `export_video` when a preview helps the review. Save the replies in the item's extraction folder. Build timing, easing and keyframes from that data, with a reduced-motion version. No MCP left today: build the static state, outcome `question` or `needs_you`, and list the motion under not done.

### 3. Before captures (build mode)

For each lane with `redesign` or `fix` items, or with watched items (`lane.watch`), before any edit:

1. figpipe installs dependencies before the session (the sandbox has no registry access). If `node_modules` is still missing, the install failed and not done says why: skip that lane's captures and checks, and record its visual items as not done.
2. Start `lane.dev` in the background from the worktree. Wait until `lane.preview` answers.
3. `figpipe capture <batch> --item <id> --phase before --url <page url> [--selector <css for the section>]`. It saves `captures/<item>/before-<width>.png` at every review width and prints the paths.
4. When `review.shared_paths` is set, capture each `review.regression_routes` page as the regression baseline: `figpipe capture <batch> --lane <lane> --as regression-<route name> --phase before --url <route url>` (full page, no selector).

Prefer a section selector over a full page: the report shows what changed, not the whole site. New pages have no before.

### 4. Build (lanes)

One Agent per lane, in parallel, with the model from `models.build` (or `models.build_hard` for motion, sticky or scroll behaviour, and shared components). The coordinator makes copy-only and asset-only changes itself. Each brief carries only its own lane:

```
Lane <lane>. Worktree <path> on <branch> (from <base>). Dev server: <dev> on <port>.
Items: <id, title, outcome planned, change kind> with their extraction paths.
Build under the figma-transpose rules and the project notes at <notes_file>.
Copy verbatim from copy.json. Artwork is exported (REST render or MCP asset) or left as a
labelled placeholder slot, never redrawn in code. Design values beat tokens; list every
deviation. Breakpoints: <widths>. Ask, don't guess: return questions instead of choices.
States: build every interactive element state by state from its component set
(<components table path>, each set.json), with each interaction as designed: trigger,
target state, transition, duration, easing. For a state with no design, propose one from
the same element elsewhere in the file, then the project's own component, then the
platform's usual states; build the proposal and return it with its source.
Own the outcome: verify your own work at every width before you report back.
Commit one commit per item: figma(<batch>): <what> (<node name>). Never push.
Return per item: files touched, commits, decisions with the default applied, questions,
where each element's states came from, anything that looks unconsidered in the design.
```

Lanes touch only their own files. A shared component change is the coordinator's call and triggers the regression pass in step 5.

#### States come from component sets

A page frame shows each control in one state, usually at rest. The other states live in the component sets, which can sit on another page or in a library. `extraction.components` holds them: read `table` (components.md) first.

- Build every interactive element from its set's full variant list, state by state: each name in `to_build`, with values read from the set's `json`. There, `variants[].lines` is what a state looks like, `changes` is what it changes against the variant named in `from`, and `node_json` holds the exact values. The frame alone is one state. What a hover or a checked box usually looks like is not a source.
- A set with role `candidate` is not on the frame. It is named like an element that has no component there (`no_component[].sets_named_like_it`). When it is that element's design, build from it and say so in a decision.
- A state the set names differently is still that variant ("Active" on a field is its focus). Say which name you took in a decision.
- Interactions are part of the design. Each set's `interactions` (and the Interactions list in the table) names the trigger, the state it changes to, the transition, its duration and easing: "Default -> Hovered on hover, smart animate 200 ms ease-out". Build each one as designed, with the designed duration and easing, and a reduced-motion version that changes state without animating. A hover that only grows a photo inside its clip is still a hover. An instance's own interaction (`On this frame: ...`) wins for that instance.
- Designed states and interactions are built without asking.
- A state has no design when the element is listed under `no_component`, the state is in the set's `states_not_designed` and no variant covers it under another name, the set is `unreadable`, or the node has no sets at all. Propose the states the element should have, from the first source that has them:
  1. The same element in that state elsewhere in the file: another look on the frame (`no_component[].looks` are node ids), a sibling frame or another page. `node figma-read.mjs find <nodes.json> <name>` searches a pull already on disk.
  2. The project's existing component or tokens for that element.
  3. On a project with nothing to follow, the platform's usual states for that kind of element (the browser's focus ring, the native select list).
- Nobody can answer during a batch, so build the proposal and record where each element's states came from in the item's `components` (step 8). figpipe turns every row with a source other than `figma_component` into a question for the user that says what was used, so the report asks whether those states are wanted.

None of this stops a build. Files with no component sets, sets with half their states, detached copies and libraries the token cannot read are ordinary; the manifest says which case each element is.

### 5. Verify

1. Run every `stack.gates` command in each worktree.
2. `figpipe capture ... --phase after` for every redesign, fix and new page, with the same selector as before.
3. For the Figma column, use the render whose width matches each review width (`breakpoint_frames` and `renders[].width`); leave a width without one empty.
4. When a shared path changed, capture the regression routes again and compare with the baseline. Record one check per route.
5. States: for each component set the item builds from, put the built element into every state and compare it with the set's `render`. In set.json each variant's `box` says where it sits in that render, in design pixels (multiply by `components.render_scale`). Check each designed interaction too: its trigger reaches the state it names, the transition runs with the designed duration and easing (read the computed `transition` on the element), and with reduced motion on the state still changes without the animation.

   ```
   figpipe capture <batch> --item <id> --state <set>-<state> --url <page url> --selector <css>
       [--click <css>] [--fill <css> --text "..."] [--focus <css>] [--hover <css>] [--press <css>]
   ```

   It drives the real element (click to check or open, fill, keyboard focus, hover, press and hold) and saves `captures/<item>/states/<state>-<width>.png` at the render scale. Without `--selector` it saves the viewport, for a list that opens outside its field. States that interaction cannot reach (disabled, error) are captured where the preview already shows them; otherwise the check's `detail` says they were compared in code only. Record one check per set, named `States: <set>`, pass or fail, with what differs in `detail`, the trigger and timing included. A difference goes into the fix round like any other finding.

### 6. Review

One reviewer Agent on `models.review` (never downgraded) with the lenses in `review.lenses`:

- **parity**: build against the renders and `copy.json`, string by string; nothing missing, nothing invented. Every state of every interactive element against its component set render, and every designed interaction with its trigger, duration and easing; a state with no design is in `components` with its source.
- **responsive**: every review width and the extra widths; overflow, wrapping, sticky elements covering content.
- **a11y**: WCAG 2.2: target size (24 px minimum, 44 px on touch), visible focus, contrast, alt text, reduced motion.
- **regressions**: the regression captures and every page that uses a changed shared component.

Findings go back to the lane once per `review.max_fix_rounds`, then verify again. The captures are evidence for the reader, not a score: never compute or report a match percentage.

### 7. Revert what still fails

An item that still fails a gate after the fix round: `git diff <sha>~1 <sha> --output=<batch dir>/patches/<item>.patch`, then `git revert --no-edit <sha>`, outcome `failed`, and a not-done line naming the patch. Every pipeline branch passes its checks.

### 8. Record as you go

As soon as an item is settled, write its result to a file in the batch folder and record it:

```
figpipe record <batch> results/<item>.json --partial
```

The file is a partial result (`manifest.result_schema`, every top-level field optional): `{"items": [ {...} ], "not_done": [...], "checks": [...]}`. Recording again replaces that item's rows. A timeout or budget stop keeps every item already recorded, and a retry only reruns the rest.

What goes in each field:

| Field | Rule |
| --- | --- |
| `verdict` | One plain line, past tense, what happened: "Pricing rebuilt with three plans and the billing toggle." No hedging, no second sentence. |
| `captures` | The rows `figpipe capture` printed, merged per width with the Figma render path. Only for `redesign`, `fix`, `new_page`, and for watched items that changed code. |
| `text_diff` | For `copy`: each changed string verbatim, `where` names the place in plain words. |
| `preview` | The preview link(s) for the changed route, labelled with the route. `lane.preview` is built from the lane name; record a link only after it answered, and use the page's real route when they differ. |
| `decisions` | `text` states the conflict; `default_applied` states what the build does now. |
| `questions` | Written to the designer, ready to paste: names the layer by name, one question per line. Add `section` and `layer`. What the build uses meanwhile is the decision's job. A state the build proposed is not listed here: figpipe asks it from `components`. |
| `flags` | Looks unconsidered, one fact per line: copy that differs across breakpoints, missing empty, loading or long-text states, tap targets under 44 px, overflow, sticky overlap, motion without reduced motion or a tablet variant, hidden layers, placeholder text. A missing hover, focus, checked, error, disabled or open state goes in `components` instead. |
| `components` | Where the states of each interactive element came from, one row per element: `element` in plain words, `source` (`figma_component`, `figma_elsewhere`, `project`, `platform_default`), and for every source but the component `used` (what was used) and `states` when the row covers only some of them. `{"element": "Checkbox", "source": "figma_component"}`, `{"element": "Phone list", "states": "open", "source": "project", "used": "the site's existing dropdown"}`. figpipe writes the report line from these rows ("Checkbox: states from Figma component; Phone list open state: not designed, used the site's existing dropdown") and asks each proposed one as a question: "Phone list has no open state in Figma; the build uses the site's existing dropdown. Should it have one?" |
| `reply` | For comment items: the reply Tony can paste into the thread. Short, first person, no promises he didn't make. |

Say each fact once. For comment items the reply carries the question to the commenter, so it is not listed again under questions. The default used meanwhile goes only in the decision, not in the question. A not-done line never repeats an item's question, decision or verdict.

Plain English everywhere: no node ids in sentences, no em dashes, no novels. The report has a fixed layout; the text is what makes it fast to read.

### 9. Finish

1. Record the gate results and regression checks (`checks`) and anything not done (`not_done`, with the exact command or patch path) with one more `--partial` record, plus a one-line `summary` of what was built and what needs Tony.
2. Leave dev servers running. The sandbox does not let a later command stop them; figpipe stops them when the session ends.
3. Run `figpipe result <batch>` and return its output, unchanged, as the final answer. It is rebuilt from the recorded rows, so the answer and the report always agree.

## Notes mode

No worktrees, no code, no captures. Triage every item as above, then write `changes.md` per lane in the item's extraction folder: sources, then **A. must change**, **B. minor**, **C. open questions**, each entry with the verbatim copy, the node name and the files it would touch. Record items as `question`, `needs_you`, `already_done` or `fyi` (a planned change, with the verdict starting "Plan:"), with the same decisions, questions, flags and replies.

## When things go wrong

| Situation | Do |
| --- | --- |
| A lane is `blocked` | Skip it; one not-done line with the reason. Its items stay pending for the next batch. |
| Extraction warning (node gone, render missing) | Build from what exists; flag the gap. |
| A command is denied | Do not work around it. Record a not-done line with the exact command so Tony can allow it. |
| The dev server will not start | Record the error output under not done; commit nothing for that lane's visual items. |
| A capture fails | Record one not-done line for that item (`item_id`) with the error. The report shows it on the item as the reason it has no screenshots. |
| A command fails with a sandbox violation (a host or path it may not reach) | Do not work around it. Record a not-done line with the command and the host or path it needed, so Tony can allow it. |
| The design changed after pickup (`context.changed_or_unmarked_after_pickup`) | Finish against the extracted version; flag that a newer version is waiting. figpipe queues it for the next batch. |
