// A sample batch for the proof packet: a made-up project ("Acme") with one of every kind of item,
// recorded through the same path a real session uses (state.db rows, recordResult, writeReport).
// Images are generated SVG mock-ups, so the sample has no binary fixtures and no real client data.
//   figpipe report --sample [--out <dir>]
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.mjs";
import { recordResult } from "./record.mjs";
import { writeReport } from "./report.mjs";

const BATCH = "acme-20261002-1630";
const FILE = "SampleFileKey000000000";
const MARKER = ".figpipe-sample";

// ---- SVG mock-ups ------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const T = (x, y, s, size, fill = "#16181d", weight = 400, anchor = "start") =>
  `<text x="${x}" y="${y}" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const R = (x, y, w, h, fill, r = 0, stroke = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ""}/>`;
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${R(0, 0, w, h, "#ffffff")}${body}</svg>\n`;

// The pricing section: "before" is the old two-plan layout; "after" and "figma" the new three-plan
// design. The figma version differs in one detail (the badge), as real captures do.
function pricing(width, variant) {
  const mobile = width < 600;
  const tablet = width >= 600 && width < 1200;
  const pad = mobile ? 20 : tablet ? 40 : 120;
  const plans = variant === "before" ? [["Basic", "$9"], ["Pro", "$29"]] : [["Starter", "$12"], ["Team", "$32"], ["Scale", "$79"]];
  const cols = mobile ? 1 : tablet ? 2 : plans.length;
  const gap = mobile ? 16 : 24;
  const cardW = (width - pad * 2 - gap * (cols - 1)) / cols;
  const cardH = mobile ? 300 : 360;
  const rows = Math.ceil(plans.length / cols);
  const top = mobile ? 150 : 200;
  const h = top + rows * cardH + (rows - 1) * gap + (mobile ? 60 : 100);
  const accent = variant === "before" ? "#5d6370" : "#2453c7";
  let b = R(0, 0, width, h, variant === "before" ? "#f4f5f7" : "#ffffff");
  b += T(width / 2, mobile ? 64 : 92, variant === "before" ? "Pricing" : "Plans that grow with you", mobile ? 26 : 40, "#16181d", 700, "middle");
  b += T(width / 2, mobile ? 100 : 136, variant === "before" ? "Simple monthly plans." : "Billed monthly. Cancel any time.", mobile ? 15 : 18, "#5d6370", 400, "middle");
  if (variant !== "before") b += R(width / 2 - 90, mobile ? 112 : 152, 180, 30, "#eef2fc", 15) + T(width / 2, mobile ? 132 : 172, "Monthly  ·  Yearly", 13, "#2453c7", 600, "middle");
  plans.forEach(([name, price], i) => {
    const x = pad + (i % cols) * (cardW + gap);
    const y = top + Math.floor(i / cols) * (cardH + gap);
    const featured = variant !== "before" && i === 1;
    b += R(x, y, cardW, cardH, featured ? "#16181d" : "#ffffff", 14, featured ? "" : "#e3e5ea");
    const fg = featured ? "#ffffff" : "#16181d";
    b += T(x + 24, y + 44, name, 20, fg, 600);
    if (featured) b += R(x + cardW - (variant === "figma" ? 132 : 120), y + 24, variant === "figma" ? 108 : 96, 26, "#2453c7", 13) + T(x + cardW - (variant === "figma" ? 78 : 72), y + 42, variant === "figma" ? "Most popular" : "Popular", 12, "#ffffff", 600, "middle");
    b += T(x + 24, y + 104, price, 44, fg, 700) + T(x + 24 + price.length * 26, y + 104, "/mo", 16, featured ? "#c8ccd4" : "#5d6370");
    for (let k = 0; k < 3; k++) b += R(x + 24, y + 140 + k * 30, cardW * (0.7 - k * 0.12), 10, featured ? "#3a3f4a" : "#e3e5ea", 5);
    b += R(x + 24, y + cardH - 76, cardW - 48, 48, featured ? "#ffffff" : accent, 10) + T(x + cardW / 2, y + cardH - 46, "Start your free trial", 15, featured ? "#16181d" : "#ffffff", 600, "middle");
  });
  return svg(width, h, b);
}

function careers(width) {
  const mobile = width < 600;
  const pad = mobile ? 20 : width < 1200 ? 40 : 120;
  const roles = ["Product designer", "Senior engineer, web", "Support lead"];
  const h = (mobile ? 260 : 320) + roles.length * 96 + 80;
  let b = R(0, 0, width, mobile ? 220 : 280, "#16181d");
  b += T(pad, mobile ? 96 : 130, "Work at Acme", mobile ? 32 : 52, "#ffffff", 700);
  b += T(pad, mobile ? 136 : 180, "Remote across Europe. 3 open roles.", mobile ? 15 : 20, "#c8ccd4");
  roles.forEach((r, i) => {
    const y = (mobile ? 260 : 320) + i * 96;
    b += R(pad, y, width - pad * 2, 80, "#ffffff", 12, "#e3e5ea") + T(pad + 20, y + 36, r, mobile ? 16 : 20, "#16181d", 600) + T(pad + 20, y + 60, "Full time · Remote", 14, "#5d6370");
    if (!mobile) b += T(width - pad - 20, y + 46, "View role", 15, "#2453c7", 600, "end");
  });
  return svg(width, h, b);
}

// An in-progress About page the user pre-built (a watched section): the designer added a fourth
// team card and changed the intro between the build and now.
function about(width, variant) {
  const mobile = width < 600;
  const pad = mobile ? 20 : width < 1200 ? 40 : 120;
  const team = variant === "before" ? ["Mara", "Jon", "Ines"] : ["Mara", "Jon", "Ines", "Kofi"];
  const cols = mobile ? 1 : width < 1200 ? 2 : 4;
  const cardW = (width - pad * 2 - (cols - 1) * 20) / cols;
  const rows = Math.ceil(team.length / cols);
  const top = mobile ? 230 : 290;
  const h = top + rows * 220 + 60;
  let b = R(0, 0, width, h, "#ffffff");
  b += T(pad, mobile ? 80 : 110, "About Acme", mobile ? 30 : 48, "#16181d", 700);
  b += T(pad, mobile ? 120 : 160, variant === "before" ? "We build booking tools." : "We build booking tools for studios.", mobile ? 15 : 20, "#5d6370");
  team.forEach((n, i) => {
    const x = pad + (i % cols) * (cardW + 20);
    const y = top + Math.floor(i / cols) * 220;
    b += R(x, y, cardW, 200, "#f4f5f7", 12) + R(x + 20, y + 20, 64, 64, "#c8ccd4", 32) + T(x + 20, y + 120, n, 18, "#16181d", 600) + T(x + 20, y + 146, "Team", 14, "#5d6370");
  });
  return svg(width, h, b);
}

const pin = (label, fill = "#2453c7") => svg(480, 200, R(0, 0, 480, 200, "#f4f5f7") + R(120, 70, 240, 56, fill, 12) + T(240, 104, label, 17, "#ffffff", 600, "middle"));
const hero = () => svg(640, 360, R(0, 0, 640, 360, "#16181d") + T(40, 150, "Care that fits your week", 34, "#ffffff", 700) + R(40, 200, 200, 52, "#2453c7", 10) + T(140, 232, "Book a visit", 16, "#ffffff", 600, "middle") + R(400, 60, 200, 240, "#2a2e36", 16) + T(500, 186, "artwork slot", 13, "#9aa1ad", 400, "middle"));
const faq = () => svg(640, 300, R(0, 0, 640, 300, "#ffffff") + [0, 1, 2].map((i) => R(40, 40 + i * 76, 560, 60, "#ffffff", 10, "#e3e5ea") + T(64, 76 + i * 76, ["How do I cancel?", "Do you offer refunds?", "Can I change plans?"][i], 16, "#16181d", 600) + T(576, 76 + i * 76, "+", 22, "#5d6370", 400, "end")).join(""));
const footer = () => svg(640, 160, R(0, 0, 640, 160, "#16181d") + T(40, 60, "Acme", 22, "#ffffff", 700) + [0, 1, 2, 3].map((i) => T(40 + i * 130, 110, ["About", "Careers", "Privacy", "Contact"][i], 14, "#c8ccd4")).join(""));

// ---- The batch ---------------------------------------------------------------------------------
const WIDTHS = [1440, 1024, 390];

function seed(db, dir) {
  const media = join(dir, "media");
  mkdirSync(media, { recursive: true });
  mkdirSync(join(dir, "captures"), { recursive: true });
  const put = (rel, body) => (writeFileSync(join(dir, rel), body), rel);
  const renders = {
    pricing: put("media/figma-pricing.svg", pricing(1440, "figma")),
    careers: put("media/figma-careers.svg", careers(1440)),
    trial: put("media/pin-trial-button.svg", pin("Start free trial")),
    hero: put("media/pin-hero.svg", hero()),
    testimonials: put("media/pin-testimonials.svg", pin("Testimonials", "#5d6370")),
    faq: put("media/figma-faq.svg", faq()),
    footer: put("media/figma-footer.svg", footer()),
  };
  for (const w of WIDTHS) {
    put(`captures/pricing-before-${w}.svg`, pricing(w, "before"));
    put(`captures/pricing-after-${w}.svg`, pricing(w, "after"));
    put(`captures/pricing-figma-${w}.svg`, pricing(w, "figma"));
    put(`captures/careers-after-${w}.svg`, careers(w));
    put(`captures/careers-figma-${w}.svg`, careers(w));
    put(`media/figma-about-before-${w}.svg`, about(w, "before"));
    put(`media/figma-about-now-${w}.svg`, about(w, "figma"));
    put(`captures/about-before-${w}.svg`, about(w, "before"));
    put(`captures/about-after-${w}.svg`, about(w, "after"));
    put(`captures/about-figma-${w}.svg`, about(w, "figma"));
  }

  const at = (m) => new Date(Date.parse("2026-10-02T16:30:00Z") + m * 60000).toISOString();
  db.run(
    "INSERT INTO batches (id, project, status, reason, autonomy, dir, created_at, started_at, finished_at, session_id, attempts, usd) VALUES (?, 'acme', 'running', 'designer quiet for 20 min', 'build', ?, ?, ?, ?, ?, 1, ?)",
    BATCH, dir, at(0), at(1), at(38), "5f0c2a9e-4b7d-4c1e-9a3f-2d8e6b1c7a40", 6.42,
  );
  const item = (o) =>
    Number(
      db.run(
        "INSERT INTO items (batch_id, project, file_key, kind, node_id, thread_id, area_id, area_name, title, fingerprint, deep_fingerprint, outcome, verdict, figma_render, source, motion, branch, commits) VALUES (?, 'acme', ?, ?, ?, ?, ?, ?, ?, 'fp', 'dfp', ?, ?, ?, ?, ?, ?, ?)",
        BATCH, FILE, o.kind, o.node ?? null, o.thread ?? null, o.area_id ?? null, o.area ?? null, o.title, o.outcome ?? "pending", o.verdict ?? null, o.render ?? null,
        JSON.stringify({ events: o.events ?? [] }), o.motion ? JSON.stringify(o.motion) : null, o.branch ?? null, o.commits ? JSON.stringify(o.commits) : null,
      ).lastInsertRowid,
    );
  const thread = (root, node, msgs) =>
    msgs.forEach(([by, text, m, mine], i) =>
      db.run(
        "INSERT INTO comments (project, file_key, comment_id, root_id, parent_id, node_id, author, message, created_at, mentions_me, by_me) VALUES ('acme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        FILE, i ? `${root}${i}` : root, root, i ? root : null, node, by, text, at(m), /@tony/.test(text) ? 1 : 0, mine ? 1 : 0,
      ),
    );

  const ids = {};
  ids.pricing = item({ kind: "ready", node: "10:200", area_id: "10:200", area: "Pricing", title: "Pricing", render: renders.pricing, events: [{ kind: "ready", payload: { description: "New plans and the billing toggle" } }] });
  ids.careers = item({ kind: "manual", node: "10:400", area_id: "10:400", area: "Careers", title: "Careers", render: renders.careers, events: [{ kind: "manual", payload: { manual: true, note: "New page, build it from the desktop frame" } }] });
  thread("700100", "10:231", [["Mara", "@tony 'Start free trial' should read 'Start your free trial' on every plan card.", -50]]);
  ids.trial = item({ kind: "comment", node: "10:231", thread: "700100", area_id: "10:200", area: "Pricing", title: "Comment on Plan card / Button", render: renders.trial });
  thread("700200", "10:12", [["Mara", "@tony the hero animation feels slow on mobile", -48], ["Tony", "Slow how, the fade or the image slide?", -40, true], ["Mara", "The image slide. I shortened it in the prototype.", -33]]);
  ids.hero = item({ kind: "comment", node: "10:12", thread: "700200", area_id: "10:10", area: "Home hero", title: "Comment on Hero / Image", render: renders.hero, motion: [{ node_id: "10:12", name: "Hero image", why: "a comment talks about motion" }] });
  thread("700300", "10:520", [["Jon", "@tony can testimonials come from the CMS so marketing can edit them?", -45]]);
  ids.testimonials = item({ kind: "comment", node: "10:520", thread: "700300", area_id: "10:500", area: "Testimonials", title: "Comment on Testimonials", render: renders.testimonials });
  ids.faq = item({ kind: "ready", node: "10:600", area_id: "10:600", area: "FAQ", title: "FAQ", render: renders.faq, events: [{ kind: "ready", payload: { description: "Accordion, one open at a time" } }] });
  ids.footer = item({
    kind: "changed", node: "10:900", area_id: "10:900", area: "Footer", title: "Footer", render: renders.footer, outcome: "already_done",
    verdict: "No design change since batch acme-20260929-1015 built it.", branch: "figma/footer", commits: ["4be1c09d2a"],
  });
  // A watched section: pre-built from the in-progress design, now changed in Figma.
  const frames = (v) => WIDTHS.map((w, i) => ({ node_id: `10:70${i + 1}`, role: "child", name: ["Desktop", "Tablet", "Mobile"][i], width: w, path: `media/figma-about-${v}-${w}.svg` }));
  ids.about = item({
    kind: "changed", node: "10:700", area_id: "10:700", area: "About", title: "About", render: "media/figma-about-now-1440.svg",
    events: [{ kind: "changed", payload: { name: "About", watch: "10:700", why: "the in-progress design changed" } }],
  });
  db.run("UPDATE items SET watch = ?, figma_before = ? WHERE id = ?", JSON.stringify({ node: "10:700", name: "About", lane: "about", branch: "feat/about", route: "/preview/about", built: true }), JSON.stringify(frames("before")), ids.about);
  writeFileSync(
    join(dir, "extract.json"),
    JSON.stringify({ items: { [ids.about]: { renders: [{ node_id: "10:700", role: "node", name: "About", width: 3229, path: "media/figma-about-now-1440.svg" }, ...frames("now")], baseline: { snapshot: "baseline-20260930-091500", at: "2026-09-30T09:15:00Z" }, sdiff: { changed_lines: 14 }, copy_diff: { changed_lines: 1 } } } }),
  );
  db.run("INSERT INTO events (key, project, file_key, kind, role, payload, detected_at, status, batch_id) VALUES (?, 'acme', ?, 'version', 'context', ?, ?, 'done', ?)", `version:${FILE}:1`, FILE, JSON.stringify({ label: "Handoff 3", by: "Mara", description: "Pricing and careers ready" }), at(-25), BATCH);
  db.run("INSERT INTO denials (batch_id, at, tool, input, reason) VALUES (?, ?, 'Bash', ?, ?)", BATCH, at(12), JSON.stringify({ command: "curl -s https://cdn.example.com/fonts/acme.woff2 -o public/fonts/acme.woff2" }), "network access to cdn.example.com is not allowed");

  writeFileSync(
    join(dir, "batch.json"),
    JSON.stringify({
      schema: 1, batch: BATCH, project: "acme", mode: "build",
      lanes: [
        { lane: "pricing", branch: "figma/pricing", base: "main", worktree: "~/Projects/acme-site-fp-pricing", port: 3011, dev: "npx nuxt dev --port 3011", preview: "http://localhost:3011/preview/pricing" },
        { lane: "careers", branch: "figma/careers", base: "main", worktree: "~/Projects/acme-site-fp-careers", port: 3012, dev: "npx nuxt dev --port 3012", preview: "http://localhost:3012/preview/careers" },
        { lane: "home-hero", branch: "figma/home-hero", base: "feat/home", worktree: "~/Projects/acme-site-fp-home-hero", port: 3013, dev: "npx nuxt dev --port 3013", preview: "http://localhost:3013/" },
        { lane: "faq", branch: "figma/faq", base: "main", worktree: "~/Projects/acme-site-fp-faq", port: 3014, dev: "npx nuxt dev --port 3014", preview: "http://localhost:3014/preview/faq" },
        { lane: "about", branch: "figma/about", base: "feat/about", worktree: "~/Projects/acme-site-fp-about", port: 3015, dev: "npx nuxt dev --port 3015", preview: "http://localhost:3015/preview/about", watch: { branch: "feat/about", built: true, sections: [{ name: "About", node: "10:700", route: "/preview/about", built: true }] } },
      ],
    }, null, 1),
  );

  const caps = (name, { before = true } = {}) =>
    WIDTHS.map((w) => ({ width: w, ...(before ? { before: `captures/${name}-before-${w}.svg` } : {}), after: `captures/${name}-after-${w}.svg`, figma: `captures/${name}-figma-${w}.svg` }));
  const previews = (port, route) => [{ label: route, url: `http://localhost:${port}${route}` }];
  const result = {
    summary: "Pricing and Careers built, your pre-built About page updated. One comment needs the designer, one needs you, the FAQ failed its checks.",
    items: [
      {
        item_id: ids.pricing, outcome: "applied", change_kind: "redesign",
        verdict: "Pricing rebuilt with three plans and the billing toggle.",
        branch: "figma/pricing", commits: ["a41c9e07b2", "c90d1e3f55"], worktree: "~/Projects/acme-site-fp-pricing",
        preview: previews(3011, "/preview/pricing"), captures: caps("pricing"),
        decisions: [{ text: "Mobile says 'Pick a plan', desktop says 'Plans that grow with you'.", default_applied: "Desktop copy on every width" }],
        questions: [{ text: "On mobile the heading says 'Pick a plan' and desktop says 'Plans that grow with you'. I used the desktop line everywhere. Should mobile keep its own?", section: "Pricing", layer: "Heading / Mobile" }],
        flags: ["The yearly toggle has no design for the yearly prices."],
        components: [
          { element: "Button", source: "figma_component" },
          { element: "Billing toggle", source: "figma_component" },
          { element: "Plan card", states: "hover and focus", source: "project", used: "the site's card hover and focus ring" },
        ],
      },
      {
        item_id: ids.careers, outcome: "applied", change_kind: "new_page",
        verdict: "Careers page built from the desktop frame, with tablet and mobile layouts.",
        branch: "figma/careers", commits: ["7f2b6d0c18"], worktree: "~/Projects/acme-site-fp-careers",
        preview: previews(3012, "/preview/careers"), captures: caps("careers", { before: false }),
        questions: [{ text: "What should Careers show when there are no open roles?", section: "Careers", layer: "Role list" }],
        flags: ["No empty state for zero open roles.", "Role titles longer than one line are not designed."],
      },
      {
        item_id: ids.trial, outcome: "applied", change_kind: "copy",
        verdict: "Button copy changed on all three plan cards.",
        branch: "figma/pricing", commits: ["e3a7710f4c"],
        text_diff: [
          { where: "Starter card", before: "Start free trial", after: "Start your free trial" },
          { where: "Team card", before: "Start free trial", after: "Start your free trial" },
          { where: "Scale card", before: "Start free trial", after: "Start your free trial" },
        ],
        reply: "Done on all three plan cards. It's on the pricing branch for review.",
      },
      {
        item_id: ids.hero, outcome: "question", change_kind: "motion",
        verdict: "The prototype still has the old 900 ms slide; waiting on the designer.",
        questions: [{ text: "The hero image slide in the prototype is still 900 ms. Did the shorter version get saved, or should I use 500 ms?", section: "Home hero", layer: "Hero / Image" }],
        reply: "I checked the prototype and the image slide still runs 900 ms. Can you confirm the new timing? I'll match it as soon as it's in.",
        flags: ["The hero motion has no reduced-motion version."],
      },
      {
        item_id: ids.testimonials, outcome: "needs_you", change_kind: "none",
        verdict: "Moving testimonials to the CMS needs a content model; kept them in code.",
        decisions: [{ text: "Testimonials from the CMS need a new content type and a migration.", default_applied: "Left them in the content file; nothing changed" }],
        reply: "Moving testimonials into the CMS needs a small content model first. I've passed it to Tony to schedule.",
      },
      {
        item_id: ids.about, outcome: "applied", change_kind: "redesign",
        verdict: "About updated to the new design: a fourth team card and the longer intro line.",
        branch: "figma/about", commits: ["9d03be71aa"], worktree: "~/Projects/acme-site-fp-about",
        preview: previews(3015, "/preview/about"), captures: caps("about"),
        text_diff: [{ where: "Intro under the heading", before: "We build booking tools.", after: "We build booking tools for studios." }],
      },
      {
        item_id: ids.faq, outcome: "failed", change_kind: "redesign",
        verdict: "FAQ accordion failed the type check after one fix round; reverted and saved as a patch.",
        branch: "figma/faq",
      },
    ],
    not_done: [
      { item_id: ids.faq, text: "FAQ: typecheck still failed after the fix round (Accordion.vue, prop 'open' typed twice).", patch: "patches/faq.patch" },
      { text: "Motion for the hero waits for the designer's answer." },
    ],
    checks: [
      { name: "npm run lint", status: "pass" },
      { name: "npm run typecheck", status: "pass", detail: "after the FAQ revert" },
      { name: "Regression: / at 1440, 1024, 390", status: "pass", detail: "shared Button changed; home, pricing and careers checked" },
      { name: "Accessibility: tap targets", status: "fail", detail: "billing toggle is 30 px tall at 390; 44 px recommended" },
    ],
    mcp_calls: 3,
  };
  recordResult({ db, batchId: BATCH, result, batchDir: dir });
  db.run("UPDATE batches SET status = 'done', usd = 6.42, mcp_calls = 3 WHERE id = ?", BATCH);
  db.run("INSERT INTO budget (day, project, mcp_calls, usd, batches, rest_429s) VALUES (?, 'acme', 3, 6.42, 1, 1) ON CONFLICT DO NOTHING", new Date().toISOString().slice(0, 10));
}

// writeSample(outDir) -> { report, index, dir }. Rewrites the sample folder each time.
export function writeSample(outDir) {
  if (existsSync(outDir) && readdirSync(outDir).length && !existsSync(join(outDir, MARKER)))
    throw new Error(`${outDir} is not empty and is not a figpipe sample folder; pick another --out`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, MARKER), "figpipe report --sample writes here and replaces this folder each time\n");
  const prev = process.env.FIGPIPE_HOME;
  process.env.FIGPIPE_HOME = outDir;
  const db = openDb(join(outDir, "state.db"));
  try {
    const dir = join(outDir, "batches", "acme", BATCH);
    mkdirSync(dir, { recursive: true });
    seed(db, dir);
    const report = writeReport(db, BATCH, { projectName: "Acme" });
    return { report, index: join(outDir, "index.html"), dir };
  } finally {
    db.close();
    if (prev === undefined) delete process.env.FIGPIPE_HOME;
    else process.env.FIGPIPE_HOME = prev;
  }
}

export const SAMPLE_BATCH = BATCH;
