#!/usr/bin/env node
// Shared installed-tool report command. It fetches the same report the website
// and email use, then prints it into the agent session.
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
  const project = process.env.CURSOR_PROJECT_DIR || process.env.ROOT_WORKSPACE_PATH || process.cwd();
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const roots = [
    path.join(project, ".agents", "skills"),
    path.join(project, ".codex", "skills"),
    path.join(project, ".claude", "skills"),
    path.join(project, ".cursor", "skills"),
    path.join(project, ".windsurf", "skills"),
    path.join(project, ".clinerules", "skills"),
    path.join(codexHome, "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".windsurf", "skills"),
    path.join(home, "Documents", "Cline", "Skills"),
  ];
  // Claude plugin-provided skills live under ~/.claude/plugins/*/skills. The Claude
  // scan hooks look there, so the report must too, or a plugin skill we warned on
  // can't be found by name here.
  const pluginsDir = path.join(home, ".claude", "plugins");
  try {
    for (const name of fs.readdirSync(pluginsDir)) roots.push(path.join(pluginsDir, name, "skills"));
  } catch (_error) {
    /* no plugins dir */
  }
  return roots;
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
  const url = data.source && data.source.url;
  const webLink = url ? `${SITE}source.html?source=${encodeURIComponent(url)}` : SITE;
  if (!data.graded) {
    out.push(`> ${data.note || "This is the fast preview. We haven't deep-graded this skill yet, so the full report isn't instant."}`, "");
  }
  if (reportText) {
    out.push(reportText({ source: data.source, skills: data.skills || [], partial: null }));
  } else {
    out.push(JSON.stringify(data.skills, null, 2));
  }
  if (data.graded) {
    out.push("", `See it styled on the web: ${webLink}`);
  } else {
    // Novel skill: the deep grade is produced on request and delivered by email only.
    // Do not imply it will appear here or on the web page (it will not, until Tier 2).
    out.push(
      "",
      "To get the full deep report:",
      `Open ${webLink} and enter your email. We run the deeper grade in the background and email it to you; it will not show up here or on the web page, only by email.`,
      "(Skills we have already graded return the full report here instantly. New ones like this are graded on request.)"
    );
  }
  console.log(out.join("\n"));
}

main();
