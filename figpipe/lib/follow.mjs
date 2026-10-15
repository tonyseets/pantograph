// Follow mode: check when the designers work. The working blocks come from their recent activity
// (saved versions, comments, ready-for-dev changes of the watched files, last 30 days, you left out),
// are cached in state.db and recomputed every `schedule.refresh_days`. Only Figma's version and
// comment lists are read, one derivation at most per day. lib/schedule.mjs turns the cached blocks
// into instants; this module derives, caches and describes them.
import { existsSync, readFileSync } from "node:fs";
import { WEEKDAYS, scheduleOf, machineZone, zonedParts, addDays, preDayFor, FOLLOW_FALLBACK, toMinutes } from "./schedule.mjs";
import { fetchActivity, toEvents, histogram, blocks, workDays, inferZone, shiftBlock, fmtBlock } from "./activity.mjs";

export const ACTIVITY_DAYS = 30;
export const MIN_EVENTS = 8; // fewer events than this: too little to derive blocks
export const MIN_ACTIVE_DAYS = 5;
export const AMPHETAMINE = "https://apps.apple.com/us/app/amphetamine/id937984704";
const HOUR = 3600000;
const DAY = 86400000;

// Blocks from plain events ({ at, kind, who }). `pinnedTz` is the designers' zone when the config
// names it; otherwise it is guessed from their hours, and with too little to guess from it is yours.
// Too few events or days: the fallback blocks in that zone, and a reason status can print.
export function deriveBlocks({ events, pinnedTz = "", userTz = machineZone(), days = ACTIVITY_DAYS }) {
  const guess = events.length >= MIN_EVENTS ? inferZone(events) : null;
  const timezone = pinnedTz || guess?.tz || userTz;
  const h = histogram(events, timezone);
  const bl = blocks(h.hours);
  const base = { timezone, events: events.length, active_days: h.activeDays };
  if (events.length < MIN_EVENTS || h.activeDays < MIN_ACTIVE_DAYS || !bl.length) {
    return {
      ...base,
      fallback: true,
      days: [...WEEKDAYS],
      blocks: [{ start: toMinutes(FOLLOW_FALLBACK.start), end: toMinutes(FOLLOW_FALLBACK.end) }],
      reason: `only ${events.length} edits, comments and ready marks on ${h.activeDays} days in the last ${days} days`,
    };
  }
  return { ...base, fallback: false, days: workDays(h.dows), blocks: bl, reason: "" };
}

// Everything the designers did in the watched files (and their stale copies) as plain events.
export async function gatherEvents({ db, config, client, now = Date.now(), days = ACTIVITY_DAYS }) {
  const keys = config.figma.files.flatMap((f) => [f.key, ...f.stale_copies]);
  const versions = [];
  const comments = [];
  for (const k of keys) {
    const a = await fetchActivity(client, k, { days, now });
    versions.push(...a.versions);
    comments.push(...a.comments);
  }
  const ready = db.all("SELECT COALESCE(source_at, detected_at) AS at FROM events WHERE project = ? AND kind IN ('ready', 'changed')", config.project.slug);
  let me = { id: config.figma.me.user_id, handle: config.figma.me.handle };
  if (!me.id && !me.handle) {
    const m = await client.me();
    me = { id: m.id, handle: m.handle };
  }
  return toEvents({ versions, comments, ready, me, days, now });
}

// ---- the cache -----------------------------------------------------------------------------------

const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export function loadDerived(db, slug) {
  const r = db.get("SELECT * FROM follow_blocks WHERE project = ?", slug);
  if (!r) return null;
  return {
    derived_at: r.derived_at,
    attempted_at: r.attempted_at,
    ok: r.ok !== 0,
    error: r.error,
    timezone: r.timezone,
    days: json(r.days, []),
    blocks: json(r.blocks, []),
    fallback: !!r.fallback,
    reason: r.derived_at ? r.reason : r.error ? `could not read the designers' activity (${r.error})` : "no activity read yet",
    events: r.events,
    active_days: r.active_days,
  };
}

// The project's schedule with its cached blocks.
export const scheduleFor = (db, config) => scheduleOf(config, config.schedule.mode === "follow" ? loadDerived(db, config.project.slug) : null);

// Whether blocks should be derived now. At most one successful derivation a day, a failed attempt
// again after an hour, and otherwise every refresh_days (every day while there was too little activity).
export function needsRefresh({ row, config, now = Date.now() }) {
  if (config.schedule.mode !== "follow") return false;
  if (row?.attempted_at) {
    const since = now - Date.parse(row.attempted_at);
    if (since < (row.ok ? DAY : HOUR)) return false;
  }
  if (!row?.derived_at) return true;
  const pinned = config.schedule.timezone;
  if (pinned && row.timezone !== pinned) return true;
  return now - Date.parse(row.derived_at) >= (row.fallback ? DAY : config.schedule.refresh_days * DAY);
}

