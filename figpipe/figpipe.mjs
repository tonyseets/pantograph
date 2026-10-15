#!/usr/bin/env node
// figpipe: watches Figma for handoffs (ready for dev, mentions, replies), batches them once the
// designer goes quiet, extracts the design over REST, and runs one guarded claude -p session per
// batch. Nothing is pushed, posted or sent; the result is a local report per batch.
// usage: figpipe <command> [args]   (figpipe help lists them; REFERENCE.md has the details)
// No dependencies. Needs Node 22.5 or newer (node:sqlite).

// node:sqlite prints an experimental warning on load; keep every other warning.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  process.stderr.write(`figpipe needs Node 22.5 or newer for node:sqlite; this is ${process.versions.node}\n`);
  process.exit(2);
}

// The guard fails closed: if it cannot load or decide (a broken config, say), the call is denied.
// Claude Code treats any exit other than 2 as "allowed with an error".
const guard = process.argv[2] === "guard";
try {
  const { main } = await import("./lib/cli.mjs");
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(guard ? `figpipe guard: ${e.message}; denied\n` : `${e.message}\n`);
  process.exitCode = guard ? 2 : 1;
}
