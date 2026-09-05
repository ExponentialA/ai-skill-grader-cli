// AI Skill Grader — shared action-guard (Tier 1) for the tools that can block a
// pre-action but can't block a skill from loading (Codex, Cursor, Cline,
// Windsurf). It answers one question a pre-shell-command hook needs: "is this
// command about to run a script from a skill whose SKILL.md is manipulative?"
//
// Self-contained: it reads the referenced skill's SKILL.md and triages it on the
// spot, so it needs no prior read or shared state. Reliable link = the skill's
// path appearing in the command (the "skill ships scripts and tells the agent to
// run them" vector). It does NOT catch inline commands with no skill path, and
// does NOT cover MCP calls (no path to attribute) — those stay disclosed, not
// blocked.
const fs = require("fs");
const os = require("os");
const path = require("path");

// Pure: pull candidate skill directories out of a shell command string. A
// candidate is any path token containing a `skills/<name>` segment, resolved to
// an absolute path (~ expanded, relatives resolved against cwd). Exported for
// tests.
function candidateSkillDirs(command, cwd, home) {
  const base = cwd || process.cwd();
  const homeDir = home || os.homedir();
  const dirs = new Set();
  for (let tok of String(command || "").split(/[\s;|&<>()]+/)) {
    tok = tok.replace(/^["']+|["']+$/g, "");
    const i = tok.indexOf("skills/");
    if (i < 0) continue;
    if (i > 0 && tok[i - 1] !== "/") continue; // must be a path boundary before "skills/"
    const name = tok.slice(i + "skills/".length).split("/")[0];
    if (!name || name === "." || name === "..") continue;
    let dir = tok.slice(0, i) + "skills/" + name;
    if (dir.startsWith("~/")) dir = path.join(homeDir, dir.slice(2));
    dir = path.isAbsolute(dir) ? dir : path.resolve(base, dir);
    dirs.add(dir);
  }
  return [...dirs];
}

function skillMdIn(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.toLowerCase() === "skill.md");
    return f ? path.join(dir, f) : null;
  } catch (_error) {
    return null;
  }
}

// Reads the candidate skills' SKILL.md files and triages them. Returns
// { name, dir, file } of the first one flagged manipulative, or null. triage is
// injected (the site's triageSignals) so this stays testable without the engine.
function findManipulativeSkill(command, cwd, triage, home) {
  if (typeof triage !== "function") return null;
  for (const dir of candidateSkillDirs(command, cwd, home)) {
    const file = skillMdIn(dir);
    if (!file) continue;
    let sig;
    try {
      sig = triage(fs.readFileSync(file, "utf8"));
    } catch (_error) {
      continue;
    }
    if (sig && sig.manipulation) {
      return { name: path.basename(dir), dir, file };
    }
  }
  return null;
}

function blockReason(hit) {
  return (
    `AI Skill Grader blocked this: the command runs a script from "${hit.name}", ` +
    `whose SKILL.md contains instruction-manipulation or exfiltration language. ` +
    `Review ${hit.file} before running anything from it.`
  );
}

// Convenience for the per-tool hooks: wires the site's engine and returns the
// { name, dir, file } of a manipulative skill the command would run, or null.
// Fails safe (returns null) if the engine can't be loaded — the hook then allows.
function checkCommand(command, cwd) {
  let triageSignals;
  try {
    ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/triage.js")));
  } catch (_error) {
    return null;
  }
  return findManipulativeSkill(command, cwd, triageSignals);
}

module.exports = { candidateSkillDirs, findManipulativeSkill, blockReason, checkCommand };
