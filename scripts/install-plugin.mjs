#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Where this code is running from (a repo clone, an `npx` cache, or an installed
// npm package). We copy the runtime out of here into a permanent home so the
// hooks keep working after the temp/cache copy is gone.
const sourceRoot = path.resolve(here, "..");
const home = os.homedir();
// The permanent home the installed hooks point at, independent of how the
// installer was fetched. `install.sh` clones straight here (source === install,
// no copy); `npx` runs from a cache, so we copy the runtime in.
const installRoot = process.env.AI_SKILL_GRADER_DIR || path.join(home, ".ai-skill-grader");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// Absolute path to the Node that ran this installer. GUI editors (Cursor,
// Windsurf) are launched from the Dock/Finder and often don't inherit an
// nvm/homebrew PATH, so a bare `node` in a hook command silently fails to start
// — and a hook that never runs means the grader silently isn't protecting the
// user. Writing the absolute node path makes the hook fire regardless of PATH.
const nodeBin = process.execPath;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const yes = args.has("--yes") || args.has("-y");
const all = args.has("--all");
const uninstall = args.has("--uninstall") || args.has("uninstall");

const knownTools = ["codex", "claude", "cursor", "cline", "windsurf"];
const rawArgs = process.argv.slice(2);
const requested = knownTools.filter((tool) => args.has(`--${tool}`) || rawArgs.includes(tool));
const tools = requested.length ? requested : all ? [...knownTools] : uninstall ? [...knownTools] : detectTools();

function log(message = "") {
  process.stdout.write(`${message}\n`);
}

function usage() {
  log(`AI Skill Grader installer

Install:
  npx ai-skill-grader codex
  npx ai-skill-grader --all
Uninstall:
  npx ai-skill-grader uninstall cursor

Tools: codex, claude, cursor, cline, windsurf

Options:
  --dry-run   Show what would change without writing files.
  --yes       Skip the confirmation prompt.
  --all       Every supported tool.
`);
}

