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

// Every tool the installer can still install when named explicitly. The other
// three adapters ship in the repo but aren't verified end to end, so they are not
// advertised, auto-detected, or swept by --all — only installed on explicit ask.
const knownTools = ["codex", "claude", "cursor", "cline", "windsurf"];
// The verified, user-facing tools: what we detect, list in help, and --all covers.
const featuredTools = ["codex", "claude"];
const rawArgs = process.argv.slice(2);
const requested = knownTools.filter((tool) => args.has(`--${tool}`) || rawArgs.includes(tool));
// --all installs the verified tools; a bare uninstall still sweeps all five so it
// cleans up any adapter a user installed explicitly before.
const tools = requested.length ? requested : all ? [...featuredTools] : uninstall ? [...knownTools] : detectTools();

function log(message = "") {
  process.stdout.write(`${message}\n`);
}

// A short, one-line reason from a failed spawn, so an auto-install failure tells
// the user WHY instead of silently pointing them at the manual commands.
function spawnFailReason(result) {
  if (!result) return "";
  const text = String(result.stderr || result.stdout || (result.error && result.error.message) || "").trim();
  const firstLine = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  return firstLine.slice(0, 200);
}

function usage() {
  log(`AI Skill Grader installer

Install:
  npx ai-skill-grader claude
  npx ai-skill-grader codex
  npx ai-skill-grader --all
Uninstall:
  npx ai-skill-grader uninstall

Tools: claude, codex

Options:
  --dry-run   Show what would change without writing files.
  --yes       Skip the confirmation prompt.
  --all       Both supported tools.
`);
}

