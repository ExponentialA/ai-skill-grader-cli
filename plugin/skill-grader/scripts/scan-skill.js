#!/usr/bin/env node
// AI Skill Grader — PreToolUse hook (matcher: Skill). The first time you use a
// skill, it shows a plain-English read on it, using the same static run-safety
// engine as the site preview (no LLM, no network): what can this skill touch?
// It blocks a skill
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
  ({ triageSignals } = require(path.resolve(__dirname, "../product-surface/lib/triage.js")));
} catch (_error) {
  allow();
}
if (typeof triageSignals !== "function") allow();

// Optional: OUR authoritative graded verdict by content hash. When it resolves a
// skill (installed unmodified from our corpus), that verdict wins over the fast
// regex. If it can't load, gradedRisk stays undefined and we use regex only.
let gradedRisk;
try {
  ({ gradedRisk } = require(path.resolve(__dirname, "../shared/verdict-lookup.js")));
} catch (_error) {
  /* fall back to regex-only triage */
}

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
  const graded = typeof gradedRisk === "function" ? gradedRisk(text) : null;

  // Block on run-safety manipulation language, UNLESS we've graded this exact
  // content clean ("g") — then the regex hit is a false positive we override.
  // We do NOT block on graded "d" alone: the risk-only index can't tell a
  // run-safety danger from an output-trust one, and this gate is run-safety.
  if (sig.manipulation && graded !== "g") {
    if (graded === "d" || graded === "w") {
      block(
        `AI Skill Grader: "${skill}"\n` +
          `⛔ Held back. We graded this one and it's flagged. ` +
          `Say "full report on ${skill}" for what's wrong and what to do before you run it.`
      );
    }
    block(
      `AI Skill Grader: "${skill}"\n` +
        `⛔ Held back for a closer look. Its instructions contain manipulation-style language. ` +
        `Say "full report on ${skill}" to find out whether it's a real risk before you run it.`
    );
  }
  if (alreadySeen(skill)) allow();
  markSeen(skill);

  let verdictLine;
  let cta;
  if (graded === "d") {
    // Graded danger that didn't trip the run-safety block (may be output-trust).
    verdictLine = `⛔ We graded this one: do not rely on it.`;
    cta = `Say "full report on ${skill}" for what's wrong and what to do.`;
  } else if (graded === "w") {
    verdictLine = `⚠️ We graded this one: use with care.`;
    cta = `Say "full report on ${skill}" for what and why.`;
  } else if (graded === "g") {
    verdictLine = `✓ We graded this one: nothing flagged in our review.`;
    cta = `A skill can still reach more than you think. Say "full report on ${skill}" for what it can reach.`;
  } else {
    // No graded verdict: fall back to the fast regex read (a suspicion, not a verdict).
    const risky = ["directLiveAction", "credentials", "scripts", "paid", "sensitive", "decisionCritical"].filter((k) => sig[k]);
    verdictLine = risky.length
      ? `⚠️ Use with care. It ${risky.map((k) => CONCERN[k]).join(", ")}. Try it in a sandbox first.`
      : `✓ Nothing risky showed up, safe to inspect.`;
    // Mirror the site's verdict-adaptive gate copy: with flags the pull is depth;
    // clean, the pull is the anatomy (what it can reach, what to check first).
    cta = risky.length
      ? `You've seen what's risky. The full report shows how serious each thing is and exactly what to do, free. Say "full report on ${skill}".`
      : `Nothing flagged, but you still don't know what it can reach or what to check first. The full report shows that, free. Say "full report on ${skill}".`;
  }
  allowWith(`AI Skill Grader: ${skill}\n${verdictLine}\n${cta}`);
}

main();
