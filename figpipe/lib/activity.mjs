// When designers actually work in a watched file, read from Figma's own timestamps: version saves
// (edits), comments and, when a state.db is given, ready-for-dev marks as figpipe saw them. Setup
// uses it to propose a schedule, doctor uses it to notice that the pattern has drifted.
// Read-only. Pure functions over plain events, so tests need no Figma.
import { zonedParts, zonedToUtc, WEEKDAYS, fromMinutes, toMinutes, scheduleOf, nextSlot, machineZone } from "./schedule.mjs";

const DAY = 86400000;

// Candidate zones for guessing where a designer sits: one per common UTC offset, and the usual
// daylight-saving rule for it.
export const CANDIDATE_ZONES = [
  "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Halifax",
  "America/Sao_Paulo", "Atlantic/Azores", "Europe/London", "Europe/Berlin", "Europe/Athens", "Europe/Moscow", "Asia/Dubai", "Asia/Karachi",
  "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Australia/Adelaide", "Australia/Sydney", "Pacific/Auckland",
];

// Versions and comments of one file, last `days` days, newest first from Figma. Figma pages the
// version list; follow it until it is older than the window.
export async function fetchActivity(client, key, { days = 30, now = Date.now(), maxPages = 12 } = {}) {
  const cutoff = now - days * DAY;
  const versions = [];
  let query = {};
  for (let page = 0; page < maxPages; page++) {
    const r = await client.get(`/v1/files/${encodeURIComponent(key)}/versions`, query);
    const got = r.versions ?? [];
    versions.push(...got);
    const oldest = got.length ? Date.parse(got[got.length - 1].created_at) : 0;
    const next = r.pagination?.next_page;
    if (!next || !got.length || oldest < cutoff) break;
    query = Object.fromEntries(new URL(next).searchParams);
  }
  const c = await client.comments(key);
  return { versions: versions.filter((v) => Date.parse(v.created_at) >= cutoff), comments: (c.comments ?? []).filter((x) => Date.parse(x.created_at) >= cutoff) };
}

// Plain events: { at (ms), who, id, kind: "edit" | "comment" | "ready" }. Your own saves and
// comments are left out: the question is when the designers work.
export function toEvents({ versions = [], comments = [], ready = [], me = {}, days = 30, now = Date.now() }) {
  const cutoff = now - days * DAY;
  const mine = (u) => !!u && ((me.id && String(u.id) === String(me.id)) || (me.handle && u.handle === me.handle));
  const out = [];
  let own = 0;
  const add = (kind, at, user) => {
    if (!Number.isFinite(at) || at < cutoff || at > now) return;
    if (mine(user)) return void own++;
    out.push({ at, kind, who: user?.handle ?? "unknown", id: user?.id ?? null });
  };
  for (const v of versions) add("edit", Date.parse(v.created_at), v.user);
  for (const c of comments) add("comment", Date.parse(c.created_at), c.user);
  for (const r of ready) add("ready", Date.parse(r.at), null);
  return { events: out.sort((a, b) => a.at - b.at), own };
}

const dateKey = (p) => `${p.y}-${p.mo}-${p.d}`;

// How many distinct days each hour of the day (0-23) and each weekday had activity on, in `tz`.
// Counting days rather than events keeps one burst of forty comments from looking like a habit.
export function histogram(events, tz) {
  const hours = Array(24).fill(0);
  const dows = Array(7).fill(0);
  const seenHour = new Set();
  const seenDay = new Set();
  for (const e of events) {
    const p = zonedParts(e.at, tz);
    const hk = `${dateKey(p)}|${p.h}`;
    if (!seenHour.has(hk)) {
      seenHour.add(hk);
      hours[p.h]++;
    }
    const dk = dateKey(p);
    if (!seenDay.has(dk)) {
      seenDay.add(dk);
      dows[p.dow]++;
    }
  }
  return { hours, dows, activeDays: seenDay.size, events: events.length };
}

