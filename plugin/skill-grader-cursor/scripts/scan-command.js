#!/usr/bin/env node
// AI Skill Grader — Cursor beforeShellExecution hook (Tier 1 action-guard).
//
// Cursor can't block a skill from loading, but its beforeShellExecution hook can
// deny a command before it runs. This blocks a shell command that would run a
// script from a skill whose SKILL.md is manipulative. Everything else is allowed
// (risky-but-not-manipulative, inline commands, MCP) — those stay in the read.
// Only `deny` is reliably enforced by Cursor — exactly right for the grader,
// which only ever tightens, never loosens.
//
// FAIL OPEN: any error => allow.
const fs = require("fs");
const path = require("path");

function allow() {
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ permission: "deny", user_message: reason, agent_message: reason }));
  process.exit(0);
}

let checkCommand, blockReason;
try {
  ({ checkCommand, blockReason } = require(path.resolve(__dirname, "../shared/action-guard.js")));
} catch (_error) {
  allow();
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    allow();
  }
  const command = (input && input.command) || "";
  if (!command) allow();
  const cwd = (input && input.cwd) || process.cwd();
  const hit = checkCommand(command, cwd);
  if (hit) deny(blockReason(hit));
  allow();
}

main();
