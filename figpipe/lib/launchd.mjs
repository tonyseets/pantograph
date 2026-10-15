// launchd: a plist template and the commands to install or remove it. figpipe never runs them;
// Tony does, after reading them. The job only wakes `figpipe tick` every few minutes; which
// project is due, and when, is decided by tick from each project's [schedule] (lib/schedule.mjs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, userInfo } from "node:os";
import { paths, FIGPIPE_BIN } from "./paths.mjs";

export const label = (user = userInfo().username) => `com.${user.replace(/[^A-Za-z0-9-]/g, "")}.figpipe`;
const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// PATH for the agent: node, claude, git and terminal-notifier live outside launchd's default PATH.
export function agentPath(nodeBin = process.execPath) {
  const dirs = [dirname(nodeBin), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), ".claude/local"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs)].join(":");
}

export function plist({ minutes = 15, nodeBin = process.execPath, home = paths().home } = {}) {
  const l = label();
  const env = { PATH: agentPath(nodeBin), FIGPIPE_HOME: home };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(l)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(nodeBin)}</string>
    <string>${x(FIGPIPE_BIN)}</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>${Math.max(1, Math.round(minutes)) * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${x(k)}</key><string>${x(v)}</string>`).join("\n")}
  </dict>
  <key>StandardOutPath</key><string>${x(join(home, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key><string>${x(join(home, "logs", "tick.log"))}</string>
</dict>
</plist>
`;
}

// Writes the plist under FIGPIPE_HOME (not ~/Library) and returns the commands to run.
export function installPlan(opts = {}) {
  const l = label();
  const dir = join(paths().home, "launchd");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(paths().home, "logs"), { recursive: true });
  const file = join(dir, `${l}.plist`);
  writeFileSync(file, plist(opts));
  const target = `~/Library/LaunchAgents/${l}.plist`;
  return {
    file,
    install: [`launchctl bootout gui/$(id -u)/${l} 2>/dev/null   # only when an older copy is loaded`, `cp '${file}' ${target}`, `launchctl bootstrap gui/$(id -u) ${target}`, `launchctl print gui/$(id -u)/${l} | head -20`],
    uninstall: [`launchctl bootout gui/$(id -u)/${l}`, `rm ${target}`],
  };
}
