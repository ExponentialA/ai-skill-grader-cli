#!/usr/bin/env node
// AI Skill Grader — Windsurf pre_run_command hook (Tier 1 action-guard).
//
// Windsurf can't surface a read (no session-start, no context channel), so the
// other adapters' read experience can't run here — but its pre_run_command hook
// CAN block a command before it runs (exit code 2). This blocks a shell command
// that would run a script from a skill whose SKILL.md is manipulative. This is
// Windsurf's only in-session grader; everything else stays report-only.
//
// Windsurf hooks communicate via exit codes; a blocking reason goes to stderr,
// which the Cascade agent sees. FAIL OPEN: any error => exit 0 (allow).
const fs = require("fs");
const path = require("path");

let checkCommand, blockReason;
try {
  ({ checkCommand, blockReason } = require(path.resolve(__dirname, "../shared/action-guard.js")));
} catch (_error) {
  process.exit(0);
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    process.exit(0);
  }
  const info = (input && input.tool_info) || input || {};
  const command = info.command_line || info.command || "";
  if (!command) process.exit(0);
  const cwd = info.cwd || process.cwd();
  const hit = checkCommand(command, cwd);
  if (hit) {
    process.stderr.write(blockReason(hit) + "\n");
    process.exit(2); // block
  }
  process.exit(0);
}

main();