function detectTools() {
  const found = [];
  // Only auto-detect the verified tools. Never auto-install the unadvertised
  // adapters: a user gets those only by naming one explicitly.
  // Note: ~/.agents is the cross-agent convention shared by several tools, so it
  // is NOT a reliable signal for Codex specifically. Require the codex CLI or
  // ~/.codex instead.
  if (commandExists("codex") || exists(path.join(home, ".codex"))) found.push("codex");
  if (commandExists("claude") || exists(path.join(home, ".claude"))) found.push("claude");
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

// Find a tool's CLI even when it isn't on PATH. Desktop/GUI installs of Claude
// Code and Codex bundle the binary under Application Support / ~/.codex, so the
// installer can finish the plugin install itself instead of printing commands
// for the user to paste by hand. Returns a runnable path/name, or null.
function findAgentBinary(tool) {
  if (commandExists(tool)) return tool;
  const candidates = [];
  if (tool === "claude") {
    const base = path.join(home, "Library", "Application Support", "Claude", "claude-code");
    try {
      for (const version of fs.readdirSync(base)) {
        candidates.push(path.join(base, version, "claude.app", "Contents", "MacOS", "claude"));
      }
    } catch {
      /* no desktop install */
    }
  } else if (tool === "codex") {
    candidates.push(path.join(home, ".codex", "plugins", ".plugin-appserver", "codex"));
  }
  const usable = candidates.filter((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  // Newest build first (dir names are versions; fall back to mtime).
  usable.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  return usable[0] || null;
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
        `Left it untouched. Fix it or move it aside, then re-run the installer.`
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
- A new skill returns the fast preview. Do NOT poll, wait, or re-run for a deep report to appear: the deep grade for a new skill is produced on request and delivered by email only. The output tells the user how to get it; show that and stop.
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

function removeWithBackup(target) {
  if (!exists(target)) return null;
  const backup = backupIfExists(target);
  if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
  return backup;
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

function clineHooksInstalled() {
  const hooksDir = path.join(home, "Documents", "Cline", "Hooks");
  return [path.join(hooksDir, "TaskStart"), path.join(hooksDir, "PreToolUse")].some((target) => {
    try {
      const stat = fs.lstatSync(target);
      return stat.isSymbolicLink() && /skill-grader/.test(fs.readlinkSync(target));
    } catch {
      return false;
    }
  });
}

function windsurfHooksInstalled() {
  const hooksFile = path.join(home, ".codeium", "windsurf", "hooks.json");
  if (!exists(hooksFile)) return false;
  const config = readJson(hooksFile, null);
  return !!(
    config &&
    config.hooks &&
    Array.isArray(config.hooks.pre_run_command) &&
    config.hooks.pre_run_command.some((item) => item && typeof item.command === "string" && /skill-grader/.test(item.command))
  );
}

function removeSharedReportSkillIfUnused() {
  if (clineHooksInstalled() || windsurfHooksInstalled()) return;
  removeIfExists(path.join(home, ".agents", "skills", "skill-grader-report"));
}

function codexMarketplacePluginPath(pluginPath) {
  const relative = path.relative(home, pluginPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return `./${relative.split(path.sep).join("/")}`;
  return pluginPath;
}

function codexMarketplaceWithPlugin(existing, pluginPath) {
  const plugin = {
    name: "skill-grader",
    source: { source: "local", path: codexMarketplacePluginPath(pluginPath) },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Security",
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
  installReportSkill(path.join(home, ".codex", "skills"));
  log(`Codex: ${dryRun ? "would add" : "added"} AI Skill Grader to ${marketplace}${backup ? ` (backup: ${backup})` : ""}.`);

  const codexBin = dryRun ? null : findAgentBinary("codex");
  if (codexBin) {
    const result = childProcess.spawnSync(codexBin, ["plugin", "add", "skill-grader@skill-grader-local"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      log("Codex: installed and enabled. Restart Codex, then ask it for a report on any skill by name or GitHub link.");
      log("  (Codex checks on request, not automatically. To review a whole set at once, grade the repo at aiskillgrader.com.)");
    } else {
      log("Codex: marketplace entry is ready. Finish with:");
      log("  codex plugin add skill-grader@skill-grader-local");
      const why = spawnFailReason(result);
      if (why) log(`  (couldn't finish automatically: ${why})`);
    }
  } else {
    log("Codex: finish with:");
    log("  codex plugin add skill-grader@skill-grader-local");
  }
}

function installClaude() {
  // Claude Code installs plugins from a marketplace, not a raw path. The plugin
  // ships a local marketplace manifest (plugin/.claude-plugin/marketplace.json)
  // whose root is installRoot/plugin. Claude COPIES the plugin into its own
  // plugins/cache on install, which is why each adapter is self-contained.
  const marketplacePath = path.join(installRoot, "plugin");
  const pluginId = "skill-grader@skill-grader-local";
  const bin = dryRun ? null : findAgentBinary("claude");
  if (bin) {
    childProcess.spawnSync(bin, ["plugin", "marketplace", "add", marketplacePath], { encoding: "utf8", stdio: "pipe" });
    const result = childProcess.spawnSync(bin, ["plugin", "install", pluginId, "-y"], { encoding: "utf8", stdio: "pipe" });
    if (result.status === 0) {
      log("Claude Code: installed and enabled. Open a new Claude Code session to load it.");
      return;
    }
    log("Claude Code: could not finish the install automatically. Do it inside Claude Code with:");
    log(`  /plugin marketplace add ${marketplacePath}`);
    log(`  /plugin install ${pluginId}`);
    const why = spawnFailReason(result);
    if (why) log(`  (couldn't finish automatically: ${why})`);
    return;
  } else {
    log(`Claude Code: plugin files ${dryRun ? "would be ready" : "are ready"}. Finish inside Claude Code with:`);
  }
  log(`  /plugin marketplace add ${marketplacePath}`);
  log(`  /plugin install ${pluginId}`);
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
    log("Cline: hooks aren't supported on Windows, skipping.");
    return;
  }
  const pluginPath = path.join(installRoot, "plugin", "skill-grader-cline");
  const hooksDir = path.join(home, "Documents", "Cline", "Hooks");
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
  let marketplaceNote = "";
  if (exists(marketplace)) {
    const current = readJson(marketplace, null);
    if (current && Array.isArray(current.plugins)) {
      const kept = current.plugins.filter((p) => p && p.name !== "skill-grader");
      if (kept.length !== current.plugins.length) {
        if (kept.length === 0 && current.name === "skill-grader-local") {
          const backup = removeWithBackup(marketplace);
          marketplaceNote = backup ? ` (backup: ${backup})` : "";
        } else {
          const backup = writeJson(marketplace, { ...current, plugins: kept });
          marketplaceNote = backup ? ` (backup: ${backup})` : "";
        }
      }
    } else if (current && Array.isArray(current.marketplaces)) {
      const next = current.marketplaces.filter((m) => m && m.name !== "skill-grader-local");
      if (next.length !== current.marketplaces.length) {
        const backup = writeJson(marketplace, { ...current, marketplaces: next });
        marketplaceNote = backup ? ` (backup: ${backup})` : "";
      }
    } else if (Array.isArray(current)) {
      const next = current.filter((m) => m && m.name !== "skill-grader-local");
      if (next.length !== current.length) {
        const backup = writeJson(marketplace, next);
        marketplaceNote = backup ? ` (backup: ${backup})` : "";
      }
    }
  }
  if (commandExists("codex") && !dryRun) {
    childProcess.spawnSync("codex", ["plugin", "remove", "skill-grader"], { stdio: "ignore" });
  }
  removeIfExists(path.join(home, ".codex", "skills", "skill-grader-report"));
  log(`Codex: ${dryRun ? "would remove" : "removed"} the grader${marketplaceNote}. If it lingers, run: codex plugin remove skill-grader`);
}

function uninstallClaude() {
  const pluginId = "skill-grader@skill-grader-local";
  if (commandExists("claude") && !dryRun) {
    const result = childProcess.spawnSync("claude", ["plugin", "uninstall", pluginId], { encoding: "utf8", stdio: "pipe" });
    childProcess.spawnSync("claude", ["plugin", "marketplace", "remove", "skill-grader-local"], { stdio: "ignore" });
    if (result.status === 0) {
      log(`Claude Code: removed ${pluginId}.`);
      return;
    }
  }
  log("Claude Code: remove it from inside Claude Code with:");
  log(`  /plugin uninstall ${pluginId}`);
  log("  /plugin marketplace remove skill-grader-local");
}

function uninstallCursor() {
  uninstallHooksFile(path.join(home, ".cursor", "hooks.json"), "Cursor");
  removeIfExists(path.join(home, ".cursor", "skill-grader-root"));
  removeIfExists(path.join(home, ".cursor", "skills", "skill-grader-report"));
}

function uninstallCline() {
  const hooksDir = path.join(home, "Documents", "Cline", "Hooks");
  const a = removeOurSymlink(path.join(hooksDir, "TaskStart"));
  const b = removeOurSymlink(path.join(hooksDir, "PreToolUse"));
  removeIfExists(path.join(home, ".skill-grader-cline"));
  removeSharedReportSkillIfUnused();
  log(`Cline: ${dryRun ? "would remove" : a || b ? "removed" : "found no"} grader hooks in ${hooksDir}.`);
}

function uninstallWindsurf() {
  uninstallHooksFile(path.join(home, ".codeium", "windsurf", "hooks.json"), "Windsurf");
  removeIfExists(path.join(home, ".skill-grader-windsurf"));
  removeSharedReportSkillIfUnused();
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
  // A positional token that isn't "uninstall" or a known tool is almost always a
  // typo (e.g. "cluade"). Don't silently fall through to auto-detect and install
  // something the user didn't ask for; say what's wrong and stop.
  const unknown = rawArgs.filter((a) => !a.startsWith("-") && a !== "uninstall" && !knownTools.includes(a));
  if (unknown.length) {
    log(`I don't recognize: ${unknown.join(", ")}. Supported tools are claude and codex.`);
    usage();
    process.exitCode = 1;
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
  // Naming a tool explicitly (npx ai-skill-grader claude) is already the intent,
  // so skip the extra prompt. Still confirm for uninstall and for broad installs
  // (--all or auto-detected) where the user didn't name what to touch.
  const explicitInstall = !uninstall && requested.length > 0;
  if (!explicitInstall && !(await confirm(uninstall ? "Uninstall" : "Proceed"))) {
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
