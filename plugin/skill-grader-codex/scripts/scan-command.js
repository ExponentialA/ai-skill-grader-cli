#!/usr/bin/env node
// AI Skill Grader — Codex PreToolUse hook (Tier 1 action-guard).
//
// Codex can't block a skill from loading, but it can block a tool call before it
// runs. This blocks a shell command that would run a script from a skill whose
// SKILL.md is manipulative — enforcing the ⛔ verdict at action time. Everything
// else (risky-but-not-manipulative skills, inline commands, MCP calls) is allowed
// here; those stay in the read's disclosure.
//
// FAIL OPEN: any error => allow. A safety tool must never break the session.
const fs = require("fs");
const path = require("path");

function allow() {
  process.exit(0);
}
function block(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    })
  );
  process.exit(0);
}

let checkCommand, blockReason;
try {
  ({ checkCommand, blockReason } = require(path.resolve(__dirname, "../shared/action-guard.js")));
} catch (_error) {
  allow();
}

function commandOf(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput === "string") return toolInput;
  return toolInput.command || toolInput.command_line || toolInput.cmd || "";
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    allow();
  }
  const command = commandOf(input && input.tool_input);
  if (!command) allow(); // not a shell command we can inspect
  const cwd = (input && input.cwd) || process.cwd();
  const hit = checkCommand(command, cwd);
  if (hit) block(blockReason(hit));
  allow();
}

main();
