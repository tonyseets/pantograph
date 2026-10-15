// Figma REST client: read-only, with 429 backoff. Shared by figma-read.mjs and figpipe.
// Only GET requests exist here. There is no method parameter, so this module cannot write
// to Figma (comments, webhooks, variables) even by mistake.
// No dependencies. Needs Node 18 or newer (global fetch).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { homedir } from "node:os";

export const API = "https://api.figma.com";
export const DEFAULT_TOKEN_REF = "file:~/.config/figma/pat";

export const expandHome = (p) => (p && p.startsWith("~/") ? homedir() + p.slice(1) : p);

// Resolve a token reference to the token. References, never values, live in config:
//   file:<path>        a mode-600 file holding the token
//   keychain:<service> macOS keychain generic password (security find-generic-password -s)
//   op:<op://ref>      1Password CLI (may need an unlock; avoid for unattended runs)
//   env:<VAR>          an environment variable
export function loadToken(ref = DEFAULT_TOKEN_REF) {
  const i = ref.indexOf(":");
  const kind = i > 0 ? ref.slice(0, i) : "";
  const arg = i > 0 ? ref.slice(i + 1) : "";
  let token = "";
  try {
    if (kind === "file") token = readFileSync(expandHome(arg), "utf8");
    else if (kind === "keychain")
      token = execFileSync("security", ["find-generic-password", "-s", arg, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    else if (kind === "op") token = execFileSync("op", ["read", arg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    else if (kind === "env") token = process.env[arg] ?? "";
    else throw new Error(`unknown token reference kind "${kind}" (use file:, keychain:, op: or env:)`);
  } catch (e) {
    throw new FigmaError(`could not read the Figma token from ${ref}: ${e.code ?? e.message}`, { status: 0, kind: "token" });
  }
  token = token.trim();
  if (!token) throw new FigmaError(`the Figma token at ${ref} is empty`, { status: 0, kind: "token" });
  return token;
}

export class FigmaError extends Error {
  constructor(message, { status = 0, kind = "http", path = "", retryable = false } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // http | token | auth | rate_limit | network
    this.path = path;
    this.retryable = retryable;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtWait = (s) => (s < 3600 ? `${Math.ceil(s / 60)} min` : s < 2 * 86400 ? `${Math.round(s / 360) / 10} h` : `${Math.round(s / 8640) / 10} days`);

// Build a query string, skipping undefined values. Arrays join with commas (ids=a,b).
export function qs(query = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// createClient({ token | tokenRef, baseUrl, fetchImpl, backoff: { default_s, max_s }, maxAttempts, sleep, onEvent })
// onEvent receives { type: "rate_limited" | "retry" | "response", path, status, wait_s, rate_limit_type, plan_tier }.
export function createClient(opts = {}) {
  const baseUrl = (opts.baseUrl ?? process.env.FIGMA_API_BASE ?? API).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const backoff = { default_s: 30, max_s: 120, ...(opts.backoff ?? {}) };
  const maxAttempts = opts.maxAttempts ?? 6;
  const sleep = opts.sleep ?? ((s) => sleepMs(s * 1000));
  const onEvent = opts.onEvent ?? (() => {});
  let token = opts.token ?? null;
  const getToken = () => (token ??= loadToken(opts.tokenRef ?? DEFAULT_TOKEN_REF));
  const info = { rate_limit_type: null, plan_tier: null, rate_limited: 0 };

  async function get(path, query) {
    const url = `${baseUrl}${path}${qs(query)}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { method: "GET", headers: { "X-Figma-Token": getToken() } });
      } catch (e) {
        if (e instanceof FigmaError) throw e;
        lastErr = new FigmaError(`network error on GET ${path}: ${e.message}`, { kind: "network", path, retryable: true });
        const wait = Math.min(backoff.default_s / 3, backoff.max_s);
        onEvent({ type: "retry", path, status: 0, wait_s: wait });
        await sleep(wait);
        continue;
      }
      const h = (k) => (res.headers?.get ? res.headers.get(k) : null);
      if (h("x-figma-rate-limit-type")) info.rate_limit_type = h("x-figma-rate-limit-type");
      if (h("x-figma-plan-tier")) info.plan_tier = h("x-figma-plan-tier");
      onEvent({ type: "response", path, status: res.status, rate_limit_type: info.rate_limit_type, plan_tier: info.plan_tier });
      if (res.status === 429) {
        // Some 429s arrive without Retry-After; fall back to the default, always cap.
        const ra = Number.parseInt(h("retry-after") ?? "", 10);
        info.rate_limited += 1;
        // A wait longer than the cap (hours or days on low seat tiers) is not retried: retrying
        // every few minutes only burns the quota. The caller records when to try again.
        if (Number.isFinite(ra) && ra > backoff.max_s) {
          onEvent({ type: "rate_limited", path, status: 429, wait_s: ra, long: true, rate_limit_type: info.rate_limit_type });
          const e = new FigmaError(`Figma rate limit on GET ${path}: it asks to wait ${fmtWait(ra)}`, { status: 429, kind: "rate_limit", path });
          e.retry_after_s = ra;
          throw e;
        }
        const wait = Math.min(Number.isFinite(ra) && ra > 0 ? ra : backoff.default_s, backoff.max_s);
        onEvent({ type: "rate_limited", path, status: 429, wait_s: wait, rate_limit_type: info.rate_limit_type });
        lastErr = new FigmaError(`rate limited on GET ${path}`, { status: 429, kind: "rate_limit", path, retryable: true });
        if (attempt < maxAttempts) await sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        const wait = Math.min(backoff.default_s / 3, backoff.max_s);
        onEvent({ type: "retry", path, status: res.status, wait_s: wait });
        lastErr = new FigmaError(`Figma answered ${res.status} on GET ${path}`, { status: res.status, path, retryable: true });
        if (attempt < maxAttempts) await sleep(wait);
        continue;
      }
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          msg = j.err ?? j.message ?? msg;
        } catch {}
        const kind = res.status === 401 || res.status === 403 ? "auth" : "http";
        throw new FigmaError(`Figma answered ${res.status} on GET ${path}: ${msg}`, { status: res.status, kind, path });
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new FigmaError(`Figma sent a response that is not JSON on GET ${path}`, { status: res.status, path });
      }
    }
    throw lastErr;
  }

  const enc = encodeURIComponent;
  return {
    info,
    get,
    me: () => get("/v1/me"),
    meta: (key) => get(`/v1/files/${enc(key)}/meta`),
    file: (key, { depth, ids } = {}) => get(`/v1/files/${enc(key)}`, { depth, ids }),
    nodes: (key, ids, { depth, geometry } = {}) => get(`/v1/files/${enc(key)}/nodes`, { ids, depth, geometry }),
    comments: (key) => get(`/v1/files/${enc(key)}/comments`),
    versions: (key) => get(`/v1/files/${enc(key)}/versions`),
    images: (key, ids, { scale = 2, format = "png" } = {}) => get(`/v1/images/${enc(key)}`, { ids, scale, format }),
    webhooks: (key) => get("/v2/webhooks", { context: "file", context_id: key }),
    // Where a published library component set lives (its file and node), by the key an instance carries.
    componentSet: (setKey) => get(`/v1/component_sets/${enc(setKey)}`),
  };
}

// Download a rendered image from the signed URL /v1/images returns. The Figma token is never
// sent here: the URL is pre-signed and lives on a storage host, not api.figma.com.
export async function download(url, outPath, { fetchImpl = globalThis.fetch, attempts = 4, sleep = (s) => sleepMs(s * 1000) } = {}) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("empty body");
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      return buf.length;
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(5 * i);
    }
  }
  throw new FigmaError(`download failed for ${outPath}: ${last?.message}`, { kind: "network" });
}

// Render node ids at 2x in chunks (the /images endpoint is Tier 1; small chunks keep each
// call cheap and let one bad node fail alone). Returns { id: path | null }.
export async function renderNodes(client, key, jobs, { scale = 2, format = "png", chunk = 6, fetchImpl, sleep } = {}) {
  const out = {};
  for (let i = 0; i < jobs.length; i += chunk) {
    const part = jobs.slice(i, i + chunk);
    const res = await client.images(key, part.map((j) => j.id), { scale, format });
    for (const j of part) {
      const u = res?.images?.[j.id];
      if (!u) {
        out[j.id] = null;
        continue;
      }
      await download(u, j.path, { fetchImpl, sleep });
      out[j.id] = j.path;
    }
  }
  return out;
}
