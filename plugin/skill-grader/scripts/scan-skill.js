#!/usr/bin/env node
// AI Skill Grader — PreToolUse hook (matcher: Skill). The first time you use a
// skill, it shows a plain-English read on it, using the same static run-safety
// engine as the site (no LLM, no network): is it safe to run? It blocks a skill
// whose text tries to manipulate/exfiltrate, and it points you at the full report
// for deeper output-trust detail. Silent on skills you've already seen.
//
// FAIL OPEN: any error => allow silently. A safety tool must never break the
// session it protects.
const fs = require("fs");
const os = require("os");
const path = require("path");

function allow() {
  process.exit(0);
}
function allowWith(message) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      systemMessage: message,
    })
  );
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

let triageSignals;
try {
  ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/reports.js")));
} catch (_error) {
  allow();
}
if (typeof triageSignals !== "function") allow();

function findSkillMd(skillName, cwd) {
  const leaf = String(skillName || "").split(":").pop().trim();
  if (!leaf) return null;
  const roots = [cwd ? path.join(cwd, ".claude", "skills") : null, path.join(os.homedir(), ".claude", "skills")].filter(Boolean);
  const pluginsDir = path.join(os.homedir(), ".claude", "plugins");
  try {
    for (const name of fs.readdirSync(pluginsDir)) roots.push(path.join(pluginsDir, name, "skills"));
  } catch (_error) {
    /* no plugins dir */
  }
  for (const root of roots) {
    const dir = path.join(root, leaf);
    try {
      const entry = fs.readdirSync(dir).find((f) => f.toLowerCase() === "skill.md");
      if (entry) return path.join(dir, entry);
    } catch (_error) {
      /* not here */
    }
  }
  return null;
}

const CONCERN = {
  directLiveAction: "can act on live accounts or systems",
  credentials: "wants credentials or tokens",
  scripts: "runs scripts",
  paid: "can spend money",
  sensitive: "handles sensitive data",
  decisionCritical: "feeds costly decisions",
};

// Show the read once per skill, then stay quiet.
function seenFile() {
  return path.join(os.homedir(), ".claude", "skill-grader-seen.json");
}
function alreadySeen(skill) {
  try {
    return JSON.parse(fs.readFileSync(seenFile(), "utf8")).includes(skill);
  } catch (_error) {
    return false;
  }
}
function markSeen(skill) {
  try {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(seenFile(), "utf8"));
    } catch (_error) {
      list = [];
    }
    if (!list.includes(skill)) list.push(skill);
    fs.mkdirSync(path.dirname(seenFile()), { recursive: true });
    fs.writeFileSync(seenFile(), JSON.stringify(list), "utf8");
  } catch (_error) {
    /* best-effort */
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (_error) {
    allow();
  }
  if (!input || input.tool_name !== "Skill") allow();
  const skill = input.tool_input && input.tool_input.skill;
  if (!skill) allow();
  if (/skill-grader/i.test(skill)) allow(); // don't scan our own report command

  const file = findSkillMd(skill, input.cwd);
  if (!file) allow();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    allow();
  }

  const sig = triageSignals(text);
  if (sig.manipulation) {
    block(
      `AI Skill Grader — "${skill}"\n⛔ Blocked. Its SKILL.md contains instruction-manipulation or exfiltration language. ` +
        `Open ${file} and read it before you run this.`
    );
  }
  if (alreadySeen(skill)) allow();
  markSeen(skill);

  const risky = ["directLiveAction", "credentials", "scripts", "paid", "sensitive", "decisionCritical"].filter((k) => sig[k]);
  const safeLine = risky.length
    ? `⚠️ Use with care — it ${risky.map((k) => CONCERN[k]).join(", ")}. Try it in a sandbox first.`
    : `✓ Nothing risky showed up — safe to inspect.`;
  // Mirror the site's verdict-adaptive gate copy: with flags the pull is depth;
  // clean, the pull is the anatomy (what it can reach, what to check first).
  const cta = risky.length
    ? `You've seen what's risky. The full report shows how serious each thing is and exactly what to do — free. Say "full report on ${skill}".`
    : `Nothing flagged — but you still don't know what it can reach or what to check first. The full report shows that, free. Say "full report on ${skill}".`;
  allowWith(`AI Skill Grader — ${skill}\n${safeLine}\n${cta}`);
}

main();
