// When a project's Figma check is due. A project checks on a schedule written in the designers'
// time zone: fixed times, windows ("every 60 min between 08:00 and 19:00"), or, when the config has
// no times or windows, every `batching.poll_minutes` (the original behaviour).
//
// The background job wakes figpipe every few minutes and `tick` asks this module whether each
// project is due. Nothing here converts a schedule into the Mac's local time ahead of time, so
// daylight saving changes (in either zone), a Mac that changes zone, and several projects with
// different zones all give the right answer without regenerating anything.
//
// Due means: the latest scheduled moment that has already passed is later than the last check.
// A check missed while the Mac slept is therefore run once on wake, however many were missed.
//
// Follow mode ("follow the designers") takes its working blocks from the designers' recent activity
// (lib/follow.mjs derives and caches them); this module only turns blocks plus a few settings into
// instants, so it stays pure.
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const WAKE_MINUTES = 15; // how often the background job wakes figpipe
export const RETRY_MINUTES = 15; // a failed check is retried at the next wake after this long
export const PRE_DAY_LEAD = 75; // follow mode: the check before your day starts, this many minutes ahead
export const PRE_DAY_BAND = [60, 90]; // a block check this far ahead of your day already is that check
export const FOLLOW_FALLBACK = { start: "08:00", end: "20:00" }; // blocks used while there is too little activity to derive any
const MIN = 60000;

export const machineZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function validZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- time zone arithmetic ------------------------------------------------------------------

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    dtfCache.set(tz, f);
  }
  return f;
}

// The wall clock in `tz` at an instant. dow: 0 = Monday ... 6 = Sunday.
export function zonedParts(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  const dow = (new Date(Date.UTC(o.year, o.month - 1, o.day)).getUTCDay() + 6) % 7;
  return { y: o.year, mo: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second, dow };
}

// Offset of `tz` from UTC at an instant, in ms.
export function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time happens in `tz`. A time that falls in a spring-forward gap
// (02:30 when the clocks jump 02:00 to 03:00) happens at the same instant as the time an hour
// later; a time that happens twice in a fall-back hour means its first occurrence.
export function zonedToUtc({ y, mo, d, h, mi }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const before = offsetMs(guess - 86400000, tz);
  const after = offsetMs(guess + 86400000, tz);
  const valid = [...new Set([before, after])].map((off) => guess - off).filter((t) => offsetMs(t, tz) === guess - t);
  return valid.length ? Math.min(...valid) : guess - before;
}

