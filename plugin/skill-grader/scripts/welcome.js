#!/usr/bin/env node
// AI Skill Grader — Claude Code SessionStart hook.
//
// On the FIRST session after install, audit the skills you ALREADY have and show
// a worst-first roll-up read (the initial scan a safety tool should do), then
// stay silent forever. Per-skill reads and blocks going forward are handled by
// scan-skill.js on each skill invocation. Every audited skill is marked "seen"
// so scan-skill.js won't re-read it — it still BLOCKS a manipulative one, since
// that check runs before the "seen" check.
//
// FAIL OPEN: any error => stay silent, never break the session.
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = os.homedir();
const welcomedFlag = path.join(home, ".claude", "skill-grader-welcomed");
const seenFile = path.join(home, ".claude", "skill-grader-seen.json");

function markWelcomed() {
  try {
    fs.mkdirSync(path.dirname(welcomedFlag), { recursive: true });
    fs.writeFileSync(welcomedFlag, new Date().toISOString());
  } catch (_error) {
    /* best effort */
  }
}

function emit(systemMessage) {
  markWelcomed();
  if (systemMessage) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart" }, systemMessage }));
  }
  process.exit(0);
}

// Only ever on the first session.
try {
  if (fs.existsSync(welcomedFlag)) process.exit(0);
} catch (_error) {
  process.exit(0);
}

let triageSignals;
let buildRead;
let gradedRisk;
try {
  ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/triage.js")));
  ({ buildRead } = require(path.resolve(__dirname, "../shared/skill-read.js")));
  ({ gradedRisk } = require(path.resolve(__dirname, "../shared/verdict-lookup.js")));
} catch (_error) {
  triageSignals = null;
}

function skillRoots(cwd) {
  const roots = [];
  if (cwd) roots.push(path.join(cwd, ".claude", "skills"));
  roots.push(path.join(home, ".claude", "skills"));
  const pluginsDir = path.join(home, ".claude", "plugins");
  try {
    for (const name of fs.readdirSync(pluginsDir)) roots.push(path.join(pluginsDir, name, "skills"));
  } catch (_error) {
    /* no plugins dir */
  }
  return roots;
}

function discover(cwd) {
  const found = new Map(); // name -> SKILL.md path (first root wins)
  for (const root of skillRoots(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || found.has(ent.name)) continue;
      if (/skill-grader/i.test(ent.name)) continue; // never audit our own report skill
      const dir = path.join(root, ent.name);
      try {
        const f = fs.readdirSync(dir).find((n) => n.toLowerCase() === "skill.md");
        if (f) found.set(ent.name, path.join(dir, f));
      } catch (_error) {
        /* not a skill dir */
      }
    }
  }
  return found;
}

function markSeen(names) {
  try {
    let seen = [];
    try {
      seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    } catch (_error) {
      seen = [];
    }
    const set = new Set(Array.isArray(seen) ? seen : []);
    for (const n of names) set.add(n);
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...set]), "utf8");
  } catch (_error) {
    /* best effort */
  }
}

function main() {
  // No engine reachable — fall back to the plain one-time "on" line.
  if (typeof triageSignals !== "function" || typeof buildRead !== "function") {
    emit(
      "AI Skill Grader is on. Before any skill runs, you'll get a plain-English read on what it can touch and what to check first. Ask me for the full report on any skill."
    );
  }

  let cwd = process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input && input.cwd) cwd = input.cwd;
  } catch (_error) {
    /* no/!JSON stdin — fall back to process cwd */
  }

  const found = discover(cwd);
  const skills = [];
  for (const [name, file] of found) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_error) {
      continue;
    }
    skills.push({ name, file, sig: triageSignals(text), graded: gradedRisk ? gradedRisk(text) : null });
  }

  const read = buildRead(skills, { welcome: true });
  markSeen(skills.map((s) => s.name));
  emit(read ? read.message : null);
}

try {
  main();
} catch (_error) {
  emit(null);
}