// Derive and store. Never throws: a failure is stored (the cached blocks stay in use) and returned.
export async function refreshBlocks({ db, config, client, now = Date.now() }) {
  const slug = config.project.slug;
  const at = new Date(now).toISOString();
  try {
    const { events } = await gatherEvents({ db, config, client, now });
    const d = deriveBlocks({ events, pinnedTz: config.schedule.timezone, userTz: config.schedule.my_timezone || machineZone() });
    db.run(
      `INSERT INTO follow_blocks (project, derived_at, attempted_at, ok, error, timezone, days, blocks, fallback, reason, events, active_days)
       VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project) DO UPDATE SET derived_at = excluded.derived_at, attempted_at = excluded.attempted_at, ok = 1, error = NULL, timezone = excluded.timezone, days = excluded.days, blocks = excluded.blocks, fallback = excluded.fallback, reason = excluded.reason, events = excluded.events, active_days = excluded.active_days`,
      slug, at, at, d.timezone, JSON.stringify(d.days), JSON.stringify(d.blocks), d.fallback ? 1 : 0, d.reason, d.events, d.active_days,
    );
    return { ok: true, ...d };
  } catch (e) {
    db.run("INSERT INTO follow_blocks (project, attempted_at, ok, error) VALUES (?, ?, 0, ?) ON CONFLICT (project) DO UPDATE SET attempted_at = excluded.attempted_at, ok = 0, error = excluded.error", slug, at, e.message);
    return { ok: false, error: e.message };
  }
}

// ---- words -----------------------------------------------------------------------------------------

const clock = (ms, tz) => {
  const p = zonedParts(ms, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
};

// The blocks in the designers' time and the user's, when they were derived, and the pre-day check.
export function followView(sc, now = Date.now()) {
  const f = sc.follow;
  const first = zonedParts(now, f.my_tz);
  let pre = null;
  for (let k = 0; k < 8 && !pre; k++) {
    const pd = preDayFor(sc, addDays({ y: first.y, mo: first.mo, d: first.d }, k));
    if (pd && pd.start > now) pre = pd;
  }
  const same = sc.timezone === f.my_tz;
  const list = f.blocks.map((b) => ({ designer: fmtBlock(b), yours: fmtBlock(shiftBlock(b, sc.timezone, f.my_tz, now)) }));
  return {
    fallback: f.fallback,
    reason: f.reason,
    derived_at: f.derived_at,
    events: f.events,
    active_days: f.active_days,
    timezone: sc.timezone,
    my_timezone: f.my_tz,
    every: f.every,
    days: sc.days,
    blocks: list,
    pre_day: pre ? { my_day_starts: f.my_start, time: clock(pre.at, f.my_tz), extra_check: pre.added } : null,
    text: list.map((b) => (same ? `${b.designer} ${sc.timezone}` : `${b.designer} ${sc.timezone} = ${b.yours} ${f.my_tz}`)).join("; "),
  };
}

// `sudo pmset repeat wakeorpoweron <days> <time>` for the Mac's zone: one minute after the check that
// precedes your day, so the check is already due when the Mac wakes. Printed for the user, never run.
const PMSET_DAYS = { mon: "M", tue: "T", wed: "W", thu: "R", fri: "F", sat: "S", sun: "U" };
export function wakeCommand(sc, now = Date.now()) {
  const f = sc.follow;
  if (!f) return null;
  const mac = machineZone();
  const first = zonedParts(now, f.my_tz);
  const days = new Set();
  let when = null;
  for (let k = 0; k < 7; k++) {
    const pd = preDayFor(sc, addDays({ y: first.y, mo: first.mo, d: first.d }, k));
    if (!pd) continue;
    const t = pd.at + 60000;
    days.add(WEEKDAYS[zonedParts(t, mac).dow]);
    when ??= t;
  }
  if (!when) return null;
  const letters = WEEKDAYS.filter((d) => days.has(d)).map((d) => PMSET_DAYS[d]).join("");
  const time = `${clock(when, mac)}:00`;
  return { days: letters, time, command: `sudo pmset repeat wakeorpoweron ${letters} ${time}` };
}

// Times figpipe caught up on a check missed while the Mac slept, from the log.
export function catchUps(logFile, slug, { now = Date.now(), days = 14 } = {}) {
  if (!existsSync(logFile)) return [];
  const re = new RegExp(`^(\\S+) ${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: catching up on a check missed while the Mac was asleep`);
  const out = [];
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    const m = line.match(re);
    const t = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(t) && t >= now - days * DAY && t <= now) out.push(t);
  }
  return out;
}