// Working blocks: runs of hours where activity shows up on at least `share` (35%) of the busiest hour's
// days, joined across a one-hour dip (lunch). [{ start, end }] in minutes; end is the hour after the
// last active one, so a check at `end` lands just after the last edits.
export function blocks(hours, { share = 0.35, gap = 1 } = {}) {
  const peak = Math.max(0, ...hours);
  if (!peak) return [];
  const floor = Math.max(1, Math.ceil(peak * share));
  const active = hours.map((n) => n >= floor);
  const runs = [];
  for (let h = 0; h < 24; h++) {
    if (!active[h]) continue;
    const last = runs[runs.length - 1];
    if (last && h - last.end <= gap) last.end = h + 1;
    else runs.push({ start: h, end: h + 1 });
  }
  return runs.map((r) => ({ start: r.start * 60, end: Math.min(r.end, 23) * 60 + (r.end > 23 ? 59 : 0) }));
}

// Weekdays with activity on at least half as many days as the busiest weekday (a stray Saturday is not a work day).
export function workDays(dows) {
  const peak = Math.max(0, ...dows);
  if (!peak) return [...WEEKDAYS];
  return WEEKDAYS.filter((_, i) => dows[i] >= Math.max(1, peak * 0.5));
}

// Which zone makes the activity look like working days: share of active hours inside 08:00-19:59
// local minus twice the share in the small hours (23:00-06:59). Activity alone fixes a zone only to
// within an hour or two, so zones within 0.05 of the best are listed as "also fits" (ties go to the
// zone whose median active hour is nearest 13:30) and the guess is only "confident" when none do.
// Setup confirms the zone with the user either way.
export function inferZone(events, candidates = CANDIDATE_ZONES) {
  if (events.length < 8) return null;
  const scored = candidates.map((tz) => {
    const { hours } = histogram(events, tz);
    const total = hours.reduce((a, b) => a + b, 0) || 1;
    const day = hours.slice(8, 20).reduce((a, b) => a + b, 0);
    const night = [...hours.slice(0, 7), hours[23]].reduce((a, b) => a + b, 0);
    let seen = 0;
    let median = 12;
    for (let h = 0; h < 24; h++) {
      seen += hours[h];
      if (seen >= total / 2) {
        median = h + 0.5;
        break;
      }
    }
    return { tz, score: (day - 2 * night) / total, off: Math.abs(median - 13.5) };
  });
  scored.sort((a, b) => b.score - a.score || a.off - b.off);
  const best = scored[0];
  const close = scored.slice(1).filter((s) => best.score - s.score <= 0.05).map((s) => s.tz);
  return { tz: best.tz, score: Math.round(best.score * 100) / 100, also_fits: close, confident: best.score >= 0.6 && close.length === 0 };
}

// A timeline in `from` zone as the same instants in `to` zone: [{ start, end }] minutes of the
// same ordinary day, shifted by the zones' offset now. Returns text such as "23:00-10:00".
export function shiftBlock(b, from, to, ref = Date.now()) {
  const p = zonedParts(ref, from);
  const conv = (m) => zonedParts(zonedToUtc({ y: p.y, mo: p.mo, d: p.d, h: Math.floor(m / 60), mi: m % 60 }, from), to);
  const a = conv(b.start);
  const z = conv(b.end);
  return { start: a.h * 60 + a.mi, end: z.h * 60 + z.mi, day_shift: (Date.UTC(z.y, z.mo - 1, z.d) - Date.UTC(p.y, p.mo - 1, p.d)) / DAY };
}
const clock24 = (m) => (m >= 1439 ? "24:00" : fromMinutes(m));
export const fmtBlock = (b) => `${clock24(b.start)}-${clock24(b.end)}`;

