---
name: figma-setup
description: Onboard a project to figpipe, the Figma handoff watcher: profile the repo and the user's Figma access, pick the cheapest path that works, ask only what cannot be inferred, write the project config and notes, and validate them. Doctor mode re-checks a configured project. Use when the user says "set up the Figma pipeline", "watch this Figma file", "onboard this repo for Figma handoffs", pastes a Figma link with "keep an eye on this", or asks "figma doctor" / "is the Figma pipeline working".
---

# Figma pipeline setup

Find out almost everything yourself, show it back once, ask the few things only the user knows, write one config file, prove it works. The user should answer at most eight short questions and read no explanation longer than two lines.

figpipe lives in the Pantograph repo next to this skill: resolve this skill's real folder, then `node <pantograph>/figpipe/figpipe.mjs <command>`. Below, `figpipe` means that. It needs Node 22.5 or newer.

## Never

- Write to Figma, create webhooks, or open figma.com or the Figma app. Reads go through figpipe (REST) and the Figma MCP `whoami`.
- Run `launchctl` or write under `~/Library`. figpipe prints the commands; the user runs them.
- Edit the project repo. The only repo change is the `.figma/` line figpipe adds to `.git/info/exclude` on its first extraction.
- Print or store a token. Configs hold references (`file:`, `op:`, `keychain:`, `env:`), never values.

## Setup

### 1. Profile