function detectTools() {
  const found = [];
  // Note: ~/.agents is the cross-agent convention shared by several tools, so it
  // is NOT a reliable signal for Codex specifically — require the codex CLI or
  // ~/.codex instead.
  if (commandExists("codex") || exists(path.join(home, ".codex"))) found.push("codex");
  if (commandExists("claude") || exists(path.join(home, ".claude"))) found.push("claude");
  if (exists(path.join(home, ".cursor"))) found.push("cursor");
  if (process.platform !== "win32" && exists(path.join(home, "Documents", "Cline"))) found.push("cline");
  if (exists(path.join(home, ".codeium", "windsurf"))) found.push("windsurf");
  return found;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  const result = childProcess.spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function ensureDir(dir) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function backupPath(file) {
  return `${file}.bak-${stamp}`;
}

function backupIfExists(file) {
  if (!exists(file)) return null;
  const backup = backupPath(file);
  if (!dryRun) fs.cpSync(file, backup, { recursive: true });
  return backup;
}

function readJson(file, fallback) {
  if (!exists(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON (${error.message}). ` +
        `Left it untouched — fix it or move it aside, then re-run the installer.`
    );
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const backup = backupIfExists(file);
  if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return backup;
}

function upsertHookList(config, hookName, entry) {
  config.hooks = config.hooks && typeof config.hooks === "object" ? config.hooks : {};
  const list = Array.isArray(config.hooks[hookName]) ? config.hooks[hookName] : [];
  const withoutDuplicate = list.filter((item) => item && item.command !== entry.command);
  config.hooks[hookName] = [...withoutDuplicate, entry];
}

// Drop only our own hook entries (their command references a skill-grader path),
// leaving every other hook the user has untouched. Returns true if anything went.
function removeOurHooks(config) {
  if (!config || typeof config.hooks !== "object" || !config.hooks) return false;
  let changed = false;
  for (const [name, list] of Object.entries(config.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((item) => !(item && typeof item.command === "string" && /skill-grader/.test(item.command)));
    if (kept.length !== list.length) {
      config.hooks[name] = kept;
      changed = true;
    }
  }
  return changed;
}

function copyDir(src, dest) {
  ensureDir(path.dirname(dest));
  const backup = backupIfExists(dest);
  if (!dryRun) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  return backup;
}

// Copy the runtime the hooks depend on (plugins + engine + report script) into
// the permanent install home, mirroring the repo layout so the relative requires
// (`../../shared`, `../../../product-surface/lib`) still resolve. Skipped when the
// installer is already running from the install home (the install.sh path).
function syncRuntime() {
  if (path.resolve(sourceRoot) === path.resolve(installRoot)) return;
  const parts = [
    ["plugin"],
    ["product-surface", "lib"],
    ["scripts"],
  ];
  if (dryRun) {
    log(`Would copy the runtime into ${installRoot}.`);
    return;
  }
  for (const rel of parts) {
    const src = path.join(sourceRoot, ...rel);
    if (!exists(src)) continue;
    const dest = path.join(installRoot, ...rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  // Restore the executable bit on the Cline hook wrappers (cpSync can drop it).
  for (const name of ["TaskStart", "PreToolUse"]) {
    const f = path.join(installRoot, "plugin", "skill-grader-cline", "hooks", name);
    if (exists(f)) fs.chmodSync(f, 0o755);
  }
  log(`Runtime installed in ${installRoot}.`);
}

function reportSkillBody() {
  const reportScript = path.join(installRoot, "scripts", "report-installed.js");
  return `---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo. Use whenever the user asks for the full report, a deep report, or to grade a skill they named or pasted a GitHub link to.
---

The user wants the full AI Skill Grader report on a skill or repo.

Run this command and show the user its output **verbatim**:

\`\`\`bash
"${nodeBin}" "${reportScript}" "<skill name or GitHub URL>"
\`\`\`

Replace \`<skill name or GitHub URL>\` with what the user gave you.

- An already-graded skill returns the full report instantly.
- A brand-new one returns the fast preview with a note that the deep grade takes a few minutes.
`;
}

function installReportSkill(destRoot) {
  const skillDir = path.join(destRoot, "skill-grader-report");
  const skill = reportSkillBody();
  ensureDir(skillDir);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (exists(skillFile) && fs.readFileSync(skillFile, "utf8") === skill) return null;
  const backup = backupIfExists(skillFile);
  if (!dryRun) fs.writeFileSync(skillFile, skill);
  return backup;
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  const backup = backupIfExists(file);
  if (!dryRun) fs.writeFileSync(file, text);
  return backup;
}

function removeIfExists(target) {
  if (dryRun || !exists(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function symlinkFile(src, dest) {
  ensureDir(path.dirname(dest));
  let backup = null;
  if (exists(dest)) {
    const stat = fs.lstatSync(dest);
    const pointsHere = stat.isSymbolicLink() && path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === src;
    if (pointsHere) return { backup: null, unchanged: true };
    backup = backupPath(dest);
    if (!dryRun) fs.renameSync(dest, backup);
  }
  if (!dryRun) fs.symlinkSync(src, dest);
  return { backup, unchanged: false };
}

function removeOurSymlink(dest) {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink() && /skill-grader/.test(fs.readlinkSync(dest))) {
      if (!dryRun) fs.rmSync(dest);
      return true;
    }
  } catch {
    /* not there */
  }
  return false;
}

function codexMarketplaceWithPlugin(existing, pluginPath) {
  const plugin = {
    name: "skill-grader",
    source: { source: "local", path: pluginPath },
  };
  const market = {
    name: "skill-grader-local",
    interface: { displayName: "AI Skill Grader" },
    plugins: [plugin],
  };

  if (Array.isArray(existing)) {
    return [...existing.filter((item) => item && item.name !== market.name), market];
  }
  if (existing && Array.isArray(existing.marketplaces)) {
    return {
      ...existing,
      marketplaces: [...existing.marketplaces.filter((item) => item && item.name !== market.name), market],
    };
  }
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const plugins = Array.isArray(base.plugins) ? base.plugins.filter((item) => item && item.name !== plugin.name) : [];
  return {
    name: base.name || market.name,
    interface: base.interface || market.interface,
    ...base,
    plugins: [...plugins, plugin],
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
function installCodex() {
  const pluginPath = path.join(installRoot, "plugin", "skill-grader-codex");
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  const current = readJson(marketplace, {});
  const next = codexMarketplaceWithPlugin(current, pluginPath);
  const backup = writeJson(marketplace, next);
  log(`Codex: ${dryRun ? "would add" : "added"} AI Skill Grader to ${marketplace}${backup ? ` (backup: ${backup})` : ""}.`);

  if (commandExists("codex") && !dryRun) {
    const result = childProcess.spawnSync("codex", ["plugin", "add", "skill-grader@skill-grader-local"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      log("Codex: installed plugin with `codex plugin add skill-grader@skill-grader-local`.");
    } else {
      log("Codex: marketplace entry is ready. Finish with:");
      log("  codex plugin add skill-grader@skill-grader-local");
    }
  } else {
    log("Codex: finish with:");
    log("  codex plugin add skill-grader@skill-grader-local");
  }
}

function installClaude() {
  const pluginPath = path.join(installRoot, "plugin", "skill-grader");
  log(`Claude Code: plugin files ${dryRun ? "would be ready" : "are ready"}. Finish inside Claude Code with:`);
  log(`  /plugin install ${pluginPath}`);
}

function installCursor() {
  const pluginPath = path.join(installRoot, "plugin", "skill-grader-cursor");
  const hooksFile = path.join(home, ".cursor", "hooks.json");
  const config = readJson(hooksFile, { version: 1, hooks: {} });
  config.version = config.version || 1;
  upsertHookList(config, "sessionStart", {
    type: "command",
    command: `"${nodeBin}" "${path.join(pluginPath, "scripts", "scan-session.js")}"`,
    timeout: 15,
  });
  upsertHookList(config, "beforeShellExecution", {
    type: "command",
    command: `"${nodeBin}" "${path.join(pluginPath, "scripts", "scan-command.js")}"`,
    timeout: 10,
  });
  const backup = writeJson(hooksFile, config);
  writeText(path.join(home, ".cursor", "skill-grader-root"), `${pluginPath}\n`);
  copyDir(path.join(pluginPath, "skills", "skill-grader-report"), path.join(home, ".cursor", "skills", "skill-grader-report"));
  log(`Cursor: ${dryRun ? "would install" : "installed"} hooks in ${hooksFile}${backup ? ` (backup: ${backup})` : ""}. Restart Cursor if it does not pick them up.`);
}

function installCline() {
  if (process.platform === "win32") {
    log("Cline: hooks aren't supported on Windows — skipping.");
    return;
  }
  const pluginPath = path.join(installRoot, "plugin", "skill-grader-cline");
  const hooksDir = path.join(home, "Documents", "Cline", "Rules", "Hooks");
  if (!dryRun) {
    fs.chmodSync(path.join(pluginPath, "hooks", "TaskStart"), 0o755);
    fs.chmodSync(path.join(pluginPath, "hooks", "PreToolUse"), 0o755);
  }
  const task = symlinkFile(path.join(pluginPath, "hooks", "TaskStart"), path.join(hooksDir, "TaskStart"));
  const pre = symlinkFile(path.join(pluginPath, "hooks", "PreToolUse"), path.join(hooksDir, "PreToolUse"));
  writeText(path.join(home, ".skill-grader-cline", "skill-grader-root"), `${pluginPath}\n`);
  installReportSkill(path.join(home, ".agents", "skills"));
  const backups = [task.backup, pre.backup].filter(Boolean);
  log(`Cline: ${dryRun ? "would install" : "installed"} hooks in ${hooksDir}${backups.length ? ` (backups: ${backups.join(", ")})` : ""}. Make sure hooks are enabled in Cline settings.`);
}

function installWindsurf() {
  const pluginPath = path.join(installRoot, "plugin", "skill-grader-windsurf");
  const hooksFile = path.join(home, ".codeium", "windsurf", "hooks.json");
  const config = readJson(hooksFile, { hooks: {} });
  upsertHookList(config, "pre_run_command", {
    command: `"${nodeBin}" "${path.join(pluginPath, "scripts", "scan-command.js")}"`,
    show_output: true,
  });
  const backup = writeJson(hooksFile, config);
  writeText(path.join(home, ".skill-grader-windsurf", "skill-grader-root"), `${pluginPath}\n`);
  installReportSkill(path.join(home, ".agents", "skills"));
  log(`Windsurf: ${dryRun ? "would install" : "installed"} command check in ${hooksFile}${backup ? ` (backup: ${backup})` : ""}.`);
}

// ---------------------------------------------------------------------------
// Uninstall — remove only what we added, back up any file we rewrite.
// ---------------------------------------------------------------------------
function uninstallHooksFile(hooksFile, label) {
  if (!exists(hooksFile)) {
    log(`${label}: nothing to remove.`);
    return;
  }
  const config = readJson(hooksFile, null);
  if (config && removeOurHooks(config)) {
    const backup = writeJson(hooksFile, config);
    log(`${label}: ${dryRun ? "would remove" : "removed"} the grader's hooks from ${hooksFile}${backup ? ` (backup: ${backup})` : ""}.`);
  } else {
    log(`${label}: no grader hooks found in ${hooksFile}.`);
  }
}

function uninstallCodex() {
  const marketplace = path.join(home, ".agents", "plugins", "marketplace.json");
  if (exists(marketplace)) {
    const current = readJson(marketplace, null);
    if (current && Array.isArray(current.plugins)) {
      const kept = current.plugins.filter((p) => p && p.name !== "skill-grader");
      if (kept.length !== current.plugins.length) writeJson(marketplace, { ...current, plugins: kept });
    } else if (current && Array.isArray(current.marketplaces)) {
      writeJson(marketplace, { ...current, marketplaces: current.marketplaces.filter((m) => m && m.name !== "skill-grader-local") });
    } else if (Array.isArray(current)) {
      writeJson(marketplace, current.filter((m) => m && m.name !== "skill-grader-local"));
    }
  }
  if (commandExists("codex") && !dryRun) {
    childProcess.spawnSync("codex", ["plugin", "remove", "skill-grader"], { stdio: "ignore" });
  }
  log(`Codex: ${dryRun ? "would remove" : "removed"} the grader. If it lingers, run: codex plugin remove skill-grader`);
}

function uninstallClaude() {
  log("Claude Code: remove it from inside Claude Code with:");
  log("  /plugin uninstall skill-grader");
}

function uninstallCursor() {
  uninstallHooksFile(path.join(home, ".cursor", "hooks.json"), "Cursor");
  removeIfExists(path.join(home, ".cursor", "skill-grader-root"));
  removeIfExists(path.join(home, ".cursor", "skills", "skill-grader-report"));
}

function uninstallCline() {
  const hooksDir = path.join(home, "Documents", "Cline", "Rules", "Hooks");
  const a = removeOurSymlink(path.join(hooksDir, "TaskStart"));
  const b = removeOurSymlink(path.join(hooksDir, "PreToolUse"));
  removeIfExists(path.join(home, ".skill-grader-cline"));
  removeIfExists(path.join(home, ".agents", "skills", "skill-grader-report"));
  log(`Cline: ${dryRun ? "would remove" : a || b ? "removed" : "found no"} grader hooks in ${hooksDir}.`);
}

function uninstallWindsurf() {
  uninstallHooksFile(path.join(home, ".codeium", "windsurf", "hooks.json"), "Windsurf");
  removeIfExists(path.join(home, ".skill-grader-windsurf"));
  removeIfExists(path.join(home, ".agents", "skills", "skill-grader-report"));
}

function confirm(action) {
  if (dryRun || yes) return Promise.resolve(true);
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(true);
  return new Promise((resolve) => {
    process.stdout.write(`${action}? [y/N] `);
    process.stdin.once("data", (data) => resolve(/^y(es)?$/i.test(String(data).trim())));
  });
}

async function main() {
  if (args.has("--help") || args.has("-h")) {
    usage();
    return;
  }
  if (!tools.length) {
    log("I could not detect an installed agent. Choose one explicitly:");
    usage();
    process.exitCode = 1;
    return;
  }

  log(`AI Skill Grader ${uninstall ? "uninstaller" : "installer"}`);
  log(`Home: ${installRoot}`);
  log(`Tools: ${tools.join(", ")}`);
  if (dryRun) log("Dry run: no files will be changed.");
  if (!(await confirm(uninstall ? "Uninstall" : "Proceed"))) {
    log("Canceled.");
    return;
  }

  if (uninstall) {
    const removers = { codex: uninstallCodex, claude: uninstallClaude, cursor: uninstallCursor, cline: uninstallCline, windsurf: uninstallWindsurf };
    for (const tool of tools) {
      log("");
      removers[tool]();
    }
    log("");
    log(`The grader's files remain in ${installRoot}. Remove that folder to delete them fully.`);
    return;
  }

  syncRuntime();
  const installers = { codex: installCodex, claude: installClaude, cursor: installCursor, cline: installCline, windsurf: installWindsurf };
  for (const tool of tools) {
    log("");
    installers[tool]();
  }

  log("");
  log("Done. AI Skill Grader never asks for account credentials or API keys.");
}

main().catch((error) => {
  console.error(`${uninstall ? "Uninstall" : "Install"} failed: ${error.message || error}`);
  process.exitCode = 1;
});
