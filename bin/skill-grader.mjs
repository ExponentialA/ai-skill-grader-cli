#!/usr/bin/env node
// AI Skill Grader CLI — the `npx` entry point.
//
//   npx ai-skill-grader claude         # install for one tool
//   npx ai-skill-grader --all          # install for both
//   npx ai-skill-grader uninstall
//   npx ai-skill-grader report <skill or GitHub URL>
//
// This thin dispatcher runs the real scripts with the same Node that ran it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const [first, ...rest] = argv;

function run(script, scriptArgs) {
  const res = spawnSync(process.execPath, [path.join(root, "scripts", script), ...scriptArgs], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

function help() {
  process.stdout.write(
    [
      "AI Skill Grader",
      "",
      "Install:   npx ai-skill-grader <tool | --all>",
      "Uninstall: npx ai-skill-grader uninstall <tool | --all>",
      "Report:    npx ai-skill-grader report <skill name or GitHub URL>",
      "",
      "Tools: claude, codex",
      "Options: --dry-run, --yes",
      "",
    ].join("\n")
  );
}

if (argv.length === 0 || first === "help" || first === "-h" || first === "--help") {
  help();
} else if (first === "report") {
  run("report-installed.js", rest);
} else if (first === "uninstall") {
  run("install-plugin.mjs", ["uninstall", ...rest]);
} else if (first === "install") {
  run("install-plugin.mjs", rest);
} else {
  // Bare tool names / flags → install, so `npx … codex` just works.
  run("install-plugin.mjs", argv);
}
