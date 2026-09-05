#!/usr/bin/env node
// Fetches the full report for a skill/repo from AI Skill Grader and prints it in
// the thread — using the SITE'S OWN renderer (reportText), so the content is
// identical to the site and the emailed report, no difference. Instant for an
// already-graded skill; a brand-new one comes back as the fast preview with a
// note that the deep grade takes a few minutes.
//
// Cursor build: resolves a bare skill name against Cursor's skill locations
// (~/.cursor/skills, ~/.agents/skills, and the project's .cursor/.agents dirs),
// falling back to the other tools' locations so it works either way.
const fs = require("fs");
const os = require("os");
const path = require("path");

const API = process.env.SKILL_GRADER_API || "https://www.aiskillgrader.com/api/report";
const SITE = process.env.SKILL_GRADER_SITE || "https://www.aiskillgrader.com/";

let reportText;
try {
  ({ reportText } = require(path.resolve(__dirname, "../product-surface/lib/report-email.js")));
} catch (_error) {
  reportText = null;
}

function skillRoots() {
  const home = os.homedir();
  const project = process.env.CURSOR_PROJECT_DIR || process.cwd();
  return [
    path.join(project, ".cursor", "skills"),
    path.join(project, ".agents", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(project, ".codex", "skills"),
    path.join(project, ".claude", "skills"),
    path.join(home, ".claude", "skills"),
  ];
}

function resolveSource(arg) {
  if (/^https?:\/\//i.test(arg)) return arg;
  const leaf = String(arg).split(":").pop().trim();
  for (const root of skillRoots()) {
    const dir = path.join(root, leaf);
    try {
      const f = fs.readdirSync(dir).find((n) => n.toLowerCase() === "skill.md");
      if (!f) continue;
      const m = fs.readFileSync(path.join(dir, f), "utf8").match(/^(?:source|repo|url|homepage):\s*(https?:\/\/\S+)/im);
      return m ? m[1] : { needUrl: true };
    } catch (_error) {
      /* not here */
    }
  }
  return { needUrl: true };
}

async function main() {
  const arg = (process.argv[2] || "").trim();
  if (!arg) {
    console.log("Tell me which skill: name the skill you want the full report on, or paste its GitHub link.");
    return;
  }
  const src = resolveSource(arg);
  if (src && src.needUrl) {
    console.log(`I couldn't find where "${arg}" came from. Paste its GitHub link and I'll pull the full report.`);
    return;
  }

  let data;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceUrl: src }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.log(body.error || `Couldn't get the report right now (${res.status}). Try again in a moment.`);
      return;
    }
    data = await res.json();
  } catch (error) {
    console.log(`Couldn't reach AI Skill Grader (${error.message || error}). Try again in a moment.`);
    return;
  }

  const out = [];
  if (!data.graded) {
    out.push(`> ${data.note || "This one hasn't been deep-graded yet — here's the fast preview. The full report takes a few minutes."}`, "");
  }
  if (reportText) {
    out.push(reportText({ source: data.source, skills: data.skills || [], partial: null }));
  } else {
    // Fallback if the renderer isn't reachable (shouldn't happen when installed from the repo).
    out.push(JSON.stringify(data.skills, null, 2));
  }
  const link = data.source && data.source.url ? `${SITE}?source=${encodeURIComponent(data.source.url)}` : SITE;
  out.push("", `See the full styled report: ${link}`);
  console.log(out.join("\n"));
}

main();
