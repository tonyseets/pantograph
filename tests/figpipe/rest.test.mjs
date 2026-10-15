// The shared REST client: GET only, 429 backoff, no token leaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, download, FigmaError } from "../../skills/figma-transpose/scripts/figma-rest.mjs";

const TOKEN = "figd_test_token_value_123456";
function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status, ok: r.status < 300, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, text: async () => r.body ?? "{}" };
  };
  return { calls, fetchImpl };
}
const waits = () => {
  const w = [];
  const sleep = async (s) => w.push(s);
  return { w, sleep };
};

test("429 waits Retry-After and defaults to 30 s without it", async () => {
  const { calls, fetchImpl } = scripted([
    { status: 429, headers: { "Retry-After": "7" } },
    { status: 429 },
    { status: 429, headers: { "Retry-After": "120" } },
    { status: 200, body: '{"file":{"name":"x"}}' },
  ]);
  const { w, sleep } = waits();
  const events = [];
  const c = createClient({ token: TOKEN, fetchImpl, sleep, onEvent: (e) => events.push(e) });
  const r = await c.meta("KEY");
  assert.equal(r.file.name, "x");
  assert.deepEqual(w, [7, 30, 120]);
  assert.equal(events.filter((e) => e.type === "rate_limited").length, 3);
  assert.ok(calls.every((x) => x.init.method === "GET"));
  assert.equal(calls[0].url, "https://api.figma.com/v1/files/KEY/meta");
});

test("a 429 asking for longer than the cap is not retried; the error carries the wait", async () => {
  const { calls, fetchImpl } = scripted([{ status: 429, headers: { "Retry-After": "86400" } }, { status: 200, body: "{}" }]);
  const { w, sleep } = waits();
  const c = createClient({ token: TOKEN, fetchImpl, sleep });
  await assert.rejects(c.meta("KEY"), (e) => e instanceof FigmaError && e.kind === "rate_limit" && e.retry_after_s === 86400 && /wait 24 h/.test(e.message));
  assert.equal(calls.length, 1, "one request, no retries");
  assert.deepEqual(w, [], "no sleeping through a day-long wait");
});

test("a 429 that outlasts the attempts throws a rate_limit error", async () => {
  const { fetchImpl } = scripted(Array.from({ length: 3 }, () => ({ status: 429 })));
  const { sleep } = waits();
  const c = createClient({ token: TOKEN, fetchImpl, sleep, maxAttempts: 3 });
  await assert.rejects(c.comments("KEY"), (e) => e instanceof FigmaError && e.kind === "rate_limit");
});

test("403 is an auth error, not retried, and never carries the token", async () => {
  const { calls, fetchImpl } = scripted([{ status: 403, body: '{"status":403,"err":"Invalid token"}' }]);
  const c = createClient({ token: TOKEN, fetchImpl, sleep: async () => {} });
  await assert.rejects(c.me(), (e) => e.kind === "auth" && e.status === 403 && !e.message.includes(TOKEN));
  assert.equal(calls.length, 1);
});

test("query strings join ids and skip empty values", async () => {
  const { calls, fetchImpl } = scripted([{ status: 200 }]);
  const c = createClient({ token: TOKEN, fetchImpl });
  await c.nodes("KEY", ["1:2", "3:4"], { depth: 2 });
  assert.equal(calls[0].url, "https://api.figma.com/v1/files/KEY/nodes?ids=1%3A2%2C3%3A4&depth=2");
});

test("image downloads never send the Figma token", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push(init), { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync((await import("node:os")).tmpdir() + "/dl-");
  const n = await download("https://example.invalid/x.png", `${dir}/x.png`, { fetchImpl });
  assert.equal(n, 3);
  assert.ok(!seen[0].headers, "no headers at all on storage downloads");
});

test("the client has no write methods", () => {
  const c = createClient({ token: TOKEN, fetchImpl: async () => {} });
  for (const k of Object.keys(c)) assert.ok(!/post|put|patch|delete|create|update|write/i.test(k), k);
});