1. Repo: the current directory unless the user named one.
2. Figma link: the one the designer works in. If none was given, ask question 1 now; everything else can wait.
3. Run `figpipe probe <repo> <figma link> --json`. It reads the repo (framework, package manager, dev command and port, checks, CMS, tokens, preview routes, worktrees, feature branches, Figma links already in the repo and any `.claude/skills/*figma*` overlay) and Figma (who the token belongs to, the rate tier, each file's name, role, last edit and editor, pages, where ready-for-dev marks sit, frame widths, whether webhooks are readable). Pass `--pages "A,B"` once the pages are known.
4. Call the Figma MCP `whoami` (free, never counted). It gives the seat and plan, which set the daily MCP calls:

| Seat on the file's plan | MCP calls | REST large reads |
| --- | --- | --- |
| Dev or Full, Professional | 200 a day | 10 a minute |
| Dev or Full, Organization | 200 a day | 15 a minute |
| Dev or Full, Enterprise | 600 a day | 20 a minute |
| View or Collab | about 6 a month | about 6 a month |

5. Same-name files: Figma allows them, and the stale one looks identical. When the repo names other keys for a file with the same name (`repo.figma.keys_in_repo` in the probe output), probe them too. The most recently edited one is live; the others go in `stale_copies`. If the user's link is the older one, say so and ask.

### 2. Pick the path

| What the probe found | Path |
| --- | --- |
| REST token on a Dev/Full seat, MCP connected | Standard: REST watches and extracts, MCP only for motion and video. |
| REST token, no MCP | Same, but motion items are flagged for the designer instead of read. Say so in one line. |
| No REST token | Watching needs one. Ask the user to create a personal access token with `file_content:read`, `file_comments:read`, `file_versions:read`, `current_user:read` (and `webhooks:read`), saved to `~/.config/figma/pat` with mode 600, or as a 1Password reference (`op:`). |
| Rate tier `low` (View or Collab seat) | Notify only. Say plainly: about 6 large reads a month cannot keep up with a working file. |
| No `package.json` or unknown dev command | Notes mode until those exist; Build needs a dev server. |
| No Playwright | Build still works; offer the one-time install in step 7 so reports get screenshots. |

Webhooks are not built yet (`receiver.enabled` is refused), so checks poll on a schedule (question 5). Instant alerts through a webhook are possible later for files where the user has edit access; mention that in one line when asking question 5, and do not offer to set it up now.

### 3. Show what you inferred, once

One table, one confirmation. Plain words, the value, where it came from. Example rows:

| Setting | Value | From |
| --- | --- | --- |
| Watched file | Acme Website (live; the copy `Ab12...` is older) | your link, last edits |
| Pages | Development Ready | page names, 10 ready marks found |
| Ready marks sit | 2 levels under the page | page scan |
| Breakpoints | 1440, 1024, 390 | frame widths |
| You in Figma | tony | token |
| Dev server | `npx nuxt dev --port {port}`, pipeline ports from 3011 | package.json (you use 3001) |
| Preview | `/en-gb/preview/{page}` | `pages/[lang]/preview/` |
| Checks | `npm run lint:quiet`, `npm run typecheck` | package scripts |
| Name | Tern website | repo folder |
| CMS | Storyblok, never written by the pipeline; sessions may read its API | dependencies |
| Worktree files | `.env` copied into each build folder, without secret and access-token keys | ignored files at the repo root |
| Builds | branch `figma/<page>` in `<repo>-fp-<page>`, on top of the page's `feat/` branch when one exists | git |

### 4. Draft the config and count what is waiting

Questions 7 and 8 quote the dry run, so it comes before the questions.

1. `figpipe config example` prints every setting with its default. Write `~/.figpipe/projects/<slug>.toml` with only what differs from the defaults plus the required fields, taking the inferred values and the defaults for anything still open. The slug is the repo folder name, lowercase. Set `project.name` to the name people use for the site ("Tern website"); reports and notifications use it. Start `[schedule]` as `mode = "follow"` with `my_timezone` set to the user's zone, the default of question 5.
2. `figpipe config check <slug>`: fix every named field until it passes.
3. `figpipe tick --dry-run --backfill --project <slug>`: what a first check would pick up if it took everything already open. It writes nothing. Count the ready sections and the threads for question 7. Count out-of-scope and "is this yours?" lines separately; they come from `[scope]`, which question 8 fills in. Rerun it after writing `[scope]` and check the counts.
4. `figpipe activity --project <slug> --user-tz <the user's zone>` (read-only; the user's zone is the Mac's unless they say otherwise): when edits, comments and ready marks actually happened in the last 30 days, per person, each person's working blocks in their time and in the user's time, and one line saying what "Follow the designers" would do with that activity (the blocks it would derive, in both zones, and the check before the user's day). It also reads the file's stale copies, where the same designers worked earlier, so a file that is only days old still has history. Questions 5 and 6 quote it. What to know about the output: a designer's zone is a guess from their hours and is good to within an hour or two (it lists the zones that fit equally), so confirm it with the user in a few words ("Mara looks like Berlin time, right?"); under about 5 active days it says there is too little activity and follow mode uses a fallback (hourly 08:00-20:00 in the guessed zone) until there is more; the user's own saves and comments are left out.
5. `figpipe status --json` gives `schedule.wake_command`, the sleep/wake alternative for question 6, computed for the day start and the blocks in use. Before the first check those are the fallback blocks, so the time can move by up to an hour once the real blocks are derived; `figpipe doctor` prints the current one if the Mac turns out to sleep. Run it again after question 6 changes the day start.

### 5. Ask only what is left

Ask a question only when the probe left it open. Each one gets two short lines and a default, and the user can answer all of them in one reply.

1. **Which file and pages should I watch?** Paste the link the designer works in. Figma allows two files with the same name, so I'll check which one was edited last. *Default: none, required.*
2. **How much should it do on its own?** Build makes the change on a local branch, checks it at desktop, tablet and mobile, and commits; Notes writes the change list and designer questions without code; Notify only tells you what's new and costs nothing. *Default: Build (Notes when the project has no dev server or no checks).*
3. **Where should builds go?** Each page gets its own branch in a folder next to the repo, never your own checkout. *Default: `figma/<page>` in `<repo>-fp-<page>`, on the page's feature branch when one exists.* Ask only when a page's feature branch is ambiguous.
4. **What are the limits?** Caps stop a busy design day from using the week's allowance. *Default: $15 a batch (retries included), $45 a day, 4 batches a day, 90 minutes a batch, 120 of the 200 daily Figma MCP calls (20 of them kept for motion).*
5. **When would you like figpipe to check for new handoffs?** *Default: Follow the designers (recommended).* One short explanation: figpipe reads when the designers actually work in the file, checks every hour inside those hours and once more before your day starts, and re-measures weekly, so it keeps up when their hours change. Quote what step 4 measured in both zones: "Mara works about 09:00-18:00 Berlin (00:00-09:00 your time). Zoë 14:00-20:00 Berlin (05:00-11:00 your time). Following them means hourly checks 09:00-20:00 Berlin (00:00-11:00 your time), Mon-Fri." With too little activity say so: "Not enough history yet; it checks hourly 08:00-20:00 until there is." The user can instead answer in their own words for fixed times ("6, 2 and 10"), blocks ("hourly, 9 to 6, weekdays") or "weekday mornings". Instant alerts can come later where you have edit access to the file. Background running is yes (I print the commands) unless the answer is "I'll run it myself".
6. **When does your day start?** *Default: 08:00 in your time zone.* One check lands 60 to 90 minutes before, so builds are waiting when you sit down. Add one line about sleep: figpipe checks only while the Mac is awake, so keep it awake during those hours with an app like Amphetamine (https://apps.apple.com/us/app/amphetamine/id937984704); the alternative is `<wake_command from step 4>`, which wakes it for the check before your day, needs your password and works best on power. Never run the command; the user does if they want it.
7. **Pick up what's already waiting?** Quote the dry run from step 4: "There are 10 ready sections and 8 threads mentioning you." *Default: yes when it fits in one batch (`batching.max_items`), otherwise no and list them so you can `figpipe add` the ones you want.*

8. **Which sections are yours?** Say why in two lines: "figpipe only builds what is yours; other developers' sections stay untouched. Here is who I think owns each one." Then run `figpipe own --list --project <slug> --json` (reads the watched pages, keeps nothing) and show one table: section, owner (mine, others with who, unknown), confidence, why ("Mara tags Ada, Arlo and Lena here"). *Default: the inferred owners, with unknown ones asked.* The user confirms or corrects the whole table in one reply. Save the answers as explicit rules: yours go to `include`, theirs to `exclude`, the people they tag to `others`, section-to-person pairs from a tracker to `[scope.assign]`. Set `unknown = "ask"` so a section that turns up later with no owner is held instead of built. Run `figpipe config check`, then the dry run again and read the counts back: "7 yours, 5 someone else's, 0 unknown."
   - Inference reads who is @mentioned on each section's comments; a section is yours when its comments tag you, theirs when they tag only other people. Names, the Figma file structure and `figpipe own --list` carry the rest. Ask the user for the people list when comments name people without telling who builds what.
   - Tracker: when the user points at a Notion, Linear or similar page with an implementer column, read it with the connected tool, store the section-to-implementer pairs in `[scope.assign]` and the URL in `scope.tracker`. Do not ask for one.
   - Later, a newly ready section with an unknown owner is held and shows as "Is this yours?" in `figpipe status` and the index, with the `figpipe own "<name>" mine|others` command to answer it. Others' sections are skipped and only counted. `figpipe add <link>` always overrides scope.

Also ask, only when unresolved: the preview route, the dev command, and the display names people use when they @mention the user.

### 6. Finish the config and notes

1. Apply the answers to the config and run `figpipe config check <slug>` again. Turn the answers to questions 5 and 6 into `[schedule]` (the table is in `figpipe config example`):
   - Follow the designers (the default): `mode = "follow"`, `every = 60` (the minutes between checks inside their blocks, unless the user said otherwise), `my_day_starts = "08:00"` (question 6), `my_timezone` (the user's zone). Add `timezone` only when the user names the designers' zone, and `days` only to narrow the days. No `times` or `windows`; figpipe derives the blocks at the first check.
   - Fixed times or blocks, when the user answered in their own words: `mode = "times"` or `"windows"`. `timezone` is the zone the times are written in: the designers' when the user speaks about their hours, the user's own when they speak about their day ("6 in the morning"). Ask when it is unclear. Exact times become `times = ["06:00", "14:00", "22:00"]`; blocks become `windows = [{ start = "09:00", end = "18:00", every = 60 }]` (several allowed, one or the other, never across midnight); weekdays become `days = ["mon", ...]`.
   - "Every 30 minutes all day" or "often" is no `[schedule]` and `batching.poll_minutes = 30`.
   - Say what it means in one line, with the next check from `figpipe status`: "Hourly 09:00-20:00 Berlin time, Mon-Fri (00:00-11:00 yours), plus one check at 07:00 before your day; next Mon 09:00 CEST." With few checks a day, a batch also starts only at a check, which the user should hear once.
2. Write `~/.figpipe/projects/<slug>.notes.md`: the prose rules the config can't hold (for example "desktop copy is canonical", the voice for designer questions). When the repo has a Figma overlay skill, import its rules here and flag stale facts, such as a file key that is now the stale copy.
3. Unknowns stay at their default, with one line in the notes saying what is unknown. Doctor lists them.
4. Sections the user already built from in-progress designs (preview routes for pages not marked ready, a spec under the extract folder that names a node on a work-in-progress page): offer to watch them, one `[[figma.files.watch]]` entry each with `node`, `name`, `branch` (the local branch holding the build) and `route`, `built = false` for one not built yet. The first check records each one's baseline; `figpipe watch` lists them.
5. Batch sessions run in an OS sandbox that reaches only Figma's API, localhost and the CMS's read API (from `stack.cms.kind`). When the dev server needs another host to render (an image CDN, an API it reads at build time), add it to `stack.allowed_domains`. Never add a host that accepts writes.

### 7. Prove it

1. `figpipe doctor <slug>`: one line per check; fix every FAIL before going on.
2. Screenshots need Playwright, installed once for every project and never in the repo: `npm i --prefix ~/.figpipe playwright && npx --prefix ~/.figpipe playwright install chromium`. Offer it when doctor says Playwright is missing; without it Build still runs and each report says why it has no screenshots.
3. The first real check records the current state without triggering; `figpipe tick --project <slug> --backfill` picks up what is already open (question 7).
4. Optional: `figpipe report --sample` renders a made-up batch so the user can see what every report will look like.
5. Background check, after a yes: `figpipe launchd install` writes the job file and prints the commands. Show them to the user to run. The job wakes figpipe every 15 minutes; each project's `[schedule]` decides when it is checked, so changing a schedule later needs no reinstall. Removal: `figpipe launchd uninstall`.

### 8. Hand back

Five lines at most: what is watched, the mode, the limits, when it checks and whether the background check is on, and how to see what is waiting and the next check (`figpipe status`). No recap of the steps.

## Doctor

Run `figpipe doctor [<slug>]`, plus the Figma MCP `whoami` in this session. Report one line per problem with its fix, in plain words, worst first. Nothing to fix: say so in one line.

Ownership: doctor warns when a section marked yours now mostly draws comments that tag other people (or the reverse), and when ready sections wait for an owner. Say it plainly ("Insulation is set to yours, but its last comments tag Ada and Arlo") and offer the one-line answer: `figpipe own "Insulation" others`. Change the rule only after a yes.

In follow mode doctor lists the derived blocks and when they were derived; there is no drift to fix because figpipe re-derives them every `refresh_days`. When doctor reports the Mac asleep at check times (the log shows repeated catch-ups), say it plainly and lead with the simple fix: "Your Mac slept through several checks in the last two weeks. Keep it awake with an app like Amphetamine (https://apps.apple.com/us/app/amphetamine/id937984704). The alternative is `<the command doctor prints>`, which needs your password and works best on power; I won't run it." Say nothing about sleep when doctor does not report it.

For a fixed schedule, doctor compares it with the last 14 days of edits and comments. When it warns that the pattern has drifted, say it the way a person would and offer the fix: "The designers now mostly edit 14:00-20:00 your time; your checks at 06:00 and 14:00 miss most of that." Run `figpipe activity --project <slug>`, show the new blocks in both zones, propose the suggested schedule as the new default, and apply it the same way as question 5 only after a yes.

Things doctor cannot see from here:

- Whether a session started by launchd reaches the Figma MCP sign-in. The first real batch shows it: a batch without MCP still builds, and its report lists motion under not done. When that happens, sign in to Figma MCP again in an interactive session.
- Whether `limits.usd_per_batch` stops anything on a subscription login. The dependable caps are `limits.max_minutes`, `limits.batches_per_day`, `limits.usd_per_day` (a run stopped at the time limit counts as its whole limit) and the usage-meter pace check.
- Whether the dev server renders inside the sandbox. The first real batch shows it: a host the dev server needed shows up in the report's not-done list as a sandbox violation. Add read-only hosts to `stack.allowed_domains`.

When a project is blocked (figpipe marks it after Figma rejects the token), the fix is a new token at the same reference; the next good check clears the block. When Figma asks for a long rate-limit wait (hours or days on lower seat tiers), figpipe stops checking that project until then and `figpipe status` shows the time.
