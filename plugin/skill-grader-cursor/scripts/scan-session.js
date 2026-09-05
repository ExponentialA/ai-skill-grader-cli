#!/usr/bin/env node
// AI Skill Grader — Cursor sessionStart hook.
//
// Cursor loads skills as CONTEXT, not as a tool call (and has no skill-load
// event to block), so — like the Codex adapter — this reads every skill it
// hasn't shown you yet at session start and surfaces a plain-English run-safety
// read. Same static engine as the site (triageSignals) and the same read
// builder as the other adapters (../shared/skill-read.js).
//
// Cursor's sessionStart output has no user-facing message channel — only
// `additional_context` (injected into the conversation) and `env`. So the read
// is injected as context, framed for the agent to surface to the user. It also
// records the plugin root so the full-report skill can find its script.
//
// FAIL OPEN: any error => stay silent and let the session proceed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildRead } = require(path.resolve(__dirname, "../shared/skill-read.js"));

function cursorHome() {
  return path.join(os.homedir(), ".cursor");
}
function stateFile(name) {
  return path.join(cursorHome(), name);
}

// How the agent produces a full report on request (Cursor-specific script path).
function enablement(rootPath) {
  return (
    "\n\n[AI Skill Grader] To produce a full report on any skill when the user asks, run this and show its output verbatim: " +
    `node "${rootPath}/scripts/report.js" "<skill name or GitHub URL>".`
  );
}

function skillRoots(cwd) {
  const home = os.homedir();
  return [
    path.join(cursorHome(), "skills"),
    path.join(home, ".agents", "skills"),
    cwd ? path.join(cwd, ".cursor", "skills") : null,
    cwd ? path.join(cwd, ".agents", "skills") : null,
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
    fs.mkdirSync(cursorHome(), { recursive: true });
    fs.writeFileSync(stateFile("skill-grader-seen.json"), JSON.stringify([...set]), "utf8");
  } catch (_error) {
    /* best-effort */
  }
}

function emit(read, rootPath) {
  // Cursor sessionStart: surface via additional_context, framed for the agent to
  // show the user, plus the enablement note for producing full reports on ask.
  const context =
    "Show the user this AI Skill Grader run-safety read at the start of your reply, then continue with their request:\n\n" +
    read.message +
    enablement(rootPath);
  process.stdout.write(JSON.stringify({ additional_context: context }));
  process.exit(0);
}

function main() {
  let triageSignals;
  try {
    ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/reports.js")));
  } catch (_error) {
    process.exit(0);
  }
  if (typeof triageSignals !== "function") process.exit(0);

  let cwd = process.env.CURSOR_PROJECT_DIR || process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input && input.cwd) cwd = input.cwd;
  } catch (_error) {
    /* no/!JSON stdin — fall back to CURSOR_PROJECT_DIR / process cwd */
  }

  // Record the plugin root so the full-report skill can locate report.js.
  const rootPath = path.resolve(__dirname, "..");
  try {
    fs.mkdirSync(cursorHome(), { recursive: true });
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
      continue; // unreadable — skip, try again next session
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

  if (!read) process.exit(0);
  emit(read, rootPath);
}

if (require.main === module) main();

module.exports = { enablement };
