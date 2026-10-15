// The proof packet: one static HTML page per batch plus an index, rendered from state.db.
// Same layout every time, light and dark, works offline, no external assets. Images are
// copied into the batch folder and referenced relatively, so the folder can be moved or zipped.
import { mkdirSync, writeFileSync, existsSync, copyFileSync, statSync, readFileSync } from "node:fs";
import { join, relative, basename, isAbsolute, extname } from "node:path";
import { paths } from "./paths.mjs";
import { budgetToday } from "./db.mjs";
import { scopeSummary, scopeLine, askLines } from "./scope.mjs";
import { figmaLink } from "./extract.mjs";
import { sha } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const j = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export const OUTCOMES = {
  needs_you: { label: "Needs you", tone: "warn", rank: 0 },
  question: { label: "Question", tone: "warn", rank: 1 },
  failed: { label: "Failed", tone: "bad", rank: 2 },
  applied: { label: "Built", tone: "good", rank: 3 },
  already_done: { label: "No change needed", tone: "muted", rank: 4 },
  fyi: { label: "FYI", tone: "muted", rank: 5 },
  pending: { label: "Not run", tone: "muted", rank: 6 },
  skipped: { label: "Skipped", tone: "muted", rank: 7 },
  cancelled: { label: "Cancelled", tone: "muted", rank: 8 },
};
// One line for the notification and the index: what was built and what needs Tony. Questions
// count from the questions themselves, so an "already built" item with questions still shows them.
export function batchLine(db, batchId) {
  const items = db.all("SELECT outcome, COUNT(*) AS n FROM items WHERE batch_id = ? GROUP BY outcome", batchId);
  const c = (k) => items.find((x) => x.outcome === k)?.n ?? 0;
  const q = questionCount(db, batchId, c("question"));
  return [
    c("applied") && `${c("applied")} built`,
    q && `${q} question${q === 1 ? "" : "s"}`,
    c("needs_you") && `${c("needs_you")} for you`,
    c("failed") && `${c("failed")} failed`,
    c("fyi") && `${c("fyi")} new`,
  ]
    .filter(Boolean)
    .join(", ");
}
// A batch stays in status and at the top of the index until Tony reviews it, and a batch figpipe
// marked reviewed (nothing built) stays while it holds questions or news for him.
export function stillShown(db, b) {
  if (!["reviewed", "rejected"].includes(b.status)) return true;
  if (b.reviewed_by !== "auto") return false;
  return questionCount(db, b.id) > 0 || db.get("SELECT COUNT(*) AS n FROM items WHERE batch_id = ? AND outcome = 'fyi'", b.id).n > 0;
}
// A ready batch that Claude could not run yet (usage limit, signed out) is waiting, and says why.
export const isWaiting = (b) => b.status === "ready" && !!b.wait_kind;
export const statusLabel = (b) => (b.reviewed_by === "auto" && b.status === "reviewed" ? "nothing to review" : isWaiting(b) ? "waiting" : b.status);
const questionCount = (db, batchId, questionItems = 0) => Math.max(db.get("SELECT COUNT(*) AS n FROM notes WHERE batch_id = ? AND kind = 'question'", batchId).n, questionItems);


// Gather everything the page shows. Pure reads.
export function reportData(db, batchId) {
  const batch = db.get("SELECT * FROM batches WHERE id = ?", batchId);
  if (!batch) throw new Error(`no batch ${batchId}`);
  // Open threads pinned inside a node item, from the extraction: the comments the session read.
  let extracted = {};
  try {
    if (batch.dir) extracted = JSON.parse(readFileSync(join(batch.dir, "extract.json"), "utf8")).items ?? {};
  } catch {}
  const items = db.all("SELECT * FROM items WHERE batch_id = ?", batchId).map((it) => {
    const thread = it.thread_id
      ? db.all("SELECT author, message, created_at, by_me FROM comments WHERE project = ? AND file_key = ? AND root_id = ? AND deleted = 0 ORDER BY created_at", it.project, it.file_key, it.thread_id)
      : [];
    const events = j(it.source, {}).events ?? [];
    const late = db.all("SELECT note FROM events WHERE item_id = ? AND note IS NOT NULL", it.id).map((e) => e.note);
    const inside = it.thread_id ? [] : (extracted[it.id]?.threads ?? []).filter((t) => !t.resolved && t.messages?.length);
    const ex = extracted[it.id] ?? {};
    return {
      ...it,
      watch: j(it.watch, null),
      figma_before: j(it.figma_before, []),
      design: { renders: ex.renders ?? [], baseline: ex.baseline ?? null, sdiff: ex.sdiff ?? null, copy_diff: ex.copy_diff ?? null, components_line: ex.components?.line ?? null },
      thread,
      inside,
      events,
      late,
      preview: j(it.preview, []),
      commits: j(it.commits, []),
      text_diff: j(it.text_diff, []),
      motion: j(it.motion, []),
      components: j(it.components, []),
      captures: db.all("SELECT * FROM captures WHERE item_id = ? ORDER BY width DESC", it.id),
      decisions: db.all("SELECT * FROM notes WHERE item_id = ? AND kind = 'decision' ORDER BY id", it.id),
      questions: db.all("SELECT * FROM notes WHERE item_id = ? AND kind = 'question' ORDER BY id", it.id),
      flags: db.all("SELECT * FROM notes WHERE item_id = ? AND kind = 'flag' ORDER BY id", it.id),
    };
  });
  items.sort((a, b) => (OUTCOMES[a.outcome]?.rank ?? 9) - (OUTCOMES[b.outcome]?.rank ?? 9) || a.id - b.id);
  // Lanes from the manifest: how to start each branch's preview.
  let lanes = [];
  try {
    if (batch.dir) lanes = JSON.parse(readFileSync(join(batch.dir, "batch.json"), "utf8")).lanes ?? [];
  } catch {}
  return {
    batch,
    items,
    lanes,
    notDone: db.all("SELECT * FROM notes WHERE batch_id = ? AND kind = 'not_done' ORDER BY id", batchId),
    checks: db.all("SELECT * FROM notes WHERE batch_id = ? AND kind = 'check' ORDER BY id", batchId),
    context: db.all("SELECT kind, payload FROM events WHERE batch_id = ? AND kind IN ('identity', 'version') ORDER BY id", batchId).map((e) => ({ kind: e.kind, ...j(e.payload, {}) })),
    denials: db.all("SELECT tool, input, reason, at FROM denials WHERE batch_id = ? ORDER BY id", batchId),
    budget: budgetToday(db, batch.project),
  };
}

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};