// A proposed [schedule]: windows over the working blocks, in the designers' zone, every `every`
// minutes, on their working days, plus one check shortly before `userStart` in `userTz` so that
// what happened overnight is waiting when you sit down.
export function suggest({ events, tz, userTz = machineZone(), userStart = "08:00", every = 60, ref = Date.now() }) {
  const h = histogram(events, tz);
  const bl = blocks(h.hours);
  const days = workDays(h.dows);
  const windows = bl.map((b) => ({ start: fromMinutes(b.start), end: fromMinutes(b.end), every }));
  const notes = [];
  // A check in the hour before the user's day starts.
  const us = toMinutes(userStart);
  const before = shiftBlock({ start: Math.max(0, us - 60), end: Math.max(0, us - 60) }, userTz, tz, ref);
  const covered = windows.some((w) => {
    for (let m = toMinutes(w.start); m <= toMinutes(w.end); m += w.every) if (m >= before.start && m < before.start + 60) return true;
    return false;
  });
  if (!covered && windows.length) {
    if (before.day_shift === 0) windows.push({ start: fromMinutes(before.start), end: fromMinutes(before.start), every });
    else notes.push(`add a check before ${userStart} ${userTz} by hand; it falls on another day in ${tz}`);
  }
  windows.sort((a, b) => a.start.localeCompare(b.start));
  if (h.activeDays < 10) notes.push(`only ${h.activeDays} active days in the window; treat this as rough`);
  return { timezone: tz, days, windows, notes, active_days: h.activeDays };
}

// TOML for a suggestion, ready to paste.
export function suggestionToml(s) {
  const q = (x) => JSON.stringify(x);
  return `[schedule]\ntimezone = ${q(s.timezone)}\ndays = [${s.days.map(q).join(", ")}]\nwindows = [${s.windows.map((w) => `{ start = ${q(w.start)}, end = ${q(w.end)}, every = ${w.every} }`).join(", ")}]`;
}

// How long each event waited for the next check under a schedule: { waited_over, median_h, share }.
export function lateness(events, config, { hours = 4 } = {}) {
  const sc = scheduleOf(config);
  if (sc.mode === "interval" || !events.length) return { share: 0, median_h: 0, events: events.length };
  const waits = events.map((e) => {
    const t = nextSlot(sc, e.at);
    return t == null ? Infinity : t - e.at;
  });
  const late = waits.filter((w) => w > hours * 3600000).length;
  const sorted = [...waits].sort((a, b) => a - b);
  return { share: late / events.length, median_h: Math.round((sorted[Math.floor(sorted.length / 2)] / 3600000) * 10) / 10, events: events.length };
}

// Everything the activity command prints: per designer and combined.
export function analyse({ events, own = 0, userTz = machineZone(), tz = null, userStart = "08:00", every = 60, ref = Date.now() }) {
  const guess = inferZone(events);
  const zone = tz ?? guess?.tz ?? userTz;
  const people = new Map();
  for (const e of events) {
    if (!people.has(e.who)) people.set(e.who, []);
    people.get(e.who).push(e);
  }
  const shape = (list, z) => {
    const h = histogram(list, z);
    const bl = blocks(h.hours);
    return {
      timezone: z,
      active_days: h.activeDays,
      days: workDays(h.dows),
      hours: h.hours,
      weekdays: Object.fromEntries(WEEKDAYS.map((d, i) => [d, h.dows[i]])),
      blocks: bl.map((b) => ({ own: fmtBlock(b), yours: fmtBlock(shiftBlock(b, z, userTz, ref)) })),
    };
  };
  const per = [...people.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([who, list]) => {
      const g = inferZone(list);
      const z = tz ?? g?.tz ?? zone;
      return { who, events: list.length, kinds: kindCounts(list), guess: g, ...shape(list, z) };
    });
  return {
    events: events.length,
    kinds: kindCounts(events),
    left_out_yours: own,
    zone_guess: guess,
    timezone: zone,
    user_timezone: userTz,
    combined: shape(events, zone),
    people: per,
    suggestion: events.length >= 8 ? suggest({ events, tz: zone, userTz, userStart, every, ref }) : null,
  };
}

const kindCounts = (list) => list.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {});
