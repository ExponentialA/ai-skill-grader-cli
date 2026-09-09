const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOCAL_EMAIL_DIR = path.join(os.tmpdir(), "ai-skill-grader", "emails");

function isProductionLike() {
  return Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
}

function senderAddress() {
  return process.env.REPORT_FROM_EMAIL || "AI Skill Grader <reports@aiskillgrader.com>";
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function plain(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

const FLAG_PLAIN = {
  "high score without warnings": "It rates its own output highly but flags no cautions of its own.",
  "side effect action language present": "Its output uses language about taking real actions, like sending, writing, or deleting.",
  "high score low expected coverage": "It rates its output highly but skips checks it was expected to cover.",
  "low expected coverage": "It skips some of the checks it was expected to cover.",
  "missing expected coverage signal": "Its sample output review did not include enough coverage detail to trust the score.",
  "task fit without expected hits": "Its sample answer looked relevant but missed the specific checks we expected it to cover.",
  "weak safety controls": "Its safety controls look weak for what it can do.",
  "high score low context specificity": "It rates itself highly but gives a generic answer that ignores the specifics.",
};

function plainEmailText(value) {
  return plain(value)
    .replace(/Static-only; needs sample-data walkthrough/gi, "Needs testing with sample inputs")
    .replace(/Static-only inspectable/gi, "Reviewed before install")
    .replace(/^critique:\s*/i, "")
    .replace(/^(\d+)\s+(.+?)\s+signals?\s+surfaced\.?$/i, (m, n, flag) => FLAG_PLAIN[flag.toLowerCase().trim()] || m)
    .replace(/Output is very short for a behavioral walkthrough\./gi, "Its sample answer is too thin to show that the skill really handled the task.")
    .replace(/Output barely uses the dummy context\./gi, "Its sample answer barely uses the details it was given.")
    .replace(/Output misses too many expected skill\/task checks\./gi, "Its sample answer skipped parts of the task we expected it to cover.")
    .replace(/Output does not clearly label assumptions\/evidence\/unknowns\./gi, "Its sample answer does not clearly separate facts, assumptions, and unknowns.")
    .replace(/Output lacks clear sandbox\/dummy\/approval controls\./gi, "Its sample answer does not give enough test-data or approval guidance.")
    .replace(/Output appears to claim direct side effects without enough draft\/approval framing\./gi, "Its sample answer talks about taking action without enough review or approval framing.")
    .replace(/\b\d+\s+review signals?\s+surfaced in sample-output checks\.?/gi, "The sample output review found issues to check before relying on it.")
    .replace(/Create a minimal dummy-input fixture from the required-input evidence\./gi, "Try it with a small fake example before using real data.")
    .replace(/dummy-input fixture/gi, "fake example")
    .replace(/required-input evidence/gi, "the inputs it asks for")
    .replace(/dummy inputs/gi, "sample inputs")
    .replace(/statically inspected/gi, "reviewed before install")
    .replace(/behaviorally proven/gi, "proven by running it")
    .replace(/Package text, file inventory, commands, URLs, and risky surfaces were reviewed before install\./gi, "We reviewed the skill's instructions, files, links, commands, and risky surfaces before install.")
    .replace(/Package text, file inventory, and risky surfaces were inspected\./gi, "We reviewed the skill's instructions, files, and risky surfaces before install.")
    .replace(/No package installation was performed\. No network, browser, API, MCP, CRM, cloud, email, or account workflow was executed\. No paid service, production account, or real credential was used\./gi, "We did not connect any accounts, use real credentials, or run production workflows. That is intentional: a generic test cannot prove the skill will behave correctly inside your exact setup.")
    .replace(/Output correctness was not evaluated for this decision-critical skill\./gi, "We did not run an output-quality check for this decision-critical skill.")
    .replace(/Output correctness was not evaluated for this skill\./gi, "We did not run an output-quality check for this skill.")
    .replace(/No obvious state-changing action surface surfaced in static review\./gi, "No obvious state-changing behavior showed up in the pre-install review.");
}

function riskCounts(skills) {
  return (skills || []).reduce(
    (counts, skill) => {
      if (skill && skill.risk && counts[skill.risk] != null) counts[skill.risk] += 1;
      return counts;
    },
    { danger: 0, warn: 0, good: 0 }
  );
}

function sourceTitle(source) {
  return plain((source && source.title) || (source && source.display && source.display.objectName) || "your source");
}

function reportSubject(source, skills) {
  const count = Array.isArray(skills) ? skills.length : 0;
  return `Your AI Skill Grader report: ${sourceTitle(source)}${count > 1 ? ` (${count} skills)` : ""}`;
}

function failureSubject(source) {
  return `We could not finish your AI Skill Grader report: ${sourceTitle(source)}`;
}

function adminFailureSubject(source, userNoticeAttempted = true) {
  return userNoticeAttempted
    ? `AI Skill Grader report job failed: ${sourceTitle(source)}`
    : `AI Skill Grader report job had partial failures: ${sourceTitle(source)}`;
}

function reportsAreMissing(partial) {
  if (!partial) return false;
  if (typeof partial.reportsMissing === "boolean") return partial.reportsMissing;
  return Number(partial.missingReportCount || partial.failedSkillCount || 0) > 0;
}

// Only alarm the user when something they can see is actually affected: a report
// is missing, or a deeper output-trust check did not finish. A background step
// that exited nonzero while every report and check completed is logged for us,
// never surfaced to them as "missing".
function shouldShowPartialBanner(partial) {
  if (!partial) return false;
  return reportsAreMissing(partial) || Boolean(partial.depthIncomplete) || Number(partial.breadthErrorCount || 0) > 0;
}

function partialHeadline(partial) {
  return reportsAreMissing(partial) ? "Some reports are still missing." : "Some deeper checks didn't finish.";
}

function partialNoticeText(partial) {
  if (!partial) return "";
  const missing = Number(partial.missingReportCount || partial.failedSkillCount || 0);
  const breadth = Number(partial.breadthErrorCount || 0);
  if (missing) {
    const depth = partial.breadthDown
      ? ", and some deeper output checks didn't finish"
      : breadth
        ? `, and ${breadth} deeper check${breadth === 1 ? "" : "s"} didn't finish`
        : "";
    return `${missing} skill${missing === 1 ? "" : "s"} couldn't be graded this time${depth}. We included the report${partial.reportCount === 1 ? "" : "s"} we could finish and logged the rest for review.`;
  }
  if (partial.breadthDown) {
    return "Every skill was graded, but the deeper output-trust checks didn't finish, so those reports show lighter output detail. We logged it for follow-up.";
  }
  return "Every skill was graded. Some deeper output checks didn't finish, so a few reports show lighter output-trust detail than usual.";
}

// A checkbox + text laid out as a table so Gmail (which drops flex/gap) keeps
// the spacing and hanging indent.
function checklistItems(items) {
  const list = Array.isArray(items) && items.length ? items : ["No additional detail was available."];
  return list
    .map(
      (item) =>
        `<li style="margin:11px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="padding:2px 12px 0 0;line-height:0"><span style="display:inline-block;width:13px;height:13px;border:2px solid #8a877b;border-radius:4px;background:#fbfbf8"></span></td><td valign="top" style="color:#565349;font-size:15px;line-height:1.5">${escapeHtml(plainEmailText(item))}</td></tr></table></li>`
    )
    .join("");
}

function reportKind(source, skills) {
  if (Array.isArray(skills) && skills.length > 1) return "repo";
  if (source && source.display && source.display.kind === "repo") return "repo";
  return "skill";
}

const EMAIL = {
  wrap: "width:100%;max-width:760px;margin:0 auto;padding:30px 18px 46px;box-sizing:border-box;",
  brand: "font-weight:800;color:#191813;margin:0 0 24px;font-size:18px;line-height:1.2;font-family:Arial,sans-serif;",
  brandMark: "color:#33507a;",
  hero: "border:1px solid #d2cfc3;border-left:7px solid #33507a;border-radius:12px;background:#fbfbf8;padding:28px 26px 22px;margin-bottom:24px;",
  partialNote: "border:1px solid #d2cfc3;border-left:7px solid #a76d0d;border-radius:10px;background:#fff7e8;padding:16px 18px;margin:0 0 24px;color:#565349;",
  partialStrong: "display:block;color:#a76d0d;font-size:16px;margin:0 0 4px;",
  partialP: "margin:0;font-size:14px;line-height:1.45;",
  eyebrow: "font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#33507a;margin:0 0 10px;",
  h1: "font-size:32px;line-height:1.05;margin:0 0 12px;letter-spacing:-.02em;color:#191813;font-family:Arial,sans-serif;",
  h2: "font-size:26px;line-height:1.05;margin:8px 0 0;letter-spacing:-.02em;color:#191813;font-family:Arial,sans-serif;",
  meta: "color:#565349;font-size:15px;margin:0 0 10px;line-height:1.45;overflow-wrap:anywhere;word-break:break-word;",
  chips: "margin-top:15px;",
  chip: "display:inline-block;margin:0 6px 7px 0;padding:6px 10px;border-radius:999px;background:#eceae3;color:#565349;font-size:13px;line-height:1.2;",
  reportHead: "padding:20px 24px 16px;",
  mech: "margin:6px 0 0;color:#565349;font-size:13px;line-height:1.35;",
  summary: "margin:12px 0 0;color:#565349;font-size:15px;line-height:1.5;",
  barH: "height:7px;line-height:7px;font-size:0;background:#191813;",
  barM: "height:3px;line-height:3px;font-size:0;background:#191813;",
  verdict: "padding:14px 24px;",
  verdictLabel: "font-size:24px;font-weight:800;letter-spacing:-.02em;color:#191813;line-height:1.2;font-family:Arial,sans-serif;",
  verdictPill: "display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background:#eceae3;color:#565349;font-size:12px;line-height:1.4;vertical-align:middle;",
  anatomyTable: "width:100%;border-collapse:collapse;table-layout:fixed;",
  anatomyCell: "padding:12px 24px;border-top:1px solid #e2e0d7;vertical-align:top;overflow-wrap:anywhere;word-break:break-word;",
  anatomyLabel: "display:block;margin:0 0 4px;color:#565349;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;line-height:1.35;",
  anatomyValue: "display:block;color:#191813;text-align:left;font-size:14px;line-height:1.45;",
  group: "padding:20px 24px;",
  groupBorder: "border-top:1px solid #e2e0d7;",
  groupH: "font-size:12px;margin:0 0 12px;color:#33507a;text-transform:uppercase;letter-spacing:.05em;font-weight:800;line-height:1.25;font-family:Arial,sans-serif;",
  groupP: "margin:0 0 10px;color:#565349;font-size:15px;line-height:1.5;",
  findingList: "list-style:none;padding-left:0;margin:0;",
  checklist: "list-style:none;padding-left:0;margin:0;",
  scope: "list-style:none;padding-left:0;margin:0;",
  pictureRow: "padding:12px 0;border-top:1px solid #e2e0d7;",
  pictureRowFirst: "padding:0 0 12px;border-top:0;",
  pictureH: "font-size:15px;margin:0 0 4px;color:#191813;font-weight:800;line-height:1.25;font-family:Arial,sans-serif;",
  pictureP: "color:#565349;margin:0;font-size:15px;line-height:1.5;",
  recLabel: "display:block;margin-bottom:6px;color:#565349;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;",
  recText: "margin:0;font-weight:700;color:#191813;font-size:15px;line-height:1.45;",
  footer: "margin-top:28px;padding:16px 18px;border:1px solid #d2cfc3;border-radius:10px;background:#fbfbf8;color:#565349;font-size:13px;line-height:1.5;",
};

function toneColor(tone) {
  if (tone === "danger") return "#c5372b";
  if (tone === "warn") return "#a76d0d";
  if (tone === "good") return "#1d854f";
  return "#191813";
}

function toneWash(tone) {
  if (tone === "danger") return "#f6e7e3";
  if (tone === "warn") return "#f3e9d5";
  if (tone === "good") return "#e7f1ea";
  return "#eceae3";
}

function reportCardStyle(risk) {
  return `background:#fbfbf8;border:1px solid #d2cfc3;border-left:7px solid ${toneColor(risk === "danger" ? "danger" : risk === "warn" ? "warn" : "good")};border-radius:10px;margin-top:24px;overflow:hidden;`;
}

function recCalloutStyle(tone) {
  return `margin-top:14px;padding:14px 16px;border-radius:9px;background:${toneWash(tone)};`;
}

// Colored pills that mirror the site's Facts Panel tags: severity = grey,
// confirmed = red, likely = amber. Inline styles so Gmail keeps the color.
function emailPill(label, kind) {
  const style =
    {
      sev: "color:#565349;background:#eceae3",
      confirmed: "color:#c5372b;background:#f6e7e3",
      likely: "color:#a76d0d;background:#f3e9d5",
    }[kind] || "color:#565349;background:#eceae3";
  return `<span style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;line-height:1.5;padding:2px 8px;border-radius:4px;margin:0 6px 3px 0;white-space:nowrap;${style}">${escapeHtml(label)}</span>`;
}

// Scope labels as pills, mirroring the site: Checked = green, Inferred = amber,
// Not tested = dashed outline.
function scopePill(label) {
  const style =
    {
      checked: "color:#faf9f5;background:#1d854f;border:1px solid #1d854f",
      inferred: "color:#faf9f5;background:#a76d0d;border:1px solid #a76d0d",
      "not tested": "color:#565349;background:#f4f3ef;border:1px dashed #d2cfc3",
    }[String(label).toLowerCase()] || "color:#565349;background:#f4f3ef;border:1px dashed #d2cfc3";
  return `<span style="display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;line-height:1.5;padding:2px 8px;border-radius:4px;margin:0 8px 3px 0;white-space:nowrap;${style}">${escapeHtml(label)}</span>`;
}

function findingItems(skill) {
  if (!Array.isArray(skill.findings) || !skill.findings.length) {
    const item = outputNotEvaluated(skill)
      ? "No package issue flagged in the pre-install review. We did not check its output."
      : "Nothing surfaced in the evaluated review. That is not proof its output is correct.";
    return `<li style="margin:14px 0;color:#191813">${item}</li>`;
  }
  return skill.findings
    .map(([severity, confidence, text]) => {
      const pills =
        (severity ? emailPill(severity, "sev") : "") +
        (confidence ? emailPill(confidence, String(confidence).toLowerCase()) : "");
      return `<li style="margin:14px 0;color:#191813">${pills}${escapeHtml(plainEmailText(text))}</li>`;
    })
    .join("");
}

function pictureRows(skill) {
  if (!Array.isArray(skill.picture) || !skill.picture.length) return "";
  return skill.picture
    .map(([label, text], index) => `<div class="picture-row" style="${index === 0 ? EMAIL.pictureRowFirst : EMAIL.pictureRow}"><h4 style="${EMAIL.pictureH}">${escapeHtml(label)}</h4><p style="${EMAIL.pictureP}">${escapeHtml(plainEmailText(text))}</p></div>`)
    .join("");
}

function scopeItems(skill) {
  const rows = Array.isArray(skill.scope) ? skill.scope : [];
  const labels = new Set(rows.map((row) => String(row[1] || "").toLowerCase()));
  const items = [];
  if (labels.has("checked")) {
    items.push(["Checked", "We reviewed the skill's instructions, files, links, commands, and risky surfaces before install. This helps catch obvious problems before you give it access."]);
  } else {
    items.push(["Checked", "We reviewed the package materials available before install. This helps catch obvious risky surfaces before you give it access."]);
  }
  if (labels.has("inferred")) {
    items.push(["Inferred", "We used the skill's own wording to understand what it appears to do, who it is for, and what it may touch. Treat this as a careful read of the package, not proof from running it in your setup."]);
  }
  if (labels.has("not tested")) {
    items.push(["Not tested", "We did not connect any accounts, use real credentials, or run production workflows. That is intentional: a generic test cannot prove the skill will behave correctly inside your exact setup."]);
  }
  return items;
}

function scopeHtml(skill) {
  return scopeItems(skill)
    .map(([label, text]) => `<li style="margin:12px 0;color:#565349">${scopePill(label)}${escapeHtml(text)}</li>`)
    .join("");
}

function isInstructionOnly(skill) {
  return /\binstruction[- ]only\b/i.test(`${(skill && skill.tag) || ""}`);
}

function touchSnapshot(skill) {
  const text = plain(`${skill.touch || ""} ${skill.summary || ""}`).toLowerCase();
  if (isInstructionOnly(skill)) {
    if (/crm|hubspot|salesforce|customer|lead|prospect|transcript|email|slack|pii|private|sensitive/.test(text)) return "Context you provide";
    if (/financial|finance|revenue|arr|cac|margin|budget|spend|accounting|investor|diligence/.test(text)) return "Business context you provide";
    if (/file|repo|github|code|branch|pull request|pr/.test(text)) return "Files or repo context you provide";
    return "Inputs you provide";
  }
  if (/crm|hubspot|salesforce|customer|transcript|call|email|slack|pii|private|sensitive/.test(text)) return "Sensitive data";
  if (/financial|finance|revenue|arr|cac|margin|budget|spend|accounting|investor|diligence/.test(text)) return "Business numbers";
  if (/file|repo|github|code|branch|pull request|pr/.test(text)) return "Files or repo";
  return "Inputs you provide";
}

function changeSnapshot(skill) {
  // Answer the question ("can it change anything?"), not give advice.
  const text = plain(`${skill.run && skill.run.label} ${skill.run && skill.run.why} ${skill.touch || ""}`).toLowerCase();
  if (isInstructionOnly(skill)) {
    if (/api key|access token|auth token|bearer token|oauth|credential|service account|mcp tool|tool call|function call|webhook|endpoint|runnable command|local script|shell script|python script|node script|\.env/.test(text)) {
      return "Only with connected tools";
    }
    return "No direct write surface found";
  }
  if (/no state-changing|no obvious live-account|safe to inspect|only reads/.test(text)) return "No, it only reads";
  if (/write|create|update|delete|send|publish|deploy|crm|email/.test(text)) return "Yes, it can write";
  if (/sandbox|test|sample|dummy|throwaway|mocked|production/.test(text)) return "Maybe, test in a sandbox first";
  return "Nothing obvious found";
}

function outputNotEvaluated(skill) {
  return Boolean(skill.trust && skill.trust.prominent === false);
}

// A good-risk skill we only statically reviewed: output was not evaluated, so
// lead with the run-safety read we can vouch for.
function headlineIsRunSafety(skill) {
  return skill.risk === "good" && outputNotEvaluated(skill);
}

function verdictTone(skill) {
  if (headlineIsRunSafety(skill)) return (skill.run && skill.run.tone) || "good";
  return skill.risk === "danger" ? "danger" : skill.risk === "warn" ? "warn" : "good";
}

function verdictLineText(skill) {
  // Lead with the run-safety verdict we assessed, not the output-trust
  // non-answer ("We didn't check its output").
  if (headlineIsRunSafety(skill)) return (skill.run && skill.run.label) || "Safe to inspect";
  return skill.verdict || (skill.trust && skill.trust.label) || "";
}

function verdictCount(skill) {
  if (headlineIsRunSafety(skill)) return "output not checked"; // honest caveat, not a count
  if (skill.risk === "good") return "0 issues · not proof it's correct";
  const n = Array.isArray(skill.findings) ? skill.findings.length : 0;
  return n ? `${n} issue${n === 1 ? "" : "s"}` : "";
}

function emailAnatomyRows(skill) {
  const rows = [];
  // When the run-safety read is the headline, don't repeat it as a row.
  if (!headlineIsRunSafety(skill)) {
    const safeTone = skill.run && skill.run.tone === "good" ? "good" : "";
    rows.push(["Safe to try?", (skill.run && skill.run.label) || "Inspect before you run it", safeTone]);
  }
  rows.push(["What it can see", touchSnapshot(skill)]);
  rows.push(["Can it change anything?", changeSnapshot(skill)]);
  return rows;
}

const RISK_ORDER = { danger: 0, warn: 1, good: 2 };
function orderByRisk(skills) {
  return [...(Array.isArray(skills) ? skills : [])].sort((a, b) => {
    const ra = a && a.risk in RISK_ORDER ? RISK_ORDER[a.risk] : 3;
    const rb = b && b.risk in RISK_ORDER ? RISK_ORDER[b.risk] : 3;
    if (ra !== rb) return ra - rb;
    return String((a && a.title) || "").localeCompare(String((b && b.title) || ""));
  });
}

function hasDetailedReport(skill) {
  return Boolean(
    skill &&
      (skill.bl ||
        (Array.isArray(skill.picture) && skill.picture.length) ||
        (Array.isArray(skill.checklist) && skill.checklist.length) ||
        (Array.isArray(skill.scope) && skill.scope.length) ||
        (Array.isArray(skill.after) && skill.after.length))
  );
}

function reportHtml({ source, skills, partial }) {
  const ordered = orderByRisk(skills);
  const counts = riskCounts(ordered);
  const kind = reportKind(source, ordered);
  const need = counts.danger + counts.warn;
  const attention = ordered.filter((s) => s && (s.risk === "danger" || s.risk === "warn"));
  // Summary-first: the headline is the bottom line, and a multi-skill report
  // names the skills that need attention up top (risky-first below), so the
  // answer and the skills that matter survive Gmail's ~102KB clip.
  const h1Text =
    ordered.length <= 1
      ? "Your AI skill report is ready"
      : need
        ? `${need} of ${ordered.length} skills need a closer look`
        : `All ${ordered.length} skills passed our pre-install checks`;
  const summaryInner =
    ordered.length <= 1
      ? ""
      : attention.length
        ? `<div style="margin:16px 0 0;"><p class="eyebrow" style="${EMAIL.eyebrow}">Needs your attention</p><ul style="margin:0;padding-left:20px;color:#565349;font-size:15px;line-height:1.5;">${attention
            .map((s) => `<li style="margin:7px 0;"><strong style="color:#191813;">${escapeHtml(s.title)}</strong> — ${escapeHtml(verdictLineText(s))}</li>`)
            .join("")}</ul>${counts.good ? `<p style="margin:12px 0 0;color:#565349;font-size:14px;line-height:1.5;">The other ${counts.good} ran clean in our checks. Clean isn't proof they're correct — double-check anything you'll rely on.</p>` : ""}</div>`
        : `<p style="margin:14px 0 0;color:#565349;font-size:14px;line-height:1.5;">All ${ordered.length} passed our pre-install checks. Clean isn't proof they're correct — double-check anything you'll rely on.</p>`;
  const countLine = [
    `${ordered.length} ${ordered.length === 1 ? "skill" : "skills"} reviewed`,
    counts.danger ? `${counts.danger} do not trust` : "",
    counts.warn ? `${counts.warn} use with care` : "",
    counts.good ? `${counts.good} no issues flagged` : "",
  ].filter(Boolean).join(" · ");

  const reports = ordered.map((skill, index) => {
    const anatomy = emailAnatomyRows(skill)
      .map(([l, v, tone], rowIndex) => {
        const topBorder = rowIndex === 0 ? "border-top:0;" : "";
        const valueTone = tone === "good" ? "color:#1d854f;font-weight:700;" : "";
        return `<tr><td class="anatomy-cell" style="${EMAIL.anatomyCell}${topBorder}"><span style="${EMAIL.anatomyLabel}">${escapeHtml(l)}</span><span style="${EMAIL.anatomyValue}${valueTone}">${escapeHtml(plainEmailText(v))}</span></td></tr>`;
      })
      .join("");
    const count = verdictCount(skill);
    const blTone = escapeHtml((skill.bl && skill.bl.tone) || skill.risk || "good");
    const verdict = verdictTone(skill);
    const bottomLine = skill.bl
      ? `
      <div class="fr-group" style="${EMAIL.group}${EMAIL.groupBorder}">
        <h3 style="${EMAIL.groupH}">The bottom line</h3>
        <h4 class="bl-title ${blTone}" style="font-size:20px;line-height:1.14;margin:0 0 10px;color:${toneColor(blTone)};font-family:Arial,sans-serif;">${escapeHtml(plainEmailText(skill.bl.title || ""))}</h4>
        <p style="${EMAIL.groupP}">${escapeHtml(plainEmailText(skill.bl.answer || ""))}</p>
        <div class="rec-callout ${blTone}" style="${recCalloutStyle(blTone)}">
          <span style="${EMAIL.recLabel}">What to do</span>
          <p style="${EMAIL.recText}color:${toneColor(blTone)};">${escapeHtml(plainEmailText(skill.bl.rec || "Test it before you rely on it."))}</p>
        </div>
      </div>`
      : "";
    return `
    <section class="report-card ${escapeHtml(skill.risk || "good")}" style="${reportCardStyle(skill.risk || "good")}">
      <div class="report-head" style="${EMAIL.reportHead}">
        <p class="eyebrow" style="${EMAIL.eyebrow}">Skill ${index + 1} of ${ordered.length}</p>
        <h2 style="${EMAIL.h2}">${escapeHtml(skill.title)}</h2>
        <p class="mech" style="${EMAIL.mech}">${escapeHtml(skill.tag || "reviewed skill")}</p>
        <p class="summary" style="${EMAIL.summary}">${escapeHtml(plainEmailText(skill.summary || ""))}</p>
      </div>
      <div class="bar-h" style="${EMAIL.barH}"></div>
      <div class="verdict ${escapeHtml(verdict)}" style="${EMAIL.verdict}">
        <span class="vl" style="${EMAIL.verdictLabel}color:${toneColor(verdict)};">${escapeHtml(verdictLineText(skill))}</span>${count ? `<span class="vpill" style="${EMAIL.verdictPill}background:${toneWash(verdict)};color:${toneColor(verdict)};">${escapeHtml(count)}</span>` : ""}
      </div>
      <div class="bar-m" style="${EMAIL.barM}"></div>
      <table class="anatomy" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${EMAIL.anatomyTable}">${anatomy}</table>
      <div class="bar-h" style="${EMAIL.barH}"></div>
      <div class="fr-group" style="${EMAIL.group}">
        <h3 style="${EMAIL.groupH}">What we found</h3>
        <ul class="findings" style="${EMAIL.findingList}">${findingItems(skill)}</ul>
      </div>
      <div class="bar-h" style="${EMAIL.barH}"></div>${bottomLine}
      <div class="fr-group" style="${EMAIL.group}${EMAIL.groupBorder}">
        <h3 style="${EMAIL.groupH}">The full picture</h3>
        <div class="picture">${pictureRows(skill)}</div>
      </div>
      <div class="fr-group" style="${EMAIL.group}${EMAIL.groupBorder}">
        <h3 style="${EMAIL.groupH}">Before you install</h3>
        <ul class="checklist" style="${EMAIL.checklist}">${checklistItems(skill.checklist)}</ul>
      </div>
      <div class="fr-group" style="${EMAIL.group}${EMAIL.groupBorder}">
        <h3 style="${EMAIL.groupH}">What we checked</h3>
        <ul class="scope" style="${EMAIL.scope}">${scopeHtml(skill)}</ul>
      </div>
      <div class="fr-group" style="${EMAIL.group}${EMAIL.groupBorder}">
        <h3 style="${EMAIL.groupH}">After you install</h3>
        ${skill.afterNote ? `<p style="margin:0 0 10px;color:#565349;font-size:15px;line-height:1.5">${escapeHtml(plainEmailText(skill.afterNote))}</p>` : ""}
        <ul class="checklist" style="${EMAIL.checklist}">${checklistItems(skill.after)}</ul>
      </div>
    </section>
  `;
  }).join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- Styles are inlined per element (see the EMAIL constants) so they survive clients that drop embedded stylesheets. -->
  </head>
  <body style="margin:0;background:#f4f3ef;color:#191813;font-family:Arial,sans-serif;line-height:1.55;">
    <div class="wrap" style="${EMAIL.wrap}">
      <p class="brand" style="${EMAIL.brand}"><span class="bmk" style="${EMAIL.brandMark}">{</span>A<span class="bmk" style="${EMAIL.brandMark}">}</span>&nbsp;AI Skill Grader</p>
      <div class="hero" style="${EMAIL.hero}">
        <p class="eyebrow" style="${EMAIL.eyebrow}">Detailed ${escapeHtml(kind)} report</p>
        <h1 style="${EMAIL.h1}">${escapeHtml(h1Text)}</h1>
        <p class="meta" style="${EMAIL.meta}">${escapeHtml(countLine)} for ${escapeHtml(sourceTitle(source))}</p>
        <div class="chips" style="${EMAIL.chips}">
          ${counts.danger ? `<span class="chip danger" style="${EMAIL.chip}background:#f6e7e3;color:#c5372b;">${counts.danger} do not trust</span>` : ""}
          ${counts.warn ? `<span class="chip warn" style="${EMAIL.chip}background:#f3e9d5;color:#a76d0d;">${counts.warn} use with care</span>` : ""}
          ${counts.good ? `<span class="chip good" style="${EMAIL.chip}background:#e7f1ea;color:#1d854f;">${counts.good} no issues flagged</span>` : ""}
        </div>
        ${summaryInner}
        ${source && source.url ? `<p class="meta" style="${EMAIL.meta}"><a href="${escapeHtml(source.url)}" style="color:#33507a;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(source.url)}</a></p>` : ""}
      </div>
      ${
        shouldShowPartialBanner(partial)
          ? `<div class="partial-note" style="${EMAIL.partialNote}">
              <strong style="${EMAIL.partialStrong}">${escapeHtml(partialHeadline(partial))}</strong>
              <p style="${EMAIL.partialP}">${escapeHtml(partialNoticeText(partial))}</p>
            </div>`
          : ""
      }
      ${reports}
      <p class="footer" style="${EMAIL.footer}">AI Skill Grader gives pre-install reviews. We do not connect to live accounts, use production credentials, or claim that a generic test proves the skill will be correct in your exact setup.</p>
    </div>
  </body>
</html>`;
}

function reportText({ source, skills, partial }) {
  const ordered = orderByRisk(skills);
  const counts = riskCounts(ordered);
  const need = counts.danger + counts.warn;
  const attention = ordered.filter((s) => s && (s.risk === "danger" || s.risk === "warn"));
  const lines = [
    "AI Skill Grader",
    "",
    `Your detailed report for ${sourceTitle(source)}`,
    source && source.url ? source.url : "",
    "",
  ];
  if (shouldShowPartialBanner(partial)) {
    lines.push(partialHeadline(partial), partialNoticeText(partial), "");
  }
  if (ordered.length > 1) {
    lines.push(
      need ? `${need} of ${ordered.length} skills need a closer look.` : `All ${ordered.length} skills passed our pre-install checks.`,
      ""
    );
    if (attention.length) {
      lines.push("Needs your attention:");
      attention.forEach((s) => lines.push(`- ${s.title} — ${verdictLineText(s)}`));
      if (counts.good) lines.push(`The other ${counts.good} ran clean in our checks. Clean isn't proof they're correct.`);
      lines.push("");
    }
  }
  ordered.forEach((skill, index) => {
    const previewOnly = !hasDetailedReport(skill);
    if (previewOnly) {
      lines.push(
        `Skill ${index + 1} of ${ordered.length}: ${skill.title}`,
        `Preview verdict: ${verdictLineText(skill)}`,
        plainEmailText(skill.summary || ""),
        "",
        "Fast preview:",
        ...emailAnatomyRows(skill).map(([label, value]) => `- ${label}: ${plainEmailText(value)}`),
        `- What we found: ${Array.isArray(skill.findings) && skill.findings.length ? verdictCount(skill) : "No package issue flagged in the pre-install review."}`,
        "",
        "The detailed report has not been produced yet. It takes a few minutes because deeper grading uses a separate background check.",
        ""
      );
      return;
    }
    lines.push(
      `Skill ${index + 1} of ${ordered.length}: ${skill.title}`,
      `Verdict: ${verdictLineText(skill)}`,
      plainEmailText(skill.summary || ""),
      "",
      `Bottom line: ${plain((skill.bl && skill.bl.title) || "")}`,
      plainEmailText((skill.bl && skill.bl.answer) || ""),
      ...(skill.bl && skill.bl.rec ? ["", `What to do: ${plainEmailText(skill.bl.rec)}`] : []),
      "",
      "What we found:",
      ...(Array.isArray(skill.findings) && skill.findings.length
        ? skill.findings.map(([severity, confidence, text]) => `- ${severity}/${confidence}: ${plainEmailText(text)}`)
        : ["- No detailed issue was listed for this skill."]),
      "",
      "The full picture:",
      ...(Array.isArray(skill.picture) ? skill.picture.map(([label, text]) => `- ${label}: ${plainEmailText(text)}`) : []),
      "",
      "Before you install:",
      ...(Array.isArray(skill.checklist) ? skill.checklist.map((item) => `- ${plainEmailText(item)}`) : []),
      "",
      "What we checked:",
      ...scopeItems(skill).map(([label, text]) => `- ${label}: ${text}`),
      "",
      "After you install:",
      ...(skill.afterNote ? [plainEmailText(skill.afterNote)] : []),
      ...(Array.isArray(skill.after) ? skill.after.map((item) => `- ${plainEmailText(item)}`) : []),
      ""
    );
  });
  lines.push("AI Skill Grader gives pre-install reviews. We do not connect to live accounts, use production credentials, or claim that a generic test proves the skill will be correct in your exact setup.");
  return lines.filter((line) => line != null).join("\n");
}

function failureTitle(failure) {
  return plain((failure && failure.title) || "We could not finish this report.");
}

function failureMessage(failure) {
  return plain(
    (failure && failure.message) ||
      "We started the detailed report, but the background check did not finish. You can try again later, or reply to this email and we can look at the source."
  );
}

function failureAction(failure) {
  const reason = failure && failure.reason;
  if (reason === "no_skills") {
    return "Check that the link points to a repo, skill folder, or direct SKILL.md file, then submit it again.";
  }
  if (reason === "repo_unreadable") {
    return "Check that the repo is public and the URL is still current, then submit it again.";
  }
  if (reason === "path_not_found") {
    return "Check the branch, commit, folder, or SKILL.md path in the URL, then submit it again.";
  }
  if (reason === "timed_out") {
    return "You can try again later. Large repos may need a little more time or a smaller source path.";
  }
  return "You can try again later, or reply to this email if you want us to look at the source.";
}

function failureHtml({ source, failure = null }) {
  const title = sourceTitle(source);
  const sourceUrl = source && source.url ? source.url : "";
  const headline = failureTitle(failure);
  const message = failureMessage(failure);
  const action = failureAction(failure);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AI Skill Grader report status</title>
  </head>
  <body style="margin:0;background:#f4f3ef;color:#191813;font-family:Arial,sans-serif;">
    <div style="max-width:680px;margin:0 auto;padding:28px 18px;">
      <div style="border:1px solid #d2cfc3;border-left:7px solid #a76d0d;border-radius:10px;background:#fbfbf8;padding:24px;">
        <p style="margin:0 0 10px;color:#33507a;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">AI Skill Grader</p>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.08;">${escapeHtml(headline)}</h1>
        <p style="margin:0 0 12px;color:#565349;font-size:16px;line-height:1.5;">${escapeHtml(message)}</p>
        <p style="margin:0 0 12px;color:#565349;font-size:16px;line-height:1.5;">Source: ${escapeHtml(title)}</p>
        ${sourceUrl ? `<p style="margin:0 0 12px;color:#565349;font-size:14px;line-height:1.5;"><a href="${escapeHtml(sourceUrl)}" style="color:#33507a;">${escapeHtml(sourceUrl)}</a></p>` : ""}
        <p style="margin:0 0 12px;color:#565349;font-size:16px;line-height:1.5;">${escapeHtml(action)}</p>
        <p style="margin:18px 0 0;color:#8a877b;font-size:13px;line-height:1.5;">No accounts or credentials were connected.</p>
      </div>
    </div>
  </body>
</html>`;
}

function failureText({ source, failure = null }) {
  const action = failureAction(failure);
  const lines = [
    "AI Skill Grader",
    "",
    failureTitle(failure),
    failureMessage(failure),
    "",
    `Source: ${sourceTitle(source)}`,
    source && source.url ? source.url : "",
    "",
    action,
    "",
    "No accounts or credentials were connected.",
  ];
  return lines.filter(Boolean).join("\n");
}

function adminFailureHtml({ source, userEmail, unlockToken, error, failureLogPath, userNoticeAttempted = true, failure = null }) {
  const title = sourceTitle(source);
  const sourceUrl = source && source.url ? source.url : "";
  const message = error && error.message ? error.message : String(error || "Unknown error");
  const heading = userNoticeAttempted ? "Background report job failed." : "Background report job had partial failures.";
  const intro = userNoticeAttempted
    ? "A user-facing failure notice was attempted. Check the workflow artifact for the masked failure log."
    : "The user report was sent with the reportable skills. Check the workflow artifact for the masked issue log.";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0;background:#f4f3ef;color:#191813;font-family:Arial,sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:28px 18px;">
      <div style="border:1px solid #d2cfc3;border-left:7px solid #a76d0d;border-radius:10px;background:#fbfbf8;padding:24px;">
        <p style="margin:0 0 10px;color:#33507a;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">AI Skill Grader</p>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.08;">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 14px;color:#565349;font-size:16px;line-height:1.5;">${escapeHtml(intro)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Source</td><td style="padding:8px 0;color:#191813;font-size:14px;">${escapeHtml(title)}</td></tr>
          ${sourceUrl ? `<tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">URL</td><td style="padding:8px 0;color:#191813;font-size:14px;"><a href="${escapeHtml(sourceUrl)}" style="color:#33507a;">${escapeHtml(sourceUrl)}</a></td></tr>` : ""}
          <tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Requester</td><td style="padding:8px 0;color:#191813;font-size:14px;">${escapeHtml(userEmail || "unknown")}</td></tr>
          <tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Token</td><td style="padding:8px 0;color:#191813;font-size:14px;">${escapeHtml(unlockToken || "report")}</td></tr>
          ${failure ? `<tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Reason</td><td style="padding:8px 0;color:#191813;font-size:14px;">${escapeHtml(failure.reason || "unknown")} · ${escapeHtml(failure.title || "")}</td></tr>` : ""}
          ${failureLogPath ? `<tr><td style="padding:8px 0;color:#8a877b;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Log</td><td style="padding:8px 0;color:#191813;font-size:14px;">${escapeHtml(failureLogPath)}</td></tr>` : ""}
        </table>
        <div style="border:1px solid #d2cfc3;background:#fff;border-radius:8px;padding:14px;margin-top:14px;">
          <p style="margin:0;color:#8a1f11;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">Error</p>
          <p style="margin:8px 0 0;color:#191813;font-size:14px;line-height:1.45;font-family:Menlo,Consolas,monospace;">${escapeHtml(message)}</p>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function adminFailureText({ source, userEmail, unlockToken, error, failureLogPath, userNoticeAttempted = true, failure = null }) {
  const message = error && error.message ? error.message : String(error || "Unknown error");
  const lines = [
    userNoticeAttempted ? "AI Skill Grader background report job failed" : "AI Skill Grader background report job had partial failures",
    "",
    `Source: ${sourceTitle(source)}`,
    source && source.url ? `URL: ${source.url}` : "",
    `Requester: ${userEmail || "unknown"}`,
    `Token: ${unlockToken || "report"}`,
    failure ? `Reason: ${failure.reason || "unknown"} - ${failure.title || ""}` : "",
    failureLogPath ? `Failure log: ${failureLogPath}` : "",
    "",
    `Error: ${message}`,
    "",
    userNoticeAttempted
      ? "A user-facing failure notice was attempted. Check the workflow artifact for the masked failure log."
      : "The user report was sent with the reportable skills. Check the workflow artifact for the masked issue log.",
  ];
  return lines.filter(Boolean).join("\n");
}

function writeLocalEmail(payload) {
  fs.mkdirSync(LOCAL_EMAIL_DIR, { recursive: true });
  const recipient = Array.isArray(payload.to) ? payload.to[0] : payload.to;
  const file = path.join(LOCAL_EMAIL_DIR, `${Date.now()}-${String(recipient).replace(/[^a-z0-9.-]+/gi, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

async function sendViaResend(payload, unlockToken) {
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": `ai-skill-grader:${unlockToken}:${payloadHash}`,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(async () => ({ message: await response.text().catch(() => "") }));
  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}: ${body.message || body.error || JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

async function sendUnlockReportEmail({ email, source, unlockToken, skills, partial = null }) {
  const payload = {
    from: senderAddress(),
    to: [email],
    subject: reportSubject(source, skills),
    html: reportHtml({ source, skills, partial }),
    text: reportText({ source, skills, partial }),
  };
  if (process.env.REPORT_REPLY_TO_EMAIL) payload.reply_to = process.env.REPORT_REPLY_TO_EMAIL;

  if (process.env.RESEND_API_KEY) {
    const response = await sendViaResend(payload, unlockToken);
    return { ok: true, mode: "resend", id: response.id, from: payload.from };
  }

  if (isProductionLike()) {
    return {
      ok: false,
      status: 503,
      error: "Report email is not configured yet.",
    };
  }

  return { ok: true, mode: "local-file", path: writeLocalEmail(payload), from: payload.from };
}

async function sendReportFailureEmail({ email, source, unlockToken, failure = null }) {
  const payload = {
    from: senderAddress(),
    to: [email],
    subject: failureSubject(source),
    html: failureHtml({ source, failure }),
    text: failureText({ source, failure }),
  };
  if (process.env.REPORT_REPLY_TO_EMAIL) payload.reply_to = process.env.REPORT_REPLY_TO_EMAIL;

  if (process.env.RESEND_API_KEY) {
    const response = await sendViaResend(payload, `${unlockToken || "report"}:failed`);
    return { ok: true, mode: "resend", id: response.id, from: payload.from };
  }

  if (isProductionLike()) {
    return {
      ok: false,
      status: 503,
      error: "Report email is not configured yet.",
    };
  }

  return { ok: true, mode: "local-file", path: writeLocalEmail(payload), from: payload.from };
}

async function sendReportAdminFailureEmail({ adminEmail, source, userEmail, unlockToken, error, failureLogPath, userNoticeAttempted = true, failure = null }) {
  if (!adminEmail) {
    return { ok: false, skipped: true, error: "REPORT_ADMIN_EMAIL is not configured." };
  }
  const payload = {
    from: senderAddress(),
    to: [adminEmail],
    subject: adminFailureSubject(source, userNoticeAttempted),
    html: adminFailureHtml({ source, userEmail, unlockToken, error, failureLogPath, userNoticeAttempted, failure }),
    text: adminFailureText({ source, userEmail, unlockToken, error, failureLogPath, userNoticeAttempted, failure }),
  };
  if (process.env.REPORT_REPLY_TO_EMAIL) payload.reply_to = process.env.REPORT_REPLY_TO_EMAIL;

  if (process.env.RESEND_API_KEY) {
    const response = await sendViaResend(payload, `${unlockToken || "report"}:admin-failed`);
    return { ok: true, mode: "resend", id: response.id, from: payload.from };
  }

  if (isProductionLike()) {
    return {
      ok: false,
      status: 503,
      error: "Report email is not configured yet.",
    };
  }

  return { ok: true, mode: "local-file", path: writeLocalEmail(payload), from: payload.from };
}

module.exports = {
  reportText,
  sendUnlockReportEmail,
  sendReportFailureEmail,
  sendReportAdminFailureEmail,
};
