#!/usr/bin/env node
// One-time welcome the first session after install; silent forever after. Mirrors
// the site's positioning (a plain-English read before you install), not "antivirus."
const fs = require("fs");
const os = require("os");
const path = require("path");

const flag = path.join(os.homedir(), ".claude", "skill-grader-welcomed");
try {
  if (fs.existsSync(flag)) process.exit(0);
  fs.mkdirSync(path.dirname(flag), { recursive: true });
  fs.writeFileSync(flag, new Date().toISOString());
} catch (_error) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart" },
    systemMessage:
      "AI Skill Grader is on. From now on, before any skill runs, you'll get a plain-English read " +
      "on what it can touch and what to check first. Ask me for the full report on any skill.",
  })
);
