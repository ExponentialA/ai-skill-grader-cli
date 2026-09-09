#!/usr/bin/env node
// Fetches the full report for a skill/repo from AI Skill Grader and prints it in
// the thread — using the SITE'S OWN renderer (reportText), so the content is
// identical to the site and the emailed report, no difference. Instant for an
// already-graded skill; a brand-new one comes back as the fast preview with a
// note that the deep grade takes a few minutes.
//
// Cline build: resolves a bare skill name against Cline's skill locations
// (~/.agents/skills, .agents/skills, .clinerules/skills), falling back to the
// other tools' locations so it works either way.
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
  const project = process.cwd();
  return [
    path.join(home, ".agents", "skills"),
    path.join(project, ".agents", "skills"),
    path.join(project, ".clinerules", "skills"),
    path.join(home, "Documents", "Cline", "Skills"),
    path.join(project, ".cursor", "skills"),
    path.join(project, ".codex", "skills"),
    path.join(project, ".claude", "skills"),
    path.join(home, ".claude", "skills"),
  ];
}

// Returns { url } to grade from GitHub, { content, name } to grade the on-disk
// SKILL.md (an installed skill with no source link), or { needUrl } when the skill
// isn't found locally at all.
function resolveSource(arg) {
  if (/^https?:\/\//i.test(arg)) return { url: arg };
  const leaf = String(arg).split(":").pop().trim();
  for (const root of skillRoots()) {
    const dir = path.join(root, leaf);
    let text;
    try {
      const f = fs.readdirSync(dir).find((n) => n.toLowerCase() === "skill.md");
      if (!f) continue;
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch (_error) {
      continue; // not in this root
    }
    const m = text.match(/^(?:source|repo|url|homepage):\s*(https?:\/\/\S+)/im);
    // Prefer the declared source URL; otherwise grade the content we have on disk.
    return m ? { url: m[1] } : { content: text, name: leaf };
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
    console.log(`I couldn't find "${arg}" among your installed skills. Paste its GitHub link and I'll pull the full report.`);
    return;
  }
  const payload = src.url ? { sourceUrl: src.url } : { content: src.content, name: src.name };

  let data;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
    out.push(`> ${data.note || "This one isn't deep-graded yet, so this is the fast preview. The full report takes a few minutes."}`, "");
  }
  if (reportText) {
    out.push(reportText({ source: data.source, skills: data.skills || [], partial: null }));
  } else {
    out.push(JSON.stringify(data.skills, null, 2));
  }
  const link = data.source && data.source.url ? `${SITE}?source=${encodeURIComponent(data.source.url)}` : SITE;
  out.push("", `See the full styled report: ${link}`);
  console.log(out.join("\n"));
}

main();
