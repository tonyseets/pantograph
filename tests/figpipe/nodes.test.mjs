// Pure node helpers against the recorded Tern node JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, SMALL, PAGE } from "./helpers.mjs";
import { docOf, devStatusNodes, extractCopy, copyBySection, flatLines, diffLines, unifiedDiff, changedLineCount, shapeFingerprint, fingerprint, parseFigmaUrl, slugify } from "../../skills/figma-transpose/scripts/figma-nodes.mjs";

const small = () => docOf(load("nodes-small.json"), SMALL);

test("Figma links: design, file, branch, node ids and comment fragments", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/Tn7LiveDemoKey0q2Wx4Yz/Tern?node-id=40000210-73780&t=x"), { fileKey: "Tn7LiveDemoKey0q2Wx4Yz", mainKey: "Tn7LiveDemoKey0q2Wx4Yz", branchKey: null, nodeId: "40000210:73780", commentId: null });
  assert.equal(parseFigmaUrl("https://figma.com/file/AAA111bbb222/branch/BBB333ccc444/y?node-id=1-2").fileKey, "BBB333ccc444");
  assert.equal(parseFigmaUrl("https://www.figma.com/design/AAA111bbb222/x?node-id=1-2#1951152739").commentId, "1951152739");
  assert.equal(parseFigmaUrl("https://evil.example/design/AAA111bbb222/x"), null);
  assert.equal(parseFigmaUrl("not a url"), null);
});

test("ready-for-dev scan finds the recorded sections with their ancestry", () => {
  const page = docOf(load("nodes-page-d2.json"), PAGE);
  const ready = devStatusNodes(page).filter((r) => r.status === "READY_FOR_DEV");
  assert.equal(ready.length, 10);
  const hiw = ready.find((r) => r.name === "How it works");
  assert.equal(hiw.depth, 2);
  assert.deepEqual(hiw.path, ["Membership"]);
  assert.equal(hiw.top.name, "Membership");
});

test("copy is verbatim, in document order, hidden layers skipped", () => {
  const doc = small();
  const copy = extractCopy(doc);
  assert.equal(copy[0].text, "More than a home check.\nA plan for a warmer home.");
  const hiddenRoot = structuredClone(doc);
  hiddenRoot.children[0].visible = false;
  assert.ok(extractCopy(hiddenRoot).length < copy.length);
  const sections = copyBySection(hiddenRoot);
  assert.equal(sections[0].hidden, true);
  assert.deepEqual(sections[0].copy, []);
});

test("structural diff shows a copy edit as one changed pair", () => {
  const a = small();
  const b = structuredClone(a);
  const t = (function find(n) {
    if (n.type === "TEXT") return n;
    for (const c of n.children ?? []) {
      const r = find(c);
      if (r) return r;
    }
  })(b);
  t.characters = "More than a home check.";
  const d = unifiedDiff(flatLines(a), flatLines(b));
  assert.equal(changedLineCount(d), 2);
  assert.match(d, /^-.*A plan for a warmer home/m);
  assert.equal(unifiedDiff(flatLines(a), flatLines(structuredClone(a))), "");
});

test("line diff matches a simple reference on random inputs", () => {
  const rnd = (n) => Array.from({ length: n }, () => "abcde"[Math.floor(Math.random() * 5)]);
  for (let i = 0; i < 200; i++) {
    const a = rnd(Math.floor(Math.random() * 12));
    const b = rnd(Math.floor(Math.random() * 12));
    const d = diffLines(a, b);
    assert.deepEqual(d.filter((x) => x.op !== "+").map((x) => x.line), a, "removing + lines gives a");
    assert.deepEqual(d.filter((x) => x.op !== "-").map((x) => x.line), b, "removing - lines gives b");
    // LCS length is optimal: compare with a plain DP.
    const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
    for (let x = a.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) dp[x][y] = a[x] === b[y] ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
    assert.equal(d.filter((x) => x.op === " ").length, dp[0][0]);
  }
});

test("shape fingerprint ignores canvas position, catches real edits", () => {
  const a = small();
  const moved = structuredClone(a);
  (function shift(n) {
    if (n.absoluteBoundingBox) n.absoluteBoundingBox.y += 1000;
    if (n.absoluteRenderBounds) n.absoluteRenderBounds.y += 1000;
    (n.children ?? []).forEach(shift);
  })(moved);
  assert.equal(shapeFingerprint(moved), shapeFingerprint(a));
  assert.notEqual(fingerprint(moved), fingerprint(a));
  const edited = structuredClone(a);
  edited.children[0].name = "Viewport Height v2";
  assert.notEqual(shapeFingerprint(edited), shapeFingerprint(a));
});

test("slugs for branch and folder names", () => {
  assert.equal(slugify("How it works"), "how-it-works");
  assert.equal(slugify("Offer Funnel_GER"), "offer-funnel-ger");
  assert.equal(slugify("Zoë's ✨ page"), "zoe-s-page");
  assert.equal(slugify(""), "untitled");
});