// Copy a media file into the batch folder (if it lives elsewhere) and return its relative path.
function mediaRef(p, dir) {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : join(dir, p);
  if (!existsSync(abs)) return null;
  if (abs.startsWith(dir + "/")) return relative(dir, abs);
  const name = `${sha(abs, 10)}-${basename(abs)}`;
  const dest = join(dir, "media", name);
  mkdirSync(join(dir, "media"), { recursive: true });
  if (!existsSync(dest) || statSync(dest).size !== statSync(abs).size) copyFileSync(abs, dest);
  return `media/${name}`;
}
const isImage = (p) => [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(extname(p ?? "").toLowerCase());

// Pixel size of an image file, read from its header (PNG, GIF, JPEG, WebP, SVG). Null when unknown.
function imageSize(abs) {
  try {
    const b = readFileSync(abs);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) i += 1;
        else if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2;
        else i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const t = b.toString("ascii", 12, 16);
      if (t === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (t === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (t === "VP8L") {
        const n = b.readUInt32LE(21);
        return { w: 1 + (n & 0x3fff), h: 1 + ((n >>> 14) & 0x3fff) };
      }
    }
    if (extname(abs).toLowerCase() === ".svg") {
      const tag = b.toString("utf8", 0, 4096).match(/<svg\b[^>]*>/i)?.[0] ?? "";
      const num = (k) => +(tag.match(new RegExp(`\\s${k}="\\s*([\\d.]+)(?:px)?\\s*"`))?.[1] ?? 0);
      const vb = tag.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
      const w = num("width") || +(vb?.[1] ?? 0);
      const h = num("height") || +(vb?.[2] ?? 0);
      if (w && h) return { w, h };
    }
  } catch {}
  return null;
}
// A media file copied into the batch folder, with its size when the header says.
function media(p, dir) {
  const ref = mediaRef(p, dir);
  return ref ? { ref, size: imageSize(join(dir, ref)) } : null;
}

// ---- Rendering -----------------------------------------------------------------------------------
// One layout for every batch: a header (title, status, counts, the next step), an item list (a
// sticky column on wide screens, a list under the header on narrow ones), then one section per item
// with the same subsections in the same order. Every text block, divider and table stops at one
// right edge (--measure); only screenshot grids use the full column.

const svgIcon = (body) => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
const RING = '<circle cx="8" cy="8" r="6.25"/>';
const DOT = (y) => `<circle cx="8" cy="${y}" r="0.4" class="dot"/>`;
const ICON = {
  check: svgIcon(`${RING}<path d="m5.4 8.2 1.8 1.8 3.4-3.7"/>`),
  alert: svgIcon(`${RING}<path d="M8 4.9v3.7"/>${DOT(11)}`),
  question: svgIcon(`${RING}<path d="M6.3 6.5a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.8.6-.8 1.15v.15"/>${DOT(11.3)}`),
  cross: svgIcon(`${RING}<path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2"/>`),
  dash: svgIcon(`${RING}<path d="M5.5 8h5"/>`),
  info: svgIcon(`${RING}<path d="M8 7.4v3.6"/>${DOT(5)}`),
  ring: svgIcon(RING),
  copy: svgIcon('<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/>'),
  copied: svgIcon('<path d="m3.5 8.5 3 3 6-7"/>'),
  ext: svgIcon('<path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>'),
  prev: svgIcon('<path d="m10 3.5-4.5 4.5 4.5 4.5"/>'),
  next: svgIcon('<path d="m6 3.5 4.5 4.5L6 12.5"/>'),
  close: svgIcon('<path d="m4 4 8 8m0-8-8 8"/>'),
  expand: svgIcon('<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>'),
};
const OUTCOME_ICON = { needs_you: "alert", question: "question", failed: "cross", applied: "check", already_done: "check", fyi: "info", pending: "ring", skipped: "dash", cancelled: "dash" };
const outcomeOf = (k) => OUTCOMES[k] ?? { label: String(k ?? "Unknown"), tone: "muted" };
const status = (label, tone, icon) => `<span class="status tone-${tone}">${ICON[icon] ?? ICON.ring}<span>${esc(label)}</span></span>`;
const outcomeStatus = (k) => status(outcomeOf(k).label, outcomeOf(k).tone, OUTCOME_ICON[k]);
const CHECK = { pass: ["Passed", "good", "check"], fail: ["Failed", "bad", "cross"], skip: ["Skipped", "muted", "dash"] };
const BATCH_STATUS = {
  done: ["Ready to review", "warn", "alert"], reviewed: ["Reviewed", "good", "check"], rejected: ["Rejected", "muted", "cross"],
  stuck: ["Stopped", "bad", "cross"], running: ["Running", "muted", "ring"], ready: ["Waiting to run", "muted", "ring"],
  extracting: ["Reading Figma", "muted", "ring"], failed: ["Failed", "bad", "cross"],
};
const WAIT_STATUS = { usage: "Waiting for Claude usage", auth: "Waiting for Claude sign-in", credit: "Waiting for Claude credit" };
const batchStatus = (b) =>
  b.reviewed_by === "auto" && b.status === "reviewed" ? ["Nothing to review", "muted", "check"]
  : isWaiting(b) ? [WAIT_STATUS[b.wait_kind] ?? "Waiting for Claude", "warn", "alert"]
  : BATCH_STATUS[b.status] ?? [String(b.status ?? "Unknown"), "muted", "ring"];
const batchStatusChip = (b) => status(...batchStatus(b));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const copyBtn = (text, name) =>
  `<button type="button" class="icon" data-copy="${esc(text)}" aria-label="${esc(name)}" title="${esc(name)}">${ICON.copy}</button>`;
// A line of text with a copy button in a fixed trailing slot, so buttons line up down a list.
const copyRow = (html, text, name) => `<div class="copyrow"><div class="copytext">${html}</div>${copyBtn(text, name)}</div>`;
// Commands wrap only between words, so a flag like --port never splits across lines.
const cmdRow = (cmd, name) => copyRow(`<code class="cmd">${String(cmd).split(" ").map((t) => `<span>${esc(t)}</span>`).join(" ")}</code>`, cmd, name);
// Label and value pairs: a label column and a value column, one row each.
const pairs = (rows) => (rows.length ? `<dl class="pairs">${rows.map(([l, v]) => `<dt>${esc(l)}</dt><dd>${v}</dd>`).join("")}</dl>` : "");

const itemTitle = (it) => String(it.title ?? it.area_name ?? `Item ${it.id}`).replace(/^Comment on /i, "");
const sub = (title, body, cls = "") => (body ? `<section class="sub${cls ? ` ${cls}` : ""}"><h3>${title}</h3>${body}</section>` : "");

// Why an item is in the batch. Shown under Source, never next to the status.
const KINDS = { ready: "Marked ready for dev in Figma", changed: "Edited in Figma after the last build", comment: "Comment in Figma", manual: "Added by you" };
// Items on a section you pre-built while it was in progress (a watched section).
const WATCH_KINDS = {
  ready: (w) => (w.built ? "Marked ready for dev in Figma; you pre-built it from the in-progress design" : "Marked ready for dev in Figma; an in-progress section you have not built yet"),
  changed: (w) => (w.built ? "The in-progress design changed since your pre-built page" : "The in-progress design has content now; not built yet"),
  comment: () => "Comment on a section you pre-built",
  manual: () => "Added by you",
};
const triggerLabel = (it) => (it.watch ? WATCH_KINDS[it.kind]?.(it.watch) : null) ?? KINDS[it.kind] ?? it.kind;

// A fixed-aspect window over an image, top aligned, that opens the image full size. An image taller
// than the window is cropped and labelled so; when the size is unknown the page script checks.
function frame(m, { aspect, alt, group, label, cls = "" }) {
  const style = ` style="aspect-ratio:1/${aspect.toFixed(3)}"`;
  if (!m) return `<div class="frame empty${cls}"${style}>No capture</div>`;
  const known = m.size?.w > 0 && m.size?.h > 0;
  const cropped = known && m.size.h / m.size.w > aspect + 0.005;
  return `<a class="frame${cls}${cropped ? " cropped" : ""}"${style} href="${esc(m.ref)}" title="Open full size" data-view="${esc(group)}" data-label="${esc(label)}"${known ? "" : " data-fit"}><img src="${esc(m.ref)}" alt="${esc(alt)}" loading="lazy"${known ? ` width="${m.size.w}" height="${m.size.h}"` : ""}><span class="crop">${ICON.expand}Cropped</span></a>`;
}
// The window fits the tallest image in a row, up to a cap, so every frame in a row is the same size.
const fitAspect = (sizes, cap) => {
  const a = sizes.filter((s) => s?.w > 0 && s?.h > 0).map((s) => s.h / s.w);
  return a.length ? Math.min(cap, Math.max(...a)) : cap;
};

function threadList(msgs) {
  if (!msgs.length) return "";
  return `<ol class="thread">${msgs
    .map((m) => `<li${m.me ? ' class="me"' : ""}><p class="by"><b>${esc(m.by)}</b> <time>${esc(fmtTime(m.at))}</time></p><p>${esc(m.text)}</p></li>`)
    .join("")}</ol>`;
}

function sourceBlock(it, dir) {
  const msgs = it.thread.length
    ? it.thread.map((m) => ({ by: m.author, text: m.message, at: m.created_at, me: m.by_me }))
    : (it.inside ?? []).slice(0, 6).flatMap((t) => t.messages.map((m) => ({ by: m.by, text: m.text, at: m.at, me: m.by_me })));
  const area = it.area_name && it.area_name !== it.title && it.area_name !== itemTitle(it) ? it.area_name : null;
  const trigger = [triggerLabel(it), area].filter(Boolean).map(esc).join(" · ");
  const notes = [];
  const manual = it.events.find((e) => e.payload?.manual && e.payload.note);
  if (manual) notes.push(manual.payload.note);
  const ready = it.events.find((e) => e.kind === "ready" || e.kind === "changed");
  if (ready?.payload?.description) notes.push(ready.payload.description);
  const render = isImage(it.figma_render) ? media(it.figma_render, dir) : null;
  const title = itemTitle(it);
  const thumb = render ? frame(render, { aspect: fitAspect([render.size], 1), alt: `Figma frame: ${title}`, group: `src-${it.id}`, label: `${title} · Figma frame`, cls: " thumb" }) : "";
  const link = it.node_id ? `<p><a class="ext" href="${esc(figmaLink(it.file_key, it.node_id))}">Open in Figma ${ICON.ext}</a></p>` : "";
  const text = `${trigger ? `<p class="muted">${trigger}</p>` : ""}${notes.map((n) => `<p>${esc(n)}</p>`).join("")}${threadList(msgs)}${link}`;
  if (!thumb && !text) return "";
  return sub("Source", `<div class="source">${thumb}<div class="source-text">${text}</div></div>`);
}

// A watched section's design change: Figma as the build was made from it, and Figma now, per frame
// (the breakpoints). Frames pair by node id, else by name; the whole section when it has no frames.
function designBlock(it, dir) {
  if (!it.watch || !it.figma_before.length || !it.design.renders.length) return "";
  const now = it.design.renders.filter((r) => r.role !== "pin");
  const pick = (list) => (list.some((r) => r.role === "child") ? list.filter((r) => r.role === "child") : list);
  const after = pick(now);
  const before = pick(it.figma_before);
  const pairsOf = after.map((a) => [before.find((b) => b.node_id === a.node_id) ?? before.find((b) => b.name === a.name) ?? null, a]);
  const from = it.design.baseline?.at ? fmtTime(it.design.baseline.at) : null;
  const title = itemTitle(it);
  const rows = pairsOf
    .map(([b, a], i) => {
      const ms = [b && media(b.path, dir), media(a.path, dir)];
      const phone = (a.width ?? 0) > 0 && a.width < 600;
      const aspect = fitAspect(ms.map((m) => m?.size), phone ? 2 : 1.25);
      const label = a.name ?? `Frame ${i + 1}`;
      const group = `design-${it.id}-${i}`;
      const shot = (m, l) => `<figure class="shot"><figcaption>${esc(l)}</figcaption>${frame(m, { aspect, alt: `${title}, ${label}: Figma ${l.toLowerCase()}`, group, label: `${title} · ${label} · ${l}` })}</figure>`;
      return `<div class="shots${phone ? " phone" : ""}"><h4>${esc(label)}${a.width ? ` <span class="muted">${a.width} px</span>` : ""}</h4>${shot(ms[0], from ? `Before (${from})` : "Before")}${shot(ms[1], "Now")}</div>`;
    })
    .join("");
  const counts = [it.design.copy_diff && plural(it.design.copy_diff.changed_lines, "copy line"), it.design.sdiff && plural(it.design.sdiff.changed_lines, "layout line")].filter(Boolean);
  const line = counts.length ? `<p class="muted">${esc(counts.join(" and "))} changed since the design your page was built from.</p>` : "";
  return sub("Design change in Figma", `${line}<div class="grid" style="--cols:2">${rows}</div>`, "wide");
}

const VISUAL = new Set(["redesign", "new_page", "fix"]);
function diffTable(it) {
  if (!it.text_diff.length) return "";
  const rows = it.text_diff
    .map((d) => `<tr><th scope="row">${esc(d.where ?? "")}</th><td><del>${esc(d.before)}</del></td><td><ins>${esc(d.after)}</ins></td></tr>`)
    .join("");
  return `<table class="diff"><thead><tr><th scope="col">Where</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${rows}</tbody></table>`;
}
// Copy changes get a text diff; redesigns, new pages and fixes get Figma / before / after per width.
// Every row uses the same columns, so Figma, Before and After line up down the grid.
function changesBlock(it, dir) {
  // A watched section shows its build before and after even for copy: the page already existed.
  if ((it.change_kind === "copy" && !it.watch) || !it.captures.length) {
    if (it.text_diff.length) return sub("Changes", diffTable(it));
    // A redesign, new page or fix without screenshots says why, so a missing grid never reads as "fine".
    if (VISUAL.has(it.change_kind) && it.outcome !== "already_done")
      return sub("Changes", `<p class="noshot">No screenshots: ${esc(it.noShotReason ?? "none were recorded for this item.")}</p>`);
    return "";
  }
  const hasBefore = it.captures.some((c) => c.before_path);
  const hasFigma = it.captures.some((c) => c.figma_path);
  const cols = [hasFigma && ["figma_path", "Figma"], hasBefore && ["before_path", "Before"], ["after_path", "After"]].filter(Boolean);
  const title = itemTitle(it);
  const rows = it.captures
    .map((c) => {
      const w = c.label ?? `${c.width} px`;
      const phone = c.width < 600;
      const ms = cols.map(([k]) => media(c[k], dir));
      const aspect = fitAspect(ms.map((m) => m?.size), phone ? 2 : 1.25);
      const group = `item-${it.id}-${c.width}`;
      const shots = cols.map(([, l], i) => `<figure class="shot"><figcaption>${esc(l)}</figcaption>${frame(ms[i], { aspect, alt: `${title}: ${l} at ${w}`, group, label: `${title} · ${w} · ${l}` })}</figure>`);
      return `<div class="shots${phone ? " phone" : ""}"><h4>${esc(w)}</h4>${shots.join("")}</div>`;
    })
    .join("");
  return sub(it.watch ? "Build before and after" : "Changes", `<div class="grid" style="--cols:${cols.length}">${rows}</div>${diffTable(it)}`, "wide");
}

// The command that starts the preview comes first: the link is dead until it runs.
function previewBlock(it, lanes) {
  const lane = lanes.find((l) => !l.blocked && l.dev && ((it.branch && l.branch === it.branch) || (it.worktree && l.worktree === it.worktree)));
  const start = lane ? `cd ${lane.worktree} && ${lane.dev}` : null;
  const links = it.preview.filter((p, i, a) => p?.url && a.findIndex((x) => x.url === p.url) === i);
  const code = [
    it.branch && `Branch <code>${esc(it.branch)}</code>`,
    it.commits.length && `${it.commits.length === 1 ? "Commit" : "Commits"} ${it.commits.slice(0, 6).map((c) => `<code>${esc(String(c).slice(0, 9))}</code>`).join(" ")}`,
  ].filter(Boolean);
  const body = [
    start && cmdRow(start, "Copy the command that starts this preview"),
    links.length && `<ul class="links">${links.map((p) => `<li><a href="${esc(p.url)}">${esc(p.label || p.url)}</a></li>`).join("")}</ul>`,
    code.length && `<p class="code">${code.join(" · ")}</p>`,
  ].filter(Boolean).join("");
  return sub(links.length || start ? "Preview" : "Code", body);
}

// Where the states of each interactive element came from, in one line: "Checkbox: states from
// Figma component; Phone list open state: not designed, used the site's existing dropdown".
const statesOf = (r) => (r.states ? ` ${r.states} ${/,|\band\b/.test(r.states) ? "states" : "state"}` : "");
const NOT_DESIGNED = { project: "the project's existing component", platform_default: "the platform default" };
export function componentsLine(rows = []) {
  const whole = rows.filter((r) => r.source === "figma_component" && !r.states).map((r) => r.element);
  const parts = whole.length ? [`${[...new Set(whole)].join(", ")}: states from Figma component`] : [];
  for (const r of rows) {
    if (r.source === "figma_component" && r.states) parts.push(`${r.element}${statesOf(r)}: from Figma component`);
    else if (r.source === "figma_elsewhere") parts.push(`${r.element}${statesOf(r)}: from ${r.used || "the same element elsewhere in the Figma file"}`);
    else if (NOT_DESIGNED[r.source]) parts.push(`${r.element}${statesOf(r)}: not designed, used ${r.used || NOT_DESIGNED[r.source]}`);
  }
  return parts.join("; ");
}

function questionMark(n) {
  return n ? `<span class="q tone-warn">${ICON.question}<span aria-hidden="true">${n}</span><span class="sr">${plural(n, "question")}</span></span>` : "";
}

function itemSection(it, dir, lanes = [], { noMcp = false } = {}) {
  const q = it.questions.length && it.outcome !== "question" ? status(plural(it.questions.length, "question"), "warn", "question") : "";
  const late = it.late.length ? `<p class="late">${status(it.late.map((l) => String(l).replace(/\.$/, "")).join(". ") + ".", "warn", "alert")}</p>` : "";
  const decisions = it.decisions.length
    ? `<ul class="rows">${it.decisions.map((d) => `<li><p>${esc(d.text)}</p>${d.detail ? `<p class="chose">Chose: ${esc(d.detail)}</p>` : ""}</li>`).join("")}</ul>`
    : "";
  const questions = it.questions.length ? `<ul class="rows">${it.questions.map((x) => `<li>${copyRow(`<p>${esc(x.text)}</p>`, x.text, "Copy question")}</li>`).join("")}</ul>` : "";
  // States the build proposed are asked about under questions (figpipe record writes them).
  const rows = it.components ?? [];
  const gaps = it.flags.map((f) => f.text);
  const flags = gaps.length ? `<ul class="rows bullets">${gaps.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
  // What the session recorded; without it, what the extraction found in Figma for a visual build.
  const found = !rows.length && (!it.change_kind || VISUAL.has(it.change_kind)) && !["already_done", "fyi", "skipped", "cancelled"].includes(it.outcome) ? it.design?.components_line : null;
  const components = rows.length
    ? `<p>${esc(componentsLine(rows))}</p>`
    : found
      ? `<p>${esc(found)}</p>${it.outcome === "pending" ? "" : '<p class="muted">The session did not record where each state came from.</p>'}`
      : "";
  // Repeated hints (one per instance of a component) collapse to one line with a count. Shown when
  // nobody read the motion (no Figma MCP in the batch) or a still is all there is.
  const motionRows = new Map();
  for (const m of it.motion) {
    const k = `${m.name ?? m.node_id}: ${m.why}`;
    motionRows.set(k, (motionRows.get(k) ?? 0) + 1);
  }
  const motion =
    motionRows.size && (noMcp || !it.captures.length)
      ? `<ul class="rows bullets">${[...motionRows].slice(0, 6).map(([k, n]) => `<li>${esc(k)}${n > 1 ? ` <span class="muted">×${n}</span>` : ""}</li>`).join("")}</ul>`
      : "";
  const reply = it.reply ? copyRow(`<p>${esc(it.reply)}</p>`, it.reply, "Copy reply") : "";
  return `<article class="item" id="item-${it.id}" aria-labelledby="item-${it.id}-title">
<header class="item-head"><h2 id="item-${it.id}-title">${esc(itemTitle(it))}</h2>
<p class="statusline">${outcomeStatus(it.outcome)}${q}</p></header>
${it.verdict ? `<p class="verdict">${esc(it.verdict)}</p>` : ""}${late}
${sourceBlock(it, dir)}${designBlock(it, dir)}${changesBlock(it, dir)}${previewBlock(it, lanes)}${sub("Decided for you", decisions)}${sub("Questions for the designer", questions)}${sub("Components", components)}${sub("Gaps in the design", flags)}${sub("Motion to check", motion)}${sub("Reply", reply)}
</article>`;
}

const TOKENS_DARK = "--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--subtle:#151b23;--link:#4493f8;--good:#3fb950;--warn:#d29922;--bad:#f85149;--del:#3c1618;--ins:#12321c;--scrim:rgb(1 4 9/.8);color-scheme:dark";
export const STYLE = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--subtle:#f6f8fa;--link:#0969da;--good:#1a7f37;--warn:#9a6700;--bad:#cf222e;--del:#ffebe9;--ins:#dafbe1;--scrim:rgb(31 35 40/.6);--measure:640px;--toc:208px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${TOKENS_DARK}}}
:root[data-theme="dark"]{${TOKENS_DARK}}
*{box-sizing:border-box}
html{scroll-padding-top:var(--s5)}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--link);text-underline-offset:2px}
a:focus-visible,button:focus-visible{outline:2px solid var(--link);outline-offset:2px;border-radius:4px}
p{margin:0}
h1,h2,h3,h4{margin:0;line-height:1.3}
h1{font-size:24px;font-weight:600}
h2{font-size:19px;font-weight:600}
h3{font-size:15px;font-weight:600}
h4{font-size:14px;font-weight:600}
code{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--subtle);padding:1px 4px;border-radius:4px;overflow-wrap:break-word;word-break:normal}
ul,ol{margin:0;padding:0;list-style:none}
svg{width:16px;height:16px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
svg .dot{fill:currentColor;stroke-width:1.2}
.muted{color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:var(--s4);top:-48px;padding:var(--s2) var(--s3);background:var(--bg);border:1px solid var(--line);border-radius:6px;z-index:2}
.skip:focus{top:var(--s4)}

.wrap{max-width:1400px;margin:0 auto;padding:var(--s6) var(--s5) var(--s7)}
.page{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--s6)}
.toc,.content{min-width:0}
/* One right edge for text: the header, every item's text blocks and every batch section stop at
   --measure. Only the screenshot grid inside "Changes" runs wider. */
.head,.content>:not(.item),.item>:not(.wide),.wide>:not(.grid){max-width:var(--measure)}

.meta{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s2);margin-top:var(--s1);color:var(--muted);font-size:14px}
.summary{margin-top:var(--s3);font-size:16px}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--s4);margin:var(--s5) 0 0}
.stats>div{min-width:0}
.stats dt{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--muted)}
.stats dd{display:flex;gap:var(--s2);align-items:center;min-height:32px;margin:2px 0 0;font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.next{margin-top:var(--s5)}
.next .pairs+p{margin-top:var(--s2);font-size:14px}

.pairs{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--s3) var(--s4);align-items:start;margin:0}
.pairs dt{color:var(--muted);font-size:14px;line-height:32px}
.pairs dd{margin:0;min-height:32px;display:flex;flex-direction:column;justify-content:center}

.toc-label{font-size:13px;font-weight:600;color:var(--muted);margin-bottom:var(--s2)}
.toc ol+.toc-label{margin-top:var(--s5)}
.toc a{display:flex;gap:var(--s2);align-items:flex-start;padding:5px var(--s2);margin:0 calc(-1 * var(--s2));border-radius:6px;color:var(--fg);text-decoration:none;font-size:14px;line-height:1.4}
.toc a:hover{background:var(--subtle)}
.toc a[aria-current]{background:var(--subtle);font-weight:600}
.toc a svg{margin-top:1px}
.toc .t{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.toc .q{display:inline-flex;gap:3px;align-items:center;font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.toc .v{display:none}

.status{display:inline-flex;gap:6px;align-items:center;font-size:14px;font-weight:500;white-space:nowrap}
.tone-good{color:var(--good)}.tone-warn{color:var(--warn)}.tone-bad{color:var(--bad)}.tone-muted{color:var(--muted)}
.statusline{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s1) var(--s4);margin-top:var(--s2)}

.item-head,.batch-sec{padding-top:var(--s6);margin-top:var(--s6);border-top:1px solid var(--line)}
.content>.item:first-child>.item-head{margin-top:0}
.verdict{margin-top:var(--s3);font-size:16px}
.late{margin-top:var(--s2)}.late .status{white-space:normal;align-items:flex-start}.late svg{margin-top:3px}
.sub{margin-top:var(--s5)}
.sub>h3{margin-bottom:var(--s2)}
.sub>*+*{margin-top:var(--s2)}
.batch-sec>h2{margin-bottom:var(--s3)}

.source{display:grid;grid-template-columns:160px minmax(0,1fr);gap:var(--s4);align-items:start}
.source:not(:has(.thumb)){grid-template-columns:minmax(0,1fr)}
.source-text>*+*{margin-top:var(--s3)}
.thread>li+li{margin-top:var(--s3)}
.thread .by{font-size:14px}.thread time{color:var(--muted);margin-left:var(--s1)}
.thread p{overflow-wrap:anywhere}
.ext{display:inline-flex;gap:6px;align-items:center}

.frame{position:relative;display:block;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--subtle)}
.frame img{display:block;width:100%;height:auto}
.frame.empty{display:grid;place-items:center;color:var(--muted);font-size:13px}
.crop{display:none;position:absolute;left:0;right:0;bottom:0;gap:6px;align-items:center;padding:3px var(--s2);background:var(--bg);border-top:1px solid var(--line);color:var(--muted);font-size:12px}
.cropped .crop{display:flex}
.crop svg{width:12px;height:12px}
.grid{display:grid;gap:var(--s5)}
.shots{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:var(--s2) var(--s4);align-items:start}
.shots>h4{grid-column:1/-1}
.shot{margin:0;min-width:0}
.shot figcaption{font-size:13px;color:var(--muted);margin-bottom:var(--s1)}
.shots.phone .frame{width:min(100%,200px)}
.noshot{color:var(--muted)}

table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:var(--s2) var(--s3) var(--s2) 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
th:last-child,td:last-child{padding-right:0}
thead th{border-top:0;font-size:13px;font-weight:500;color:var(--muted);padding-top:0}
tbody th{font-weight:400}
.diff{table-layout:fixed}.diff th[scope=col]:first-child,.diff tbody th{width:28%}
.diff del{background:var(--del);text-decoration:line-through;padding:1px 2px;border-radius:2px}
.diff ins{background:var(--ins);text-decoration:none;padding:1px 2px;border-radius:2px}
.checks td:first-child,.checks th:first-child{width:110px}
.checks .detail{color:var(--muted);margin-top:2px}

.rows>li+li{margin-top:var(--s3)}
.rows.bullets{padding-left:18px;list-style:disc}.rows.bullets>li+li{margin-top:var(--s2)}
.rows li{overflow-wrap:anywhere}
.chose{color:var(--muted);font-size:14px;margin-top:2px}
.links{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s4)}
.links a{overflow-wrap:anywhere}
.code{color:var(--muted);font-size:14px}

.copyrow{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:var(--s3);align-items:start}
.copyrow code{display:inline-block;margin-top:5px}
.cmd>span{display:inline-block;max-width:100%;overflow-wrap:anywhere}
button.icon,a.icon{display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--muted);cursor:pointer;flex-shrink:0;font:inherit}
button.icon:hover,a.icon:hover{background:var(--subtle);color:var(--fg)}
button.icon.done{color:var(--good);border-color:var(--good)}

dialog.viewer{width:calc(100vw - 32px);max-width:1480px;height:calc(100vh - 32px);max-height:none;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
dialog.viewer[open]{display:grid;grid-template-rows:auto minmax(0,1fr)}
dialog.viewer::backdrop{background:var(--scrim)}
.vbar{display:flex;gap:var(--s3);align-items:center;justify-content:space-between;padding:var(--s2) var(--s2) var(--s2) var(--s4);border-bottom:1px solid var(--line)}
.vbar p{min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vbtns{display:flex;gap:var(--s2)}
.viewer.single [data-v=prev],.viewer.single [data-v=next]{display:none}
.vbody{overflow:auto;background:var(--subtle)}
.vbody img{display:block;max-width:100%;height:auto;margin:0 auto}

.index{max-width:960px}
.warnings{margin-top:var(--s4);max-width:var(--measure)}.warnings li+li{margin-top:var(--s2)}.warnings .status{white-space:normal;align-items:flex-start;font-weight:400}.warnings svg{margin-top:3px}
.index h2{margin:var(--s6) 0 var(--s3)}
.index>.meta{margin:0 0 var(--s3)}
.batches th.num,.batches td.num{width:88px;text-align:right;font-variant-numeric:tabular-nums;padding-right:var(--s4)}
.batches tbody th{font-weight:600}
.batches td.sum{display:none}

@media (min-width:1200px){
.page{grid-template-columns:var(--toc) minmax(0,1fr);column-gap:var(--s7)}
.toc{grid-column:1;grid-row:1/span 2;position:sticky;top:var(--s5);align-self:start;max-height:calc(100vh - 48px);overflow:auto;padding-top:4px}
.head,.content{grid-column:2}
}
@media (max-width:1199px){
.page{gap:var(--s5)}
.toc{max-width:var(--measure)}
.toc .toc-batch{display:none}
.toc li a{border-top:1px solid var(--line)}
.toc a{border-radius:0;margin:0;padding:var(--s2) 0;gap:var(--s3)}
}
@media (min-width:720px) and (max-width:1199px){
.toc a{display:grid;grid-template-columns:16px minmax(0,160px) minmax(0,1fr) auto;grid-template-areas:"i t v q";align-items:center}
.toc a>:first-child{grid-area:i;display:flex}.toc .t{grid-area:t;-webkit-line-clamp:1}.toc .q{grid-area:q}
.toc a svg{margin-top:0}
.toc .v{grid-area:v;display:block;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
}
@media (max-width:719px){
.wrap{padding:var(--s5) var(--s4) var(--s7)}
.stats{grid-template-columns:repeat(3,minmax(0,1fr))}
.source{grid-template-columns:minmax(0,1fr)}.thumb{max-width:240px}
.shots{grid-template-columns:minmax(0,1fr)}
.diff th[scope=col]:first-child,.diff tbody th{width:30%}
.pairs{grid-template-columns:minmax(0,1fr);gap:var(--s1)}.pairs dt{line-height:1.4}.pairs dd+dt{margin-top:var(--s2)}
dialog.viewer{width:100vw;height:100vh;max-width:none;border-radius:0;border:0}
.batches thead{display:none}
.batches tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px var(--s3);padding:var(--s3) 0;border-top:1px solid var(--line)}
.batches th,.batches td{border:0;padding:0}
.batches td.num,.batches td.date{display:none}
.batches td.sum{display:block;grid-column:1/-1;grid-row:2;color:var(--muted)}
}
`;

const SCRIPT = `
(function(){
var live=document.getElementById("live");
document.addEventListener("click",function(e){var b=e.target.closest("button[data-copy]");if(!b)return;var t=b.getAttribute("data-copy");var icon=b.innerHTML;
function ok(){b.classList.add("done");b.innerHTML=${JSON.stringify(ICON.copied)};if(live)live.textContent="Copied";setTimeout(function(){b.classList.remove("done");b.innerHTML=icon;if(live)live.textContent=""},1400)}
function fallback(){var a=document.createElement("textarea");a.value=t;a.setAttribute("readonly","");a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.select();try{if(document.execCommand("copy"))ok()}catch(_){}a.remove()}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(ok,fallback)}else{fallback()}});
[].forEach.call(document.querySelectorAll(".frame[data-fit] img"),function(im){function f(){var fr=im.parentNode;if(im.naturalWidth&&im.naturalHeight/im.naturalWidth*fr.clientWidth>fr.clientHeight+2)fr.classList.add("cropped")}if(im.complete)f();else im.addEventListener("load",f)});
var d=document.getElementById("viewer");
if(d&&d.showModal){var img=d.querySelector("img"),title=document.getElementById("viewer-title"),raw=d.querySelector("[data-v=raw]"),body=d.querySelector(".vbody"),list=[],i=0;
function show(k){i=(k+list.length)%list.length;var a=list[i],top=body.scrollTop;img.onload=function(){body.scrollTop=top};img.src=a.getAttribute("href");img.alt=a.querySelector("img").alt;title.textContent=a.getAttribute("data-label");raw.href=a.getAttribute("href");d.classList.toggle("single",list.length<2)}
document.addEventListener("click",function(e){var a=e.target.closest("a[data-view]");
if(a&&e.button===0&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&!e.altKey){e.preventDefault();var g=a.getAttribute("data-view");list=[].filter.call(document.querySelectorAll("a[data-view]"),function(x){return x.getAttribute("data-view")===g});body.scrollTop=0;show(list.indexOf(a));d.showModal();return}
var v=e.target.closest("[data-v]");if(v&&d.contains(v)){var k=v.getAttribute("data-v");if(k==="prev")show(i-1);else if(k==="next")show(i+1);else if(k==="close")d.close()}else if(e.target===d)d.close()});
d.addEventListener("keydown",function(e){if(list.length<2)return;if(e.key==="ArrowLeft"){e.preventDefault();show(i-1)}else if(e.key==="ArrowRight"){e.preventDefault();show(i+1)}});
d.addEventListener("close",function(){img.removeAttribute("src")})}
var links=[].slice.call(document.querySelectorAll('.toc a[href^="#"]')),secs=links.map(function(a){return document.getElementById(a.getAttribute("href").slice(1))});
function cur(){var k=-1;for(var n=0;n<secs.length;n++)if(secs[n]&&secs[n].getBoundingClientRect().top<=120)k=n;links.forEach(function(a,n){if(n===k)a.setAttribute("aria-current","location");else a.removeAttribute("aria-current")})}
if(links.length){var raf=0;addEventListener("scroll",function(){if(!raf)raf=requestAnimationFrame(function(){raf=0;cur()})},{passive:true});cur()}
})();
`;

export function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${body}<p id="live" class="sr" aria-live="polite"></p><script>${SCRIPT}</script></body></html>
`;
}

const VIEWER = `<dialog class="viewer" id="viewer" aria-labelledby="viewer-title"><div class="vbar"><p id="viewer-title"></p><div class="vbtns">
<button type="button" class="icon" data-v="prev" aria-label="Previous image" title="Previous image">${ICON.prev}</button><button type="button" class="icon" data-v="next" aria-label="Next image" title="Next image">${ICON.next}</button>
<a class="icon" data-v="raw" target="_blank" aria-label="Open the image file" title="Open the image file">${ICON.ext}</a><button type="button" class="icon" data-v="close" autofocus aria-label="Close" title="Close">${ICON.close}</button></div></div>
<div class="vbody"><img alt=""></div></dialog>`;

export function renderBatch(data, dir, projectName) {
  const { batch, items } = data;
  const count = (k) => items.filter((i) => i.outcome === k).length;
  const questions = Math.max(items.reduce((a, i) => a + i.questions.length, 0), count("question"));
  const usd = batch.usd != null ? `$${Number(batch.usd).toFixed(2)}` : "None";
  const allQuestions = items
    .flatMap((it) => it.questions.map((q) => `${[...new Set([it.area_name ?? itemTitle(it), q.section].filter(Boolean))].join(", ")}: ${q.text}`))
    .join("\n\n");
  const stats = [
    ["Built", count("applied"), "check", "good"],
    ["Needs you", count("needs_you"), "alert", "warn"],
    ["Questions", questions, "question", "warn"],
    ["Failed", count("failed"), "cross", "bad"],
  ]
    .map(([l, n, icon, tone]) => `<div><dt><span class="tone-${n ? tone : "muted"}">${ICON[icon]}</span>${l}</dt><dd>${n}${l === "Questions" && allQuestions ? copyBtn(allQuestions, "Copy all questions") : ""}</dd></div>`)
    .join("");

  const ctx = data.context.map((c) =>
    c.kind === "identity"
      ? `"${c.name}" (${c.stale}) was edited by ${c.by ?? "someone"} after the watched file. The designer may be working in the wrong copy.`
      : `${c.by ?? "The designer"} saved the version "${c.label}"${c.description ? `: ${c.description}` : ""}.`,
  );
  const noMcp = !!batch.figma_mcp && batch.figma_mcp !== "connected";
  // A not-done line about one item explains that item's missing screenshots.
  for (const it of items) it.noShotReason = data.notDone.find((n) => n.item_id === it.id)?.text ?? null;
  const notDone = [
    ...data.notDone.map((n) => `<li>${esc(n.text)}${n.detail ? ` <code>${esc(n.detail)}</code>` : ""}</li>`),
    ...data.denials.map((d) => `<li>Blocked: ${esc(d.reason)} <code>${esc(d.tool)} ${esc(j(d.input, {}).command ?? j(d.input, {}).file_path ?? "")}</code></li>`),
    ...(batch.error && !isWaiting(batch) ? [`<li>${esc(batch.error)}</li>`] : []),
    ...(isWaiting(batch) && batch.wait_note ? [`<li>Claude said: ${esc(batch.wait_note)}</li>`] : []),
  ];
  const checks = data.checks.length
    ? `<table class="checks"><thead><tr><th scope="col">Result</th><th scope="col">Check</th></tr></thead><tbody>${data.checks
        .map((c) => {
          const [l, tone, icon] = CHECK[c.status] ?? [c.status, "muted", "ring"];
          return `<tr><td>${status(l, tone, icon)}</td><td>${esc(c.text)}${c.detail ? `<p class="detail">${esc(c.detail)}</p>` : ""}</td></tr>`;
        })
        .join("")}</tbody></table>`
    : "";
  const usage = [
    `${batch.mcp_calls ?? 0} in this batch`,
    `${data.budget.mcp_calls} today`,
  ].join(", ");
  const session = pairs(
    [
      batch.session_id && ["Follow up", cmdRow(`claude --resume ${batch.session_id}`, "Copy the command that resumes the session")],
      batch.account && ["Claude login", esc(batch.account)],
      ["Figma MCP calls", esc(usage)],
      data.budget.rest_429s && ["REST rate limits", `${data.budget.rest_429s} today`],
    ].filter(Boolean),
  );
  const sections = [
    ctx.length && ["file", "In the Figma file", `<ul class="rows bullets">${ctx.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`],
    notDone.length && ["not-done", "Not done", `<ul class="rows bullets">${notDone.join("")}</ul>`],
    checks && ["checks", "Checks", checks],
    ["session", "Session", session],
  ].filter(Boolean);

  // The page's one action sits in the header, under the counts, every time the batch is open.
  // A batch Claude could not run yet has nothing to review: it says what it waits for and how to
  // start it by hand.
  const open = !["reviewed", "rejected"].includes(batch.status);
  const next = isWaiting(batch)
    ? `<div class="next"><p class="summary">${esc(batch.error ?? "Waiting for Claude")}. Nothing was built and nothing was spent; the items are kept.</p>${pairs([["Start it now", cmdRow(`figpipe run --batch ${batch.id}`, "Copy the command that starts this batch now")]])}</div>`
    : open
    ? `<div class="next">${pairs([["Mark reviewed", cmdRow(`figpipe ack ${batch.id}`, "Copy the command that marks this batch reviewed")]])}<p class="muted">New Figma work waits until you mark this reviewed.</p></div>`
    : "";
  // On a one-item batch the item's verdict is the summary; saying it twice adds nothing.
  const summary =
    (batch.summary && !(items.length === 1 && items[0].verdict) ? `<p class="summary">${esc(batch.summary)}</p>` : "") + (batch.review_note ? `<p class="summary">${esc(batch.review_note)}</p>` : "");

  const tocItem = (it) => {
    const o = outcomeOf(it.outcome);
    return `<li><a href="#item-${it.id}"><span class="tone-${o.tone}">${ICON[OUTCOME_ICON[it.outcome]] ?? ICON.ring}<span class="sr">${esc(o.label)}: </span></span><span class="t">${esc(itemTitle(it))}</span>${it.verdict ? `<span class="v" aria-hidden="true">${esc(it.verdict)}</span>` : ""}${it.outcome === "question" ? "" : questionMark(it.questions.length)}</a></li>`;
  };
  const toc = `<nav class="toc" aria-label="On this page"><p class="toc-label">Items</p>${
    items.length ? `<ol>${items.map(tocItem).join("")}</ol>` : `<p class="muted">No items.</p>`
  }<p class="toc-label toc-batch">Batch</p><ol class="toc-batch">${sections.map(([id, t]) => `<li><a href="#${id}"><span class="t">${esc(t)}</span></a></li>`).join("")}</ol></nav>`;

  const meta = [fmtTime(batch.created_at) && esc(fmtTime(batch.created_at)), esc(plural(items.length, "item")), batchStatusChip(batch)].filter(Boolean);
  const body = `<a class="skip" href="#main">Skip to items</a><div class="wrap"><div class="page">
<header class="head">
<h1>${esc(projectName ?? batch.project)}</h1>
<p class="meta">${meta.map((m) => `<span>${m}</span>`).join('<span aria-hidden="true">·</span>')}</p>
${summary}
<dl class="stats">${stats}<div><dt>Cost</dt><dd>${esc(usd)}</dd></div></dl>
${next}
</header>
${toc}
<main class="content" id="main" tabindex="-1">
${items.map((it) => itemSection(it, dir, data.lanes, { noMcp })).join("\n") || '<p class="muted">No items.</p>'}
${sections.map(([id, t, b]) => `<section class="batch-sec" id="${id}"><h2>${esc(t)}</h2>${b}</section>`).join("\n")}
</main></div></div>${VIEWER}`;
  return page(`${projectName ?? batch.project}: ${fmtTime(batch.created_at)}`, body);
}

export function writeReport(db, batchId, { projectName } = {}) {
  const data = reportData(db, batchId);
  const dir = data.batch.dir ?? join(paths().batches, data.batch.project, batchId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "report.html");
  writeFileSync(file, renderBatch(data, dir, projectName));
  if (!data.batch.dir) db.run("UPDATE batches SET dir = ? WHERE id = ?", dir, batchId);
  writeIndex(db);
  return file;
}

export function writeIndex(db) {
  const rows = db.all("SELECT * FROM batches ORDER BY created_at DESC LIMIT 200");
  const home = paths().home;
  const isOpen = (b) => stillShown(db, b);
  const open = rows.filter(isOpen);
  const done = rows.filter((b) => !isOpen(b));
  const counts = (b) => {
    const by = db.all("SELECT outcome, COUNT(*) AS n FROM items WHERE batch_id = ? GROUP BY outcome", b.id);
    const c = (k) => by.find((x) => x.outcome === k)?.n ?? 0;
    return [c("applied"), c("needs_you"), questionCount(db, b.id, c("question")), c("failed")];
  };
  // A row says what the batch is (project, linked) before when it ran. On phones the counts fold
  // into one line under the project.
  const row = (b) => {
    const file = b.dir ? join(b.dir, "report.html") : null;
    const href = file && existsSync(file) ? esc(relative(home, file)) : null;
    const when = esc(fmtTime(b.created_at));
    const line = isWaiting(b) ? b.error ?? "Waiting for Claude" : [batchLine(db, b.id) || "No items", b.review_note].filter(Boolean).join(" · ");
    return `<tr><th scope="row">${href ? `<a href="${href}">${esc(b.project)}</a>` : esc(b.project)}</th><td class="date">${when}</td>${counts(b)
      .map((n) => `<td class="num">${n || '<span class="muted">0</span>'}</td>`)
      .join("")}<td class="sum">${[when, esc(line)].filter(Boolean).join(" · ")}</td><td>${batchStatusChip(b)}</td></tr>`;
  };
  const table = (list) =>
    `<table class="batches"><thead><tr><th scope="col">Project</th><th scope="col">Date</th><th scope="col" class="num">Built</th><th scope="col" class="num">Needs you</th><th scope="col" class="num">Questions</th><th scope="col" class="num">Failed</th><th scope="col">Status</th></tr></thead><tbody>${list.map(row).join("")}</tbody></table>`;
  const waiting = open.filter((b) => !["reviewed", "rejected", "ready", "extracting", "running"].includes(b.status));
  const warnings = db
    .all("SELECT project, warnings, blocked, blocked_until FROM project_state")
    .flatMap((p) => [
      ...(p.blocked ? [`${p.project}: ${p.blocked}`] : []),
      ...(p.blocked_until && Date.parse(p.blocked_until) > Date.now() ? [`${p.project}: Figma rate limit, no checks until ${fmtTime(p.blocked_until)}`] : []),
      ...JSON.parse(p.warnings || "[]").map((w) => `${p.project}: ${w}`),
    ]);
  for (const b of open.filter(isWaiting)) warnings.push(`${b.project}: ${b.error ?? "waiting for Claude"}. Batch ${b.id} keeps its items.`);
  const scoped = db
    .all("SELECT DISTINCT project FROM events WHERE status IN ('out_of_scope', 'needs_owner')")
    .flatMap((r) => {
      const sum = scopeSummary(db, r.project);
      return [...(scopeLine(sum) ? [{ project: r.project, line: scopeLine(sum) }] : []), ...askLines(sum).map((line) => ({ project: r.project, line, ask: true }))];
    });
  const body = `<div class="wrap"><main class="index">
<h1>Figma batches</h1>
${scoped.map((x) => `<p class="meta">${x.ask ? "" : `${esc(x.project)}: `}${esc(x.line)}</p>`).join("")}
${warnings.length ? `<ul class="warnings" aria-label="Warnings from the last check">${warnings.map((w) => `<li>${status(w, "warn", "alert")}</li>`).join("")}</ul>` : ""}
${open.length ? `<h2>To review</h2>${waiting.length ? `<p class="meta">New Figma work waits until you mark these reviewed: <code>figpipe ack &lt;batch&gt;</code></p>` : ""}${table(open)}` : '<p class="meta">Nothing to review.</p>'}
${done.length ? `<h2>Reviewed</h2>${table(done)}` : ""}
</main></div>`;
  mkdirSync(home, { recursive: true });
  writeFileSync(paths().index, page("Figma batches", body));
  return paths().index;
}
