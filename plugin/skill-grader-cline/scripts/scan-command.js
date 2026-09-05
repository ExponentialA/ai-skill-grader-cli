#!/usr/bin/env node
// AI Skill Grader — Cline PreToolUse hook logic (Tier 1 action-guard).
//
// Cline can't block a skill from loading, but its PreToolUse hook can cancel a
// tool call. This blocks a shell command that would run a script from a skill
// whose SKILL.md is manipulative. Everything else is allowed (risky-but-not-
// manipulative, inline commands, MCP) — those stay in the read.
//
// FAIL OPEN: any error => allow.
const fs = require("fs");
const path = require("path");

function allow() {
  process.stdout.write(JSON.stringify({ cancel: false }));
  process.exit(0);
}
function block(reason) {
  process.stdout.write(JSON.stringify({ cancel: true, errorMessage: reason }));
  process.exit(0);
}

let checkCommand, blockReason;
try {
  ({ checkCommand, blockReason } = require(path.resolve(__dirname, "../shared/action-guard.js")));
} catch (_error) {
  allow();
}

// Cline's PreToolUse payload carries the tool name + parameters; field shapes
// aren't fully documented, so look for a command string in the likely places.
function commandOf(input) {
  if (!input) return "";
  const hook = input.preToolUse || input.pre_tool_use || null;
  const p =
    (hook && (hook.parameters || hook.tool_input || hook.toolInput || hook.input)) ||
    input.tool_input ||
    input.toolInput ||
    input.parameters ||
    input.input ||
    input;
  if (typeof p === "string") return p;
  return p.command || p.command_line || p.cmd || "";
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    allow();
  }
  const command = commandOf(input);
  if (!command) allow();
  const cwd = (input && input.cwd) || (input && Array.isArray(input.workspaceRoots) && input.workspaceRoots[0]) || process.cwd();
  const hit = checkCommand(command, cwd);
  if (hit) block(blockReason(hit));
  allow();
}

if (require.main === module) main();

module.exports = { main };
