#!/usr/bin/env node
// AI Skill Grader — Codex SessionStart hook.
//
// Codex loads skills as CONTEXT, not as a tool call, so — unlike the Claude
// adapter, which reads each skill the moment it's invoked — this reads every
// skill you have at the start of a session and surfaces a plain-English
// run-safety read on any it hasn't shown you yet. Same static engine as the
// site (triageSignals) and the same read builder as the other adapters:
// no LLM, no network. It also records the plugin
// root so the full-report skill can find its script.
//
// FAIL OPEN: any error => stay silent and let the session proceed. A safety
// tool must never break the session it protects.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildRead } = require(path.resolve(__dirname, "../shared/skill-read.js"));

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
function stateFile(name) {
  return path.join(codexHome(), name);
}

// How the agent produces a full report on request (Codex-specific script path).
function enablement(rootPath) {
  return (
    "AI Skill Grader is active and has shown the user a plain-English safety read on their skills. " +
    "When the user asks for the full or deep report on a skill, or to grade one, run the report script and show its output verbatim: " +
    `node "${rootPath}/scripts/report.js" "<skill name or GitHub URL>".`
  );
}

function skillRoots(cwd) {
  const home = os.homedir();
  return [
    path.join(codexHome(), "skills"),
    path.join(home, ".agents", "skills"),
    cwd ? path.join(cwd, ".codex", "skills") : null,
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
    fs.mkdirSync(codexHome(), { recursive: true });
    fs.writeFileSync(stateFile("skill-grader-seen.json"), JSON.stringify([...set]), "utf8");
  } catch (_error) {
    /* best-effort */
  }
}

function emit(read, rootPath) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: enablement(rootPath) },
      systemMessage: read.message,
    })
  );
  process.exit(0);
}

function main() {
  let triageSignals;
  try {
    ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/triage.js")));
  } catch (_error) {
    process.exit(0);
  }
  if (typeof triageSignals !== "function") process.exit(0);

  // Optional: OUR authoritative graded verdict by content hash. When it resolves
  // a skill, that verdict wins over the fast regex in the read. Fails soft.
  let gradedRisk;
  try {
    ({ gradedRisk } = require(path.resolve(__dirname, "../shared/verdict-lookup.js")));
  } catch (_error) {
    /* fall back to regex-only triage */
  }

  let cwd = process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    if (input && input.cwd) cwd = input.cwd;
  } catch (_error) {
    /* no/!JSON stdin — fall back to process cwd */
  }

  // Record the plugin root so the full-report skill can locate report.js.
  const rootPath = path.resolve(__dirname, "..");
  try {
    fs.mkdirSync(codexHome(), { recursive: true });
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
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_error) {
      continue; // unreadable — skip, try again next session
    }
    let sig;
    try {
      sig = triageSignals(text);
    } catch (_error) {
      continue;
    }
    fresh.push({ name, file, sig, graded: gradedRisk ? gradedRisk(text) : null });
    seen.add(name);
  }

  const read = buildRead(fresh, { welcome });

  // Mark seen + welcomed even if we choose to stay silent, so we never re-nag.
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
