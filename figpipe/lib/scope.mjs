// Ownership: whose handoff is this section? Each ready node is mine, others (with who) or unknown,
// from signals ranked by how explicit they are:
//   1. answers   `figpipe own <name|url> mine|others`, kept in state.db
//   2. rules     [scope] exclude (others), then include (mine)
//   3. tracker   [scope.assign] section pattern -> implementer
//   4. the name  the same section in another language ("Location_GER" beside a "Location" you
//                pre-built or answered for) has that section's owner; rules see "Location" too
//   5. comments  who is @mentioned on the section: only the user -> mine, only [scope].others -> others
//   6. nothing   unknown: held as "Is this yours?" when [scope].unknown = "ask", built when "mine"
// Others' work is recorded as 'out_of_scope', unknowns as 'needs_owner'; neither is ever batched.
// Manual adds (figpipe add) are never judged, and watched sections ([[figma.files.watch]], pre-built
// by the user) are always mine. Comment threads follow the thread rules at the bottom.
import { mentionMatcher } from "./reconcile.mjs";
import { watchesOf } from "./watch.mjs";
import { nameParts, sameBase } from "./names.mjs";

const RECENT_NODE = 5;
const RECENT_THREAD = 3;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const list = (a) => a.join(", ");

// Glob (* and ?), case-insensitive, matched against the whole name.
export function globToRegex(pattern) {
  return new RegExp(`^${[...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : esc(c))).join("")}$`, "is");
}

// The first pattern that matches the node's own name or one of its ancestors' names: { pattern, name } or null.
export function matchNames(patterns, names) {
  for (const p of patterns) {
    const re = globToRegex(p);
    for (const n of names) if (n && re.test(n)) return { pattern: p, name: n };
  }
  return null;
}

// Which of the `others` does a comment @mention? "Ada Brooks" also answers to "@Ada".
export function othersMentioned(others, text) {
  const found = [];
  for (const o of others) {
    const full = o.trim();
    const first = full.split(/\s+/)[0];
    const alts = [...new Set([full, first.length >= 3 ? first : null].filter(Boolean))].map(esc);
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@])@(${alts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
    if (re.test(text ?? "")) found.push(o);
  }
  return found;
}

const isMeName = (me, who) => {
  const w = who.trim().toLowerCase();
  return [me.handle, ...(me.names ?? [])].filter(Boolean).some((n) => n.trim().toLowerCase() === w);
};

// What the recent comments say: { me: comments tagging the user, others: { name: count }, total }.
export function commentSignal({ comments, scope, me, recent = RECENT_NODE }) {
  const mentionsMe = mentionMatcher(me);
  const last = comments.slice(-recent);
  const sig = { me: 0, others: {}, total: last.length };
  for (const c of last) {
    if (mentionsMe(c.message)) sig.me++;
    for (const o of othersMentioned(scope.others, c.message)) sig.others[o] = (sig.others[o] ?? 0) + 1;
  }
  return sig;
}

const tagged = (sig) => Object.keys(sig.others);
const confidenceOf = (sig) => (Object.values(sig.others).reduce((a, b) => a + b, 0) >= 2 ? "high" : "medium");

// The part of the judgment that does not read comments: answers, then rules, then the tracker map,
// then the owner of the same section under another language tag (an answer, or a section the user
// pre-built: `watched` holds their names). Rules and the tracker also see a name without its
// language tag, so "Contact*" and "Contact" both cover "Contact_EN".
// -> { owner, who, confidence, why, source } or null.
export function explicitOwner({ scope, me, name, path = [], nodeId = null, answers = [], watched = [] }) {
  const own = [name, ...path];
  const names = [...new Set([...own, ...own.map((n) => nameParts(n).bare)])];
  const key = String(name ?? "").trim().toLowerCase();
  const ans = answers.find((a) => (nodeId && a.node_id === nodeId) || (a.name_key && own.some((n) => String(n ?? "").trim().toLowerCase() === a.name_key)) || a.name_key === key);
  if (ans) return { owner: ans.owner, who: ans.who ?? [], confidence: "answered", why: `you answered ${ans.owner}${ans.who?.length ? ` (${list(ans.who)})` : ""}`, source: "answer" };
  const ex = matchNames(scope.exclude, names);
  if (ex) return { owner: "others", who: [], confidence: "rule", why: `matches exclude "${ex.pattern}"${ex.name === name ? "" : ` (in ${ex.name})`}`, source: "rule" };
  const inc = matchNames(scope.include, names);
  if (inc) return { owner: "mine", who: [], confidence: "rule", why: `matches include "${inc.pattern}"`, source: "rule" };
  for (const [pattern, person] of Object.entries(scope.assign ?? {})) {
    if (!matchNames([pattern], names)) continue;
    return isMeName(me, person)
      ? { owner: "mine", who: [], confidence: "rule", why: `tracker assigns it to you (${pattern})`, source: "tracker" }
      : { owner: "others", who: [person], confidence: "rule", why: `tracker assigns it to ${person}`, source: "tracker" };
  }
  const variant = watched.find((w) => sameBase(w, name));
  if (variant) return { owner: "mine", who: [], confidence: "rule", why: `the same section as "${variant}", which you pre-built`, source: "name" };
  const kin = answers.filter((a) => sameBase(a.name ?? a.name_key, name)).sort((a, b) => String(b.answered_at ?? "").localeCompare(String(a.answered_at ?? "")))[0];
  if (kin) return { owner: kin.owner, who: kin.who ?? [], confidence: "answered", why: `you answered ${kin.owner} for "${kin.name ?? kin.name_key}", the same section`, source: "name" };
  return null;
}

