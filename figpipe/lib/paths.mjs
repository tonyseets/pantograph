// Where figpipe keeps its state. FIGPIPE_HOME overrides ~/.figpipe (tests use a temp dir).
import { homedir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const expandHome = (p) => (p && p.startsWith("~/") ? homedir() + p.slice(1) : p);

export function paths() {
  const home = expandHome(process.env.FIGPIPE_HOME || "~/.figpipe");
  return {
    home,
    db: join(home, "state.db"),
    projects: join(home, "projects"),
    batches: join(home, "batches"),
    logs: join(home, "logs"),
    pause: join(home, "PAUSE"),
    lock: join(home, "tick.lock"),
    index: join(home, "index.html"),
  };
}

// figpipe's own install location, so generated hooks and prompts point at this copy.
export const FIGPIPE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIGPIPE_BIN = join(FIGPIPE_DIR, "figpipe.mjs");
export const READ_TOOLS = join(FIGPIPE_DIR, "..", "skills", "figma-transpose", "scripts");

// Resolve symlinks (macOS /var -> /private/var) on the deepest part of the path that exists.
export function realish(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  try {
    cur = realpathSync(cur);
  } catch {}
  return join(cur, ...rest);
}
