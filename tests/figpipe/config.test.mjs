// Config: TOML subset, schema defaults, refusals that name the field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseToml } from "../../figpipe/lib/toml.mjs";
import { parseConfig, ConfigError } from "../../figpipe/lib/config.mjs";
import { FIX } from "./helpers.mjs";

const tern = () => readFileSync(`${FIX}/tern.toml`, "utf8").replace("__REPO__", "/tmp/tern");
const refused = (text) => {
  try {
    parseConfig(text, "t.toml");
  } catch (e) {
    assert.ok(e instanceof ConfigError, e.message);
    return e.errors.join("\n");
  }
  assert.fail("config was accepted");
};

test("TOML subset: tables, arrays of tables, inline tables, arrays, escapes, comments", () => {
  const t = parseToml(`
# comment
a = "x # not a comment"  # comment
b = 'lit\\eral'
c = [1, 2,
  3, # inside
]
d = { e = true, "f g" = 1.5, h = { i = -2 } }
[t.u]
v = "\\u00e9\\n"
[[arr]]
k = 1
[[arr]]
k = 2
[arr.sub]
z = 1_000
`);
  assert.deepEqual(t, { a: "x # not a comment", b: "lit\\eral", c: [1, 2, 3], d: { e: true, "f g": 1.5, h: { i: -2 } }, t: { u: { v: "é\n" } }, arr: [{ k: 1 }, { k: 2, sub: { z: 1000 } }] });
});

test("TOML errors carry line numbers and refuse what the subset does not read", () => {
  assert.throws(() => parseToml('a = 1\na = 2'), /line 2: duplicate key "a"/);
  assert.throws(() => parseToml("d = 2026-10-02"), /dates are not supported/);
  assert.throws(() => parseToml('s = """x"""'), /multi-line strings/);
  assert.throws(() => parseToml("x = bare"), /strings need quotes/);
  assert.throws(() => parseToml("[a]\n[a]"), /defined twice/);
});

test("the Tern config validates and fills defaults", () => {
  const c = parseConfig(tern(), "tern.toml");
  assert.equal(c.project.autonomy, "build");
  assert.equal(c.batching.poll_minutes, 10);
  assert.equal(c.models.review, "opus:medium");
  assert.equal(c.figma.files[0].ready_depth, 2);
  assert.equal(c.extract.max_renders_per_item, 24);
  assert.deepEqual(c.review.widths, [1440, 1024, 390]);
});

test("refusals name the failing field", () => {
  assert.match(refused(tern().replace('autonomy = "build"', 'autonomy = "yolo"')), /project\.autonomy: "yolo" is not one of/);
  assert.match(refused(tern().replace("[limits]", "[limits]\nusd_per_batchh = 3")), /limits\.usd_per_batchh: unknown setting/);
  assert.match(refused(tern() + '\n[models]\nbuild = "haiku"\n'), /models\.build: Haiku and Fable are not used/);
  assert.match(refused(tern() + '\n[models]\nreview = "claude-fable-5-1"\n'), /models\.review: Haiku and Fable/);
  assert.match(refused(tern().replace('dev = "npx nuxt dev --port {port}"', 'dev = "npx nuxt dev"')), /stack\.dev: must contain \{port\}/);
  assert.match(refused(tern().replace('"npm *", "npx *"', '"git push*", "npx *"')), /allowed_bash: may not allow any push/);
  assert.match(refused(tern().replace("pipeline_share = 120", "pipeline_share = 500")), /pipeline_share: larger than daily_cap/);
  assert.match(refused(tern().replace('pat_ref = "env:FIGPIPE_TEST_TOKEN"', 'pat_ref = "figd_abc"')), /figma\.pat_ref: "figd_abc" is not valid/);
});

test("the shipped example is valid", () => {
  const c = parseConfig(readFileSync(new URL("../../figpipe/templates/project.example.toml", import.meta.url), "utf8"), "example");
  assert.equal(c.project.slug, "acme");
});

test("display name: project.name, else the slug in words", async () => {
  const { displayName } = await import("../../figpipe/lib/config.mjs");
  assert.equal(displayName({ project: { slug: "tern-website", name: "" } }), "Tern website");
  assert.equal(displayName({ project: { slug: "tern-website", name: "Tern" } }), "Tern");
  assert.equal(displayName("tern-website"), "Tern website");
});