// -> { owner: mine|others|unknown, who: [], confidence, why, source }
export function ownerOf({ scope, me, name, path = [], nodeId = null, comments = [], answers = [], watched = [] }) {
  const e = explicitOwner({ scope, me, name, path, nodeId, answers, watched });
  if (e) return e;
  const sig = commentSignal({ comments, scope, me });
  if (sig.me) return { owner: "mine", who: [], confidence: "medium", why: `you are tagged on it (${sig.me} of the last ${sig.total} comments)`, source: "comments" };
  if (tagged(sig).length) return { owner: "others", who: tagged(sig), confidence: confidenceOf(sig), why: `comments tag only ${list(tagged(sig))}`, source: "comments" };
  return { owner: "unknown", who: [], confidence: "none", why: "no rule, assignment or comment says who builds it", source: "none" };
}

// Comment drift: an owner set by an answer, rule or tracker that the section's comments now contradict.
export function driftOf({ scope, me, name, path = [], nodeId = null, comments = [], answers = [], watched = [] }) {
  const e = explicitOwner({ scope, me, name, path, nodeId, answers, watched });
  if (!e) return null;
  const sig = commentSignal({ comments, scope, me });
  const n = Object.values(sig.others).reduce((a, b) => a + b, 0);
  if (e.owner === "mine" && !sig.me && n >= 2) return { owner: "mine", why: `${e.why}, but its comments tag only ${list(tagged(sig))}` };
  if (e.owner === "others" && sig.me >= 2 && !n) return { owner: "others", why: `${e.why}, but its comments tag you` };
  return null;
}

// The thread rule: the latest 3 comments tag only others and not the user -> theirs.
export function scopeOfThread({ scope, me, comments }) {
  const sig = commentSignal({ comments, scope, me, recent: RECENT_THREAD });
  if (!sig.me && tagged(sig).length) return { in: false, reason: `latest comments tag only ${list(tagged(sig))}` };
  return { in: true, reason: null };
}

// Event status for an ownership verdict under the project's unknown policy.
export function verdictFor(o, scope) {
  if (o.owner === "mine") return { status: "pending", reason: null };
  if (o.owner === "others") return { status: "out_of_scope", reason: o.why };
  return scope.unknown === "ask" ? { status: "needs_owner", reason: o.why } : { status: "pending", reason: null };
}

const byTime = (a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "");

// The names of the sections the user pre-built, as the config names them. A layer's own Figma
// name can be as plain as "Desktop", which says nothing about who builds a section.
export const watchedNames = (config) => [...new Set(watchesOf(config).map((w) => w.name))];

export function answersOf(db, project) {
  return db.all("SELECT * FROM ownership WHERE project = ?", project).map((r) => ({ ...r, who: JSON.parse(r.who || "[]") }));
}

export function commentsOnNode(db, project, fileKey, nodeId) {
  return db
    .all(
      `SELECT * FROM comments WHERE project = ? AND file_key = ? AND deleted = 0 AND (node_id = ? OR node_id IN (SELECT node_id FROM node_areas WHERE project = ? AND file_key = ? AND area_id = ?))`,
      project, fileKey, nodeId, project, fileKey, nodeId,
    )
    .sort(byTime);
}