export const addDays = ({ y, mo, d }, n) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const dowOf = ({ y, mo, d }) => (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
export const toMinutes = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ---- the schedule ----------------------------------------------------------------------------

// Normalised view of a project's schedule: { mode, timezone, days, times, windows, poll_minutes }.
// mode: "times" | "windows" | "interval" | "follow". In follow mode `derived` is the cached
// derivation ({ timezone, days, blocks: [{ start, end }] in minutes, fallback, derived_at, reason },
// or null before the first one); windows are the blocks at `every` minutes and `follow` carries the
// rest: { every, my_tz, my_start, refresh_days, fallback, derived_at, reason, blocks }.
export function scheduleOf(config, derived = null) {
  const s = config.schedule ?? {};
  const times = s.times ?? [];
  const windows = s.windows ?? [];
  const base = {
    timezone: s.timezone || machineZone(),
    days: s.days?.length ? s.days : [...WEEKDAYS],
    poll_minutes: config.batching?.poll_minutes ?? 10,
  };
  if (s.mode === "follow") return followScheduleOf(s, base, derived);
  return {
    mode: times.length ? "times" : windows.length ? "windows" : "interval",
    ...base,
    times: [...times].sort(),
    windows,
  };
}

function followScheduleOf(s, base, derived) {
  const every = s.every ?? 60;
  const pinned = s.timezone || "";
  // A derivation made for another zone than the one now pinned is stale until the next refresh.
  const usable = derived?.blocks?.length && !derived.fallback && (!pinned || derived.timezone === pinned) ? derived : null;
  const fallback = !usable;
  const timezone = pinned || derived?.timezone || machineZone();
  const blocks = usable ? usable.blocks : [{ start: toMinutes(FOLLOW_FALLBACK.start), end: toMinutes(FOLLOW_FALLBACK.end) }];
  // Derived work days narrow to the configured ones; a configured list wider than what the designers do changes nothing.
  const derivedDays = usable?.days?.length ? usable.days : base.days;
  const narrowed = derivedDays.filter((d) => base.days.includes(d));
  return {
    mode: "follow",
    timezone,
    days: narrowed.length ? narrowed : base.days,
    times: [],
    windows: blocks.map((b) => ({ start: fromMinutes(b.start), end: fromMinutes(b.end), every })),
    poll_minutes: base.poll_minutes,
    follow: {
      every,
      lead: PRE_DAY_LEAD,
      my_tz: s.my_timezone || machineZone(),
      my_start: s.my_day_starts || "08:00",
      refresh_days: s.refresh_days ?? 7,
      fallback,
      derived_at: derived?.derived_at ?? null,
      reason: usable ? "" : derived?.reason || "no activity read yet",
      events: derived?.events ?? 0,
      active_days: derived?.active_days ?? 0,
      blocks,
    },
  };
}

const dayAllowed = (sc, date) => sc.days.includes(WEEKDAYS[dowOf(date)]);

const windowMinutes = (sc) => {
  const minutes = new Set();
  for (const w of sc.windows) {
    const end = toMinutes(w.end);
    for (let m = toMinutes(w.start); m <= end; m += w.every) minutes.add(m);
  }
  return minutes;
};

// Follow mode, the check before the user's day starts. For one date in the user's zone: the instant
// the day starts (`start`), the instant of the check that serves it (`at`) and whether a block check
// already sits 60-90 minutes ahead (`added` false) or an extra one is needed (`added` true). null on
// a day the designers do not work.
export function preDayFor(sc, userDate) {
  const f = sc.follow;
  if (!f || !sc.days.includes(WEEKDAYS[dowOf(userDate)])) return null;
  const start = zonedToUtc({ ...userDate, h: Number(f.my_start.slice(0, 2)), mi: Number(f.my_start.slice(3, 5)) }, f.my_tz);
  const [near, far] = PRE_DAY_BAND;
  const lo = start - far * MIN;
  const hi = start - near * MIN;
  const dates = [dateOf(lo, sc.timezone), dateOf(hi, sc.timezone)];
  const hit = [];
  for (const d of dates.filter((x, i) => i === 0 || x.d !== dates[0].d)) for (const t of blockSlots(sc, d)) if (t >= lo && t <= hi) hit.push(t);
  if (hit.length) return { start, at: Math.max(...hit), added: false };
  return { start, at: start - f.lead * MIN, added: true };
}

function blockSlots(sc, date) {
  if (!dayAllowed(sc, date)) return [];
  return [...windowMinutes(sc)].map((m) => zonedToUtc({ ...date, h: Math.floor(m / 60), mi: m % 60 }, sc.timezone));
}

// Extra pre-day checks that fall on one date of the designers' zone.
function preDayOn(sc, date) {
  const lo = zonedToUtc({ ...date, h: 0, mi: 0 }, sc.timezone);
  const hi = zonedToUtc({ ...addDays(date, 1), h: 0, mi: 0 }, sc.timezone);
  const first = dateOf(lo, sc.follow.my_tz);
  const out = [];
  for (let k = -1; k <= 2; k++) {
    const pd = preDayFor(sc, addDays(first, k));
    if (pd?.added && pd.at >= lo && pd.at < hi) out.push(pd.at);
  }
  return out;
}

// Every scheduled instant on one local date, sorted, without duplicates.
export function slotsOn(sc, date) {
  if (sc.mode === "interval") return [];
  if (sc.mode === "follow") return [...new Set([...blockSlots(sc, date), ...preDayOn(sc, date)])].sort((a, b) => a - b);
  if (!dayAllowed(sc, date)) return [];
  const minutes = new Set();
  if (sc.mode === "times") for (const t of sc.times) minutes.add(toMinutes(t));
  else for (const m of windowMinutes(sc)) minutes.add(m);
  const at = [...minutes].map((m) => zonedToUtc({ ...date, h: Math.floor(m / 60), mi: m % 60 }, sc.timezone));
  return [...new Set(at)].sort((a, b) => a - b);
}

const dateOf = (ms, tz) => {
  const p = zonedParts(ms, tz);
  return { y: p.y, mo: p.mo, d: p.d };
};

// The latest scheduled instant at or before `now`, or null (looks back 8 days, so a schedule on
// one weekday still finds last week's).
export function lastSlot(sc, now) {
  const today = dateOf(now, sc.timezone);
  for (let i = 0; i <= 8; i++) {
    const past = slotsOn(sc, addDays(today, -i)).filter((t) => t <= now);
    if (past.length) return past[past.length - 1];
  }
  return null;
}

// The first scheduled instant after `now`, or null.
export function nextSlot(sc, now) {
  const today = dateOf(now, sc.timezone);
  for (let i = 0; i <= 8; i++) {
    const later = slotsOn(sc, addDays(today, i)).filter((t) => t > now);
    if (later.length) return later[0];
  }
  return null;
}

// Is a check due? last: ms of the last check or null; lastOk: false when it failed.
// Returns { due, why } where why is "first" | "catch-up" | "scheduled" | "interval" | "retry" | "".
export function dueState({ sc, last, lastOk = true, now = Date.now() }) {
  if (last == null) return { due: true, why: "first" };
  if (sc.mode !== "interval" && lastOk === false && now - last >= RETRY_MINUTES * MIN) return { due: true, why: "retry" };
  if (sc.mode === "interval") {
    const day = dayAllowed(sc, dateOf(now, sc.timezone));
    return { due: day && now - last >= sc.poll_minutes * MIN - 30000, why: "interval" };
  }
  const slot = lastSlot(sc, now);
  if (slot == null || last >= slot) return { due: false, why: "" };
  // Within a minute of the slot it ran on time; further behind means the Mac was asleep or off.
  return { due: true, why: now - slot > 20 * MIN ? "catch-up" : "scheduled" };
}

// When the next check happens: { at, now } where now is true when one is due already.
export function nextCheck({ sc, last, lastOk = true, now = Date.now() }) {
  if (dueState({ sc, last, lastOk, now }).due) return { at: now, now: true };
  if (sc.mode !== "interval") {
    const at = nextSlot(sc, now);
    return { at, now: false };
  }
  let at = Math.max(now, last + sc.poll_minutes * MIN);
  for (let i = 0; i < 9 && !dayAllowed(sc, dateOf(at, sc.timezone)); i++) {
    const next = addDays(dateOf(at, sc.timezone), 1);
    at = zonedToUtc({ ...next, h: 0, mi: 0 }, sc.timezone);
  }
  return { at, now: false };
}

// The background job's wake interval: as often as the busiest project needs, never slower than
// WAKE_MINUTES.
export function wakeMinutes(configs) {
  let m = WAKE_MINUTES;
  for (const c of configs) {
    const sc = scheduleOf(c);
    if (sc.mode === "interval") m = Math.min(m, sc.poll_minutes);
    else if (sc.mode === "windows") m = Math.min(m, ...sc.windows.map((w) => w.every));
    else if (sc.mode === "follow") m = Math.min(m, sc.follow.every);
  }
  return Math.max(1, m);
}

// ---- words ------------------------------------------------------------------------------------

export function describeDays(days) {
  const d = WEEKDAYS.filter((x) => days.includes(x));
  if (d.length === 7) return "every day";
  const run = d.every((x, i) => i === 0 || WEEKDAYS.indexOf(x) === WEEKDAYS.indexOf(d[i - 1]) + 1);
  if (d.length > 2 && run) return `${DAY_NAMES[d[0]]}-${DAY_NAMES[d[d.length - 1]]}`;
  return d.map((x) => DAY_NAMES[x]).join(", ");
}

export function describe(sc) {
  const days = describeDays(sc.days);
  if (sc.mode === "follow") {
    const f = sc.follow;
    const blocks = sc.windows.map((w) => `${w.start}-${w.end}`).join(" and ");
    return `follow the designers: every ${f.every} min ${blocks} ${days}, ${sc.timezone} time${f.fallback ? " (fallback, too little activity to derive their hours)" : ""}, plus a check before your ${f.my_start} ${f.my_tz} day starts`;
  }
  if (sc.mode === "times") return `${sc.times.join(", ")} ${days}, ${sc.timezone} time`;
  if (sc.mode === "windows") return `every ${sc.windows.map((w) => `${w.every} min ${w.start}-${w.end}`).join(" and ")} ${days}, ${sc.timezone} time`;
  return `every ${sc.poll_minutes} min${sc.days.length < 7 ? ` ${days}` : ""}`;
}

// "Sat 3 Oct 06:00 PDT", in `tz`. The zone abbreviation comes from whichever of en-US and en-GB has
// a real one (en-US knows PDT, en-GB knows CEST); otherwise "GMT+2".
export function fmtAt(ms, tz) {
  const parts = (locale) => {
    const o = {};
    for (const p of new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms))) o[p.type] = p.value;
    return o;
  };
  const gb = parts("en-GB");
  const us = parts("en-US");
  const name = [us.timeZoneName, gb.timeZoneName].find((n) => !/^GMT|^UTC/.test(n)) ?? gb.timeZoneName;
  return `${gb.weekday} ${gb.day} ${gb.month} ${gb.hour}:${gb.minute} ${name}`;
}
