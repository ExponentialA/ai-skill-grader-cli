#!/usr/bin/env node
// AI Skill Grader — Cline TaskStart hook logic.
//
// Cline runs a hook at TaskStart (task = a Cline session) that can inject context
// via `contextModification`. Cline loads skills as context, so — like the Codex
// and Cursor adapters — this reads every skill it hasn't shown you yet at the
// start of a task and surfaces a plain-English run-safety read. Same static
// engine as the site (triageSignals) and the same read builder as the other
// adapters (../shared/skill-read.js).
//
// Cline hooks have no user-facing message channel — only `contextModification`
// (which "shapes how Cline approaches work"). So the read is injected as context,
// framed for the agent to surface to the user. It also records the plugin root so
// the full-report skill can find its script.
//
// FAIL OPEN: any error => stay silent and let the task proceed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildRead } = require(path.resolve(__dirname, "../shared/skill-read.js"));

function stateHome() {
  return path.join(os.homedir(), ".skill-grader-cline");
}
function stateFile(name) {
  return path.join(stateHome(), name);
}
function allow() {
  process.stdout.write(JSON.stringify({ cancel: false }));
  process.exit(0);
}

// How the agent produces a full report on request (Cline-specific script path).
function enablement(rootPath) {
  return (
    "\n\n[AI Skill Grader] To produce a full report on any skill when the user asks, run this and show its output verbatim: " +
    `node "${rootPath}/scripts/report.js" "<skill name or GitHub URL>".`
  );
}

function skillRoots(cwd) {
  const home = os.homedir();
  return [
    path.join(home, ".agents", "skills"),
    cwd ? path.join(cwd, ".agents", "skills") : null,
    cwd ? path.join(cwd, ".clinerules", "skills") : null,
    path.join(home, "Documents", "Cline", "Skills"),
  ].filter(Boolean);
}

function discoverSkills(cwd) {
  const found = new Map(); // name -> file (first root wins)
  for (const root of skillRoots(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (found.has(name)) continue;
      if (/skill-grader/i.test(name)) continue; // never scan our own report skill
      const dir = path.join(root, name);
      let file = null;
      try {
        const f = fs.readdirSync(dir).find((n) => n.toLowerCase() === "skill.md");
        if (f) file = path.join(dir, f);
      } catch (_error) {
        /* not a skill dir */
      }
      if (file) found.set(name, file);
    }
  }
  return found;
}

function readSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(stateFile("skill-grader-seen.json"), "utf8")));
  } catch (_error) {
    return new Set();
  }
}
function writeSeen(set) {
  try {
    fs.mkdirSync(stateHome(), { recursive: true });
    fs.writeFileSync(stateFile("skill-grader-seen.json"), JSON.stringify([...set]), "utf8");
  } catch (_error) {
    /* best-effort */
  }
}

function emit(read, rootPath) {
  // Cline TaskStart: inject via contextModification, framed for the agent to
  // show the user, plus the enablement note for producing full reports on ask.
  const context =
    "Show the user this AI Skill Grader safety read at the start of your reply, then continue with their request:\n\n" +
    read.message +
    enablement(rootPath);
  process.stdout.write(JSON.stringify({ cancel: false, contextModification: context }));
  process.exit(0);
}

function main() {
  let triageSignals;
  try {
    ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/triage.js")));
  } catch (_error) {
    allow();
  }
  if (typeof triageSignals !== "function") allow();

  let cwd = process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input && input.cwd) cwd = input.cwd;
    else if (input && Array.isArray(input.workspaceRoots) && input.workspaceRoots[0]) cwd = input.workspaceRoots[0];
  } catch (_error) {
    /* no/!JSON stdin — fall back to process cwd */
  }

  // Record the plugin root so the full-report skill can locate report.js.
  const rootPath = path.resolve(__dirname, "..");
  try {
    fs.mkdirSync(stateHome(), { recursive: true });
    fs.writeFileSync(stateFile("skill-grader-root"), rootPath, "utf8");
  } catch (_error) {
    /* best-effort */
  }

  const welcomeFlag = stateFile("skill-grader-welcomed");
  let welcome = false;
  try {
    welcome = !fs.existsSync(welcomeFlag);
  } catch (_error) {
    welcome = false;
  }

  const discovered = discoverSkills(cwd);
  const seen = readSeen();
  const fresh = [];
  for (const [name, file] of discovered) {
    if (seen.has(name)) continue;
    let sig;
    try {
      sig = triageSignals(fs.readFileSync(file, "utf8"));
    } catch (_error) {
      continue; // unreadable — skip, try again next task
    }
    fresh.push({ name, file, sig });
    seen.add(name);
  }

  const read = buildRead(fresh, { welcome });

  // Mark seen + welcomed even when staying silent, so we never re-nag.
  writeSeen(seen);
  if (welcome) {
    try {
      fs.writeFileSync(welcomeFlag, new Date().toISOString(), "utf8");
    } catch (_error) {
      /* best-effort */
    }
  }

  if (!read) allow();
  emit(read, rootPath);
}

if (require.main === module) main();

module.exports = { main, enablement };