// Re-judge every waiting trigger event against the current rules and answers. Pending ones that
// are someone else's become 'out_of_scope', unknown ones 'needs_owner' (reason in note); ones
// marked earlier come back when the rules or answers change.
// Returns the events whose status changed: [{ key, status, name, reason }].
export function applyScope({ db, config }) {
  const scope = config.scope;
  const project = config.project.slug;
  const me = config.figma.me;
  const answers = answersOf(db, project);
  const rows = db.all(
    "SELECT * FROM events WHERE project = ? AND role = 'trigger' AND kind IN ('ready', 'changed', 'comment') AND status IN ('pending', 'out_of_scope', 'needs_owner') ORDER BY id",
    project,
  );
  const changed = [];
  const watched = new Set(watchesOf(config).map((w) => `${w.file_key}:${w.node}`));
  const prebuilt = watchedNames(config);
  for (const e of rows) {
    const payload = JSON.parse(e.payload || "{}");
    if (payload.manual) continue;
    let verdict = { status: "pending", reason: null };
    let name;
    if (payload.watch || (e.kind !== "comment" && watched.has(`${e.file_key}:${e.node_id}`))) {
      name = payload.name ?? (payload.text ? `${payload.by ?? "comment"}: ${String(payload.text).replace(/\s+/g, " ").slice(0, 50)}` : e.node_id);
    } else if (e.kind === "comment") {
      const comments = db.all("SELECT * FROM comments WHERE project = ? AND file_key = ? AND root_id = ? AND deleted = 0", project, e.file_key, e.thread_id ?? e.comment_id).sort(byTime);
      const ledger = db.get("SELECT 1 AS x FROM ledger WHERE project = ? AND key = ?", project, `thread:${e.file_key}:${e.thread_id ?? e.comment_id}`);
      const t = ledger ? { in: true } : scopeOfThread({ scope, me, comments });
      if (!t.in) verdict = { status: "out_of_scope", reason: t.reason };
      name = `${payload.by ?? "comment"}: ${String(payload.text ?? "").replace(/\s+/g, " ").slice(0, 50)}`;
    } else {
      const node = db.get("SELECT name, path FROM nodes WHERE project = ? AND file_key = ? AND node_id = ?", project, e.file_key, e.node_id);
      name = node?.name ?? payload.name ?? e.node_id;
      const o = ownerOf({ scope, me, name, path: node?.path ? JSON.parse(node.path) : payload.path ?? [], nodeId: e.node_id, comments: commentsOnNode(db, project, e.file_key, e.node_id), answers, watched: prebuilt });
      verdict = verdictFor(o, scope);
    }
    name ??= payload.name ?? e.node_id ?? e.key;
    if (verdict.status !== e.status) {
      db.run("UPDATE events SET status = ?, note = ? WHERE id = ?", verdict.status, verdict.reason, e.id);
      changed.push({ key: e.key, status: verdict.status, name, reason: verdict.reason });
    } else if ((e.note ?? null) !== verdict.reason) db.run("UPDATE events SET note = ? WHERE id = ?", verdict.reason, e.id);
  }
  return changed;
}

const nameOf = (r) => {
  const p = JSON.parse(r.payload || "{}");
  return p.name ?? (p.text ? `${p.by ?? "comment"}: ${String(p.text).replace(/\s+/g, " ").slice(0, 40)}` : r.node_id);
};

// What status and the index show: others' work as a count, unknowns as questions.
export function scopeSummary(db, project) {
  const rows = (status) => db.all("SELECT node_id, thread_id, payload, note FROM events WHERE project = ? AND status = ? AND role = 'trigger' ORDER BY detected_at DESC, id DESC", project, status);
  const out = rows("out_of_scope");
  const ask = rows("needs_owner");
  const items = (rs) => [...new Map(rs.map((r) => [r.node_id ?? r.thread_id ?? r.payload, r])).values()];
  const o = items(out);
  return {
    n: o.length,
    latest: o.length ? { name: nameOf(o[0]), reason: o[0].note } : null,
    ask: items(ask).map((r) => ({ name: nameOf(r), node_id: r.node_id, reason: r.note })),
  };
}

export const scopeLine = (s) => (s.n ? `${s.n} out of scope (latest: ${s.latest.name}, ${s.latest.reason})` : null);
export const askLines = (s) => s.ask.map((a) => `Is this yours? ${a.name}: ${a.reason}. Answer: figpipe own "${a.name}" mine|others`);

// Record an answer. Takes a section name (case-insensitive, exact) and optionally its node id.
export function recordOwnership({ db, project, name, nodeId = null, fileKey = null, owner, who = [], now = new Date().toISOString() }) {
  if (!["mine", "others"].includes(owner)) throw new Error('answer "mine" or "others"');
  db.run(
    `INSERT INTO ownership (project, name_key, name, file_key, node_id, owner, who, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, name_key) DO UPDATE SET name = excluded.name, file_key = excluded.file_key, node_id = excluded.node_id, owner = excluded.owner, who = excluded.who, answered_at = excluded.answered_at`,
    project, name.trim().toLowerCase(), name, fileKey, nodeId, owner, JSON.stringify(who), now,
  );
}

// Every ready section with its owner and why: the table setup shows and doctor reads.
export function ownershipTable({ db, config }) {
  const project = config.project.slug;
  const answers = answersOf(db, project);
  const watched = watchedNames(config);
  return db
    .all("SELECT * FROM nodes WHERE project = ? AND status = 'READY_FOR_DEV' ORDER BY name", project)
    .map((n) => {
      const comments = commentsOnNode(db, project, n.file_key, n.node_id);
      const args = { scope: config.scope, me: config.figma.me, name: n.name, path: JSON.parse(n.path || "[]"), nodeId: n.node_id, comments, answers, watched };
      return { node_id: n.node_id, file_key: n.file_key, name: n.name, path: args.path, ...ownerOf(args), drift: driftOf(args), comments: comments.length };
    });
}

// The ready sections that are the user's and that no watch points at: what `figpipe watch baseline
// --all` records beside the watched ones. Unknown owners count when the project builds them.
export function ownedSections({ db, config }) {
  const watched = new Set(watchesOf(config).map((w) => `${w.file_key}:${w.node}`));
  return ownershipTable({ db, config }).filter((r) => !watched.has(`${r.file_key}:${r.node_id}`) && verdictFor(r, config.scope).status === "pending");
}
