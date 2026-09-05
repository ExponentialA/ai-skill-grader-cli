const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const PREVIEW_CAP = 6;
const LIVE_SOURCE_SKILL_LIMIT = 80;
const LIVE_SOURCE_FETCH_CONCURRENCY = 6;
const PRODUCTION_CACHE_PATH = path.resolve(__dirname, "..", "data", "report-cache.json");
const CLEAN_FINDINGS = "Nothing surfaced in the evaluated review. Its output still needs testing with your own inputs.";
const PACKAGE_REVIEW_CLEAN = "No package issue flagged in the pre-install review. It still needs testing with your own inputs.";
const DECISION_CRITICAL_RE = new RegExp(
  [
    "legal",
    "compliance",
    "contract",
    "\\bpolicy\\b",
    "\\bsoc\\s*2?\\b",
    "\\bsox\\b",
    "\\bgdpr\\b",
    "\\bhipaa\\b",
    "medical",
    "health",
    "clinical",
    "diagnos",
    "treatment",
    "finance",
    "financial",
    "accounting",
    "\\btax\\b",
    "\\baudit\\b",
    "valuation",
    "forecast",
    "trading",
    "investment",
    "investor",
    "diligence",
    "security",
    "vulnerab",
    "credential",
    "access control",
    "incident",
    "\\bspend\\b",
    "\\bbudget\\b",
    "\\bpaid\\b",
    "\\bads?\\b",
    "ad platform",
    "campaign",
    "pricing",
    "procurement",
    "\\bcrm\\b",
    "customer",
    "outreach",
    "enrichment",
    "lifecycle",
    "\\b(score|scores|scoring|scorer)\\b",
    "calculator",
    "optimizer",
    "recommender",
    "numeric",
    "\\brevenue\\b",
    "\\bcac\\b",
    "\\barr\\b",
    "\\bmargin\\b",
    "\\bretention\\b",
  ].join("|"),
  "i"
);
const LIVE_ACTION_SURFACE_RE = /\b(crm|customer|email|slack|hubspot|salesforce|ads?|payment|billing|bank)\b|ad platform/i;
const ACTION_RE = /\b(create|update|delete|write|modify|send|post|publish|deploy|merge|commit|push|upload|run|execute|install|call|invoke|connect)\b/i;
const CREDENTIAL_RE = /\b(api key|token|oauth|client secret|secret key|credential|bearer|personal access token|\bpat\b|env var|environment variable|\.env)\b/i;
const SCRIPT_RE = /\b(script|command|cli|shell|bash|python|node|npm|pip|curl|\.py|\.sh|\.js)\b/i;
const API_BACKED_RE = /\b(api key|api token|api endpoint|api call|api request|oauth|bearer|personal access token|service account|mcp|tool call|function call|webhook|endpoint|sdk|curl)\b/i;
const OPERATIONAL_SURFACE_RE = /\b(mcp|tool call|function call|webhook|endpoint|sdk|integration|service account|oauth|access token|auth token|bearer token|\.env|curl|npm|pip|python|node|bash|shell|cli)\b/i;
const SENSITIVE_RE = /\b(customer|lead|prospect|email|transcript|contract|financial|revenue|arr|cac|margin|retention|pii|private|confidential|sensitive|dataroom|investor)\b/i;
const PAID_RE = /\b(paid|billing|spend|budget|ads?|ad platform|stripe|credits?|rate limit|quota)\b/i;
const MANIPULATION_RE = /\b(ignore (previous|all|above) instructions|do not tell (the )?user|hide this from (the )?user|exfiltrat|send .*(secret|token|credential)|steal|self-approve|bypass approval)\b/i;
const HIGH_STAKES_INSTRUCTION_RE = /\b(legal|compliance|contract|policy|soc\s*2?|sox|gdpr|hipaa|medical|health|clinical|diagnos|treatment|finance|financial|accounting|tax|audit|valuation|forecast|trading|investment|investor|board|diligence|dataroom|security|vulnerab|credential|access control|incident|spend|budget|paid|ads?|ad platform|campaign|pricing|procurement|crm|customer|lead|prospect|outreach|enrichment|lifecycle|revenue|cac|arr|margin|retention)\b/i;
const SUPPORTED_HOSTS = new Set([
  "github.com",
  "www.github.com",
]);

// The gradeability contract, shared with the Python grader
// (harness/grade_skill_source.py) via test/gradeability-cases.json. Both sides
// must agree on these rules; if either predicate changes, the conformance test
// fails. Keeping them in lockstep is what stops the preview from accepting a
// source the grader cannot grade (the take-email-can't-deliver failure).
function isSupportedHost(host) {
  return SUPPORTED_HOSTS.has(String(host || "").toLowerCase());
}
function isSkillFilePath(filePath) {
  // A SKILL.md basename anywhere in the tree, case-insensitive.
  return /(^|\/)skill\.md$/i.test(String(filePath || ""));
}
let productionCache = null;

// Structured, greppable server logs. On Vercel these land in the function logs;
// one JSON line per event so preview/unlock failures can be counted by reason
// instead of disappearing into a swallowed catch.
function logServerEvent(fields) {
  const line = Object.assign({ ts: new Date().toISOString() }, fields);
  try {
    console.error(JSON.stringify(line));
  } catch (_error) {
    console.error((fields && fields.event) || "log_error");
  }
}

// sha256 of the SKILL.md text, matching the harness's skill_md_sha256 (a sha256
// of the file). Lets the live path tell whether a cached grade still matches the
// file on GitHub before we trust it.
function contentSha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// A cached payload is "fingerprinted" once its skills carry contentSha256. Only
// then can we verify freshness; legacy entries without it are trusted as before.
function cachedPayloadHasFingerprint(payload) {
  return Boolean(payload && Array.isArray(payload.skills) && payload.skills.some((skill) => skill && skill.contentSha256));
}

function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch (_error) {
    return { ok: false, reason: "invalid_url", error: "That doesn't look like a valid URL. Paste a GitHub repo or SKILL.md link." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, reason: "bad_protocol", error: "Use an http or https link." };
  }
  const host = parsed.hostname.toLowerCase();
  if (!isSupportedHost(host)) {
    return { ok: false, reason: "unsupported_host", error: "We can only read public GitHub links right now. Paste a github.com repo or SKILL.md URL." };
  }
  parsed.hash = "";
  const normalized = parsed.toString().replace(/\/$/, "");
  return {
    ok: true,
    id: crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16),
    title: readableSourceTitle(normalized),
    display: sourceDisplayParts(normalized),
    url: normalized,
  };
}

function normalizedUrlKey(value) {
  const normalized = normalizeSourceUrl(value);
  return normalized.ok ? normalized.url : null;
}

function readableSourceTitle(sourceUrl) {
  const display = sourceDisplayParts(sourceUrl);
  if (display.kind === "skill") return display.objectName;
  if (display.kind === "repo") return `${display.owner} / ${display.objectName}`;
  return display.objectName;
}

function sourceDisplayParts(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.hostname.toLowerCase().includes("github.com") && parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, "");
      const skillsIndex = parts.lastIndexOf("skills");
      if (skillsIndex >= 0 && skillsIndex < parts.length - 1) {
        const last = parts[parts.length - 1];
        const objectPart = /^skill\.md$/i.test(last) && parts.length > skillsIndex + 1 ? parts[parts.length - 2] : last;
        return {
          kind: "skill",
          objectName: objectPart.replace(/-/g, " "),
          owner,
          repo,
        };
      }
      return {
        kind: "repo",
        objectName: repo.replace(/-/g, " "),
        owner,
        repo,
      };
    }
  } catch (_error) {
    // Fall through to compact URL.
  }
  return {
    kind: "source",
    objectName: String(sourceUrl).replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""),
    owner: "",
    repo: "",
  };
}

function isLikelySingleSkill(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname.replace(/\/$/, "");
    if (/\/skill\//.test(path)) return true;
    if (u.hostname.includes("github.com") && /\/(tree|blob)\/[^/]+\/.*\bskills\/[^/]+/.test(path)) return true;
    return false;
  } catch (_error) {
    return false;
  }
}

function cleanSkill(id, title, tag, summary, touch, does, wrong) {
  return {
    id,
    risk: "good",
    title,
    tag,
    verdict: "Nothing flagged",
    sub: tag,
    summary,
    run: {
      tone: "good",
      label: "Safe to inspect",
      why: "We found no state-changing actions. Try it on sample inputs before anything real.",
    },
    trust: {
      tone: "good",
      label: "Nothing flagged",
      why: "No output defect surfaced in the evaluated review. Treat what it produces as a draft, not a fact.",
    },
    finding: {
      tone: "good",
      text: "Nothing surfaced in the evaluated review. Its output still needs testing with your own inputs.",
    },
    touch,
    verify: "Read its output against something you already trust before you rely on it.",
    checked: "We reviewed the code and a sample run. No live account was connected.",
    bl: {
      tone: "good",
      title: "Low-risk, but read its output.",
      answer: `${does} It can still miss context, so give what it produces a human check before you rely on it.`,
      rec: "Safe to inspect. Review its output before you use it.",
    },
    findings: [],
    picture: [
      ["What it actually does", does],
      ["What can go wrong", wrong],
      ["What it needs access to", touch],
    ],
    checklist: ["Try it on sample inputs first.", "Read the output before you use it.", "Keep a human in the loop."],
    scope: [
      ["v", "Checked", "The code and a sample run."],
      ["i", "Inferred", "The intended use, from its docs."],
      ["n", "Not tested", "Live systems, and whether its output fits your case."],
    ],
    afterNote: "Worth a look once it is in your workflow.",
    after: ["Compare its output to something you trust.", "Keep a review step before it ships."],
  };
}

const SAMPLE_SKILLS = [
  {
    id: "channel-economics",
    risk: "danger",
    title: "channel-economics",
    tag: "script-backed",
    verdict: "Do not trust output",
    sub: "6 issues, 1 confirmed",
    summary:
      "A finance/GTM skill that analyzes channel economics. It has real substance, but we found math errors big enough to flip its recommendation.",
    run: {
      tone: "good",
      label: "Safe to test locally",
      why: "It runs local scripts, and we found no signs of manipulation. Test it with dummy data before you use real numbers.",
    },
    trust: {
      tone: "danger",
      label: "Do not trust output",
      why: "We found 6 serious issues. One is a math error we confirmed by reproducing it.",
    },
    finding: {
      tone: "danger",
      text: "6 issues found, 1 confirmed. The confirmed one is a math error that can flip the skill's recommendation.",
    },
    touch: "The financial numbers you give it: revenue, margin, CAC, retention. It reads them. It cannot spend money or reach a live account.",
    verify: "Redo its sample math by hand before you trust any number it gives you.",
    checked: "We read the code and ran its sample in a sandbox. We did not connect a real account or your data.",
    bl: {
      tone: "danger",
      title: "Do not rely on this skill's numbers yet.",
      answer:
        "The intent is real and the scripts run. But the math has errors big enough to flip its answer. It is fine to open and test locally. Just keep its output out of budget and channel decisions until the math is fixed and re-checked.",
      rec: "Keep it out of real GTM planning until the math is fixed, or check every number it gives you by hand.",
    },
    findings: [
      ["High", "confirmed", "The optimizer scores the wrong goal and leaves ARR out entirely."],
      ["High", "likely", "The gross-margin figure looks like it leaves out COGS."],
      ["High", "likely", "The docs say retention is per-channel, but the model uses one blended number."],
      ["High", "likely", "When a number is missing, it fills in a silent default you cannot see."],
      ["High", "likely", "CAC counts only ad spend, so paid channels look cheaper than they are."],
      ["High", "likely", "Channels that share a touch can get double-counted, inflating their return."],
    ],
    picture: [
      ["What it actually does", "Takes your channel numbers and suggests which channels to fund or cut."],
      ["Who it is for", "GTM and finance teams weighing where to put acquisition budget."],
      ["Who it is not for", "Anyone who needs board-ready numbers without checking them by hand."],
      ["What can go wrong", "A confident answer built on bad math. You might cut a channel that was working."],
    ],
    checklist: [
      "Run its sample in a sandbox and check the results against your own math.",
      "Make sure the optimizer is scoring the goal you actually care about.",
      "Do not act on its fund-or-cut advice until the formulas are fixed.",
    ],
    scope: [
      ["v", "Checked", "How the scripts run, using its own sample data."],
      ["i", "Inferred", "What it is for, from its docs."],
      ["n", "Not tested", "Your real data, and whether the math holds up to an expert."],
    ],
    afterNote: "The parts we could not test. Worth a look once it is running on your side.",
    after: [
      "Run it on a copy of your real numbers and check the outputs before you rely on them.",
      "Have someone who knows the math look at a real result before you present it.",
    ],
  },
  {
    id: "sales-call-summary",
    risk: "warn",
    title: "sales-call-summary",
    tag: "workflow",
    verdict: "Use with care",
    sub: "handles call transcripts",
    summary:
      "Turns call notes or transcripts into follow-up summaries. Nothing broke in review, but it handles sensitive customer content.",
    run: {
      tone: "warn",
      label: "Use a sample transcript first",
      why: "It handles sales-call content. Test with a fake transcript before you paste real customer conversations.",
    },
    trust: {
      tone: "good",
      label: "Nothing flagged",
      why: "No output defect surfaced in the evaluated review. It can still misstate what was said, so a human check stays.",
    },
    finding: {
      tone: "good",
      text: "Nothing surfaced in the evaluated review. Treat the summaries as drafts, not a record.",
    },
    touch: "Call notes, transcripts, objections, next steps, and any contact context you paste in.",
    verify: "Check names, commitments, dates, and next steps before you send anything.",
    checked: "We reviewed the code and a sample run. We did not connect a calendar, CRM, or email account.",
    bl: {
      tone: "warn",
      title: "Useful with transcript hygiene.",
      answer:
        "A reasonable draft helper for call summaries. The reason to slow down is the data it touches and the risk of a confidently wrong follow-up.",
      rec: "Use fake transcript data first, then review every customer-facing line before it goes out.",
    },
    findings: [],
    picture: [
      ["What it actually does", "Turns call notes into summaries and follow-up drafts."],
      ["Who it is for", "Sales teams and account managers."],
      ["Who it is not for", "Automatic customer email without review."],
      ["What can go wrong", "It can invent or misstate a commitment from the call."],
    ],
    checklist: ["Use a fake transcript first.", "Verify names, dates, and commitments.", "Review before anything goes to a customer."],
    scope: [
      ["v", "Checked", "The code and a sample run."],
      ["i", "Inferred", "The sales-follow-up workflow, from its docs."],
      ["n", "Not tested", "Live CRM or email actions, and real transcript accuracy."],
    ],
    afterNote: "The parts we could not test on your side.",
    after: ["Run a real transcript through it privately and check the summary line by line.", "Keep it away from auto-send until you trust it."],
  },
  {
    id: "competitor-tracker",
    risk: "warn",
    title: "competitor-tracker",
    tag: "external data",
    verdict: "Use with care",
    sub: "pulls from public sources",
    summary:
      "Summarizes competitor activity from public pages and the notes you add. Works, but its summaries lean on sources it cannot guarantee.",
    run: {
      tone: "warn",
      label: "Use public examples first",
      why: "It reaches external sources and takes your competitor notes. Start with public examples before adding private strategy.",
    },
    trust: {
      tone: "warn",
      label: "Use with care",
      why: "Its summaries repeat what public pages say. In review, some claims went further than their source supported.",
    },
    finding: {
      tone: "warn",
      text: "2 issues found, both about claims that outrun their source. Check anything before you repeat it.",
    },
    touch: "Competitor names, market notes, public pages, and any private context you add.",
    verify: "Open the cited source for every competitor claim before you share it.",
    checked: "We reviewed the code and a sample run against public pages. We did not connect a paid data feed.",
    bl: {
      tone: "warn",
      title: "Fine for a first draft, not for a claim.",
      answer:
        "Useful as a monitoring draft. The catch is that it restates public sources and sometimes overstates them, so treat every line as a lead to verify rather than a checked fact.",
      rec: "Use public competitors first and open the source behind each claim before you repeat it.",
    },
    findings: [
      ["Med", "likely", "Some summaries state things more firmly than the cited page supports."],
      ["Low", "likely", "Undated sources can make old news read as current."],
    ],
    picture: [
      ["What it actually does", "Summarizes competitor updates and market signals."],
      ["Who it is for", "Product marketing and GTM teams watching competitors."],
      ["Who it is not for", "Board or sales claims without source checking."],
      ["What can go wrong", "A stale or overstated summary gets repeated as fact."],
    ],
    checklist: ["Use public competitors first.", "Open the source behind each claim.", "Keep private strategy notes out of the first run."],
    scope: [
      ["v", "Checked", "The code and a sample run on public pages."],
      ["i", "Inferred", "The market-monitoring use case."],
      ["n", "Not tested", "Paid feeds and whether every summary matches its source."],
    ],
    afterNote: "The parts we could not test on your side.",
    after: ["Spot-check a batch of real summaries against their sources.", "Add a verify-before-sharing step to your workflow."],
  },
  cleanSkill(
    "blog-seo-optimizer",
    "blog-seo-optimizer",
    "advice only",
    "Reviews draft posts and suggests SEO improvements. Advice only, with no state-changing actions found.",
    "Draft content, target keywords, audience notes, and metadata you provide.",
    "Reviews draft content and suggests SEO edits.",
    "Advice can overfit generic SEO rules or weaken brand voice."
  ),
  cleanSkill(
    "changelog-writer",
    "changelog-writer",
    "advice only",
    "Turns merged PRs and commit messages you paste in into a readable changelog draft.",
    "Commit messages, PR titles, and release notes you paste in.",
    "Drafts a changelog from commits and PRs you provide.",
    "It can overstate a change or miss a breaking one."
  ),
  cleanSkill(
    "icp-scorer",
    "icp-scorer",
    "script-backed",
    "Scores accounts against an ICP definition you provide. Runs locally on the inputs you give it.",
    "Account attributes and the ICP rules and weights you define.",
    "Scores accounts against ICP rules and weights you set.",
    "Bad or biased rules produce confident but wrong rankings."
  ),
  cleanSkill(
    "meeting-summarizer",
    "meeting-summarizer",
    "advice only",
    "Turns meeting notes into summaries and action items.",
    "The notes and transcripts you paste in.",
    "Summarizes meetings into decisions and action items.",
    "It can miss or mis-assign an action item."
  ),
  cleanSkill(
    "email-drafter",
    "email-drafter",
    "advice only",
    "Drafts outreach and follow-up emails from a short brief.",
    "The brief, contacts, and context you paste in.",
    "Drafts emails from a short brief you provide.",
    "A wrong claim or name can slip into a draft."
  ),
  cleanSkill(
    "roadmap-writer",
    "roadmap-writer",
    "advice only",
    "Turns a list of initiatives into a readable roadmap draft.",
    "The initiatives and dates you provide.",
    "Formats your initiatives into a roadmap draft.",
    "It can imply commitments or dates you did not intend."
  ),
  cleanSkill(
    "survey-analyzer",
    "survey-analyzer",
    "script-backed",
    "Summarizes open-text survey responses into themes.",
    "The survey responses you upload.",
    "Groups open-text responses into themes and quotes.",
    "It can over-generalize or miss a small but important theme."
  ),
  cleanSkill(
    "persona-builder",
    "persona-builder",
    "advice only",
    "Builds buyer-persona drafts from your notes.",
    "The research notes and interviews you paste in.",
    "Drafts buyer personas from your research notes.",
    "A persona can harden a guess into a stated fact."
  ),
  cleanSkill(
    "faq-generator",
    "faq-generator",
    "advice only",
    "Generates a FAQ draft from your docs.",
    "The docs and questions you provide.",
    "Drafts FAQ answers from the docs you give it.",
    "An answer can drift from your actual policy."
  ),
];

function byRisk(a, b) {
  const order = { danger: 0, warn: 1, good: 2 };
  return order[a.risk] - order[b.risk] || a.title.localeCompare(b.title);
}

function stripFull(skill) {
  // Withhold the depth, not the answer: the free preview keeps the full findings
  // (the X-ray); the email unlocks the deeper read (bottom line, full picture,
  // checklists, scope).
  // contentSha256 is a server-side freshness fingerprint; keep it out of the
  // preview payload sent to the browser.
  const { bl, picture, checklist, scope, afterNote, after, verify, checked, contentSha256: _sha, ...preview } = skill;
  return preview;
}

function reportNeedsBackgroundGrade(skill) {
  return Boolean(skill && (skill.reportDepth === "live-preview" || /^live-/.test(String(skill.id || ""))));
}

function sourceNeedsBackgroundGrade(result) {
  return Boolean(result && Array.isArray(result.skills) && result.skills.some(reportNeedsBackgroundGrade));
}

async function buildSourceResult(sourceUrl, options = {}) {
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized.ok) return normalized;

  const cache = options.useProductionCache === false ? null : loadProductionCache();
  const single = isLikelySingleSkill(normalized.url);
  if (options.useProductionCache !== false) {
    const cached = payloadFromProductionCache(normalized);
    // Only short-circuit a single cached skill when it has no fingerprint to
    // check (legacy entry). A fingerprinted entry falls through to the live path
    // so its content hash is verified before we trust the cached grade.
    if (cached && single && !cachedPayloadHasFingerprint(cached)) return cached;
  }
  const live = await loadLiveGitHubSource(normalized, cache);
  if (live && live.ok) return live;
  // A typed live failure (rate limit, not found, no skills, ...) is kept so we
  // can surface its specific message if no cache or local copy can serve it.
  const liveFailure = live && live.ok === false ? live : null;
  if (options.useProductionCache !== false) {
    const cached = payloadFromProductionCache(normalized);
    if (cached) return cached;
  }
  const real = loadRealSource(normalized);
  if (real) return real;
  if (liveFailure) {
    return { ok: false, error: liveFailure.error, reason: liveFailure.reason };
  }
  if (options.allowSampleFallback === false) {
    return {
      ok: false,
      reason: "unreadable",
      error: "We couldn't read that source from GitHub just now. Please try again in a minute.",
    };
  }
  const skills = (single ? [SAMPLE_SKILLS[0]] : SAMPLE_SKILLS).slice().sort(byRisk);
  return {
    ok: true,
    source: normalized,
    previewCap: PREVIEW_CAP,
    skills,
  };
}

function normalizeRepoUrl(value) {
  try {
    const u = new URL(value);
    if (!u.hostname.toLowerCase().includes("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `github.com/${parts[0].toLowerCase()}/${parts[1].replace(/\.git$/i, "").toLowerCase()}`;
  } catch (_error) {
    return null;
  }
}

function githubPathAfterRepo(value) {
  try {
    const u = new URL(value);
    if (!u.hostname.toLowerCase().includes("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length <= 2) return null;
    const repoPath = (parts[2] === "tree" || parts[2] === "blob") && parts.length > 4 ? parts.slice(4) : parts.slice(2);
    if (/^skill\.md$/i.test(repoPath[repoPath.length - 1] || "")) repoPath.pop();
    return repoPath.join("/").toLowerCase();
  } catch (_error) {
    return null;
  }
}

function githubSkillPathKey(value) {
  const repo = normalizeRepoUrl(value);
  const repoPath = githubPathAfterRepo(value);
  if (!repo || !repoPath) return null;
  return `${repo}::${repoPath}`;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function loadProductionCache() {
  if (productionCache !== null) return productionCache;
  productionCache = readJsonFile(PRODUCTION_CACHE_PATH) || false;
  return productionCache;
}

function materializeCachedPayload(cache, entry) {
  if (!entry) return null;
  if (entry.previewCap && Array.isArray(entry.skills)) return entry;
  if (typeof entry === "string") {
    if (cache.payloads && cache.payloads[entry]) return cache.payloads[entry];
    if (cache.reports && cache.reports[entry]) return { previewCap: PREVIEW_CAP, skills: [cache.reports[entry]] };
  }
  if (entry.type === "skill" && cache.reports && cache.reports[entry.skill]) {
    return { previewCap: PREVIEW_CAP, skills: [cache.reports[entry.skill]] };
  }
  if (entry.type === "repo" && cache.byRepo && cache.reports) {
    const ids = cache.byRepo[entry.repo] || [];
    const skills = ids.map((id) => cache.reports[id]).filter(Boolean);
    return { previewCap: PREVIEW_CAP, skills };
  }
  if (Array.isArray(entry) && cache.reports) {
    const skills = entry.map((id) => cache.reports[id]).filter(Boolean);
    return { previewCap: PREVIEW_CAP, skills };
  }
  return null;
}

function payloadFromProductionCache(source) {
  const cache = loadProductionCache();
  if (!cache) return null;

  const exactKey = normalizedUrlKey(source.url);
  const repoKey = normalizeRepoUrl(source.url);
  const skillKey = githubSkillPathKey(source.url);
  const singleSkill = isLikelySingleSkill(source.url);
  const entry =
    (skillKey && cache.bySkillPath && cache.bySkillPath[skillKey]) ||
    (exactKey && cache.byUrl && cache.byUrl[exactKey]) ||
    (!singleSkill && repoKey && cache.byRepo && cache.byRepo[repoKey]);
  const cached = materializeCachedPayload(cache, entry);

  if (!cached || !Array.isArray(cached.skills) || cached.skills.length === 0) return null;
  return {
    ok: true,
    source,
    previewCap: cached.previewCap || PREVIEW_CAP,
    skills: cached.skills.map(normalizeReportDisplay).sort(byRisk),
  };
}

function parseGitHubSource(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    if (!u.hostname.toLowerCase().includes("github.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    let mode = "repo";
    let ref = "";
    let sourcePath = "";
    if ((parts[2] === "tree" || parts[2] === "blob") && parts.length >= 4) {
      mode = parts[2];
      ref = parts[3];
      sourcePath = parts.slice(4).join("/");
    } else if (parts.length > 2) {
      sourcePath = parts.slice(2).join("/");
    }
    return { owner, repo, mode, ref, sourcePath };
  } catch (_error) {
    return null;
  }
}

function githubAuthToken() {
  return (process.env.GITHUB_PREVIEW_TOKEN || process.env.GITHUB_REPORT_DISPATCH_TOKEN || "").trim();
}

function githubRequest(url, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch (_error) {
      // Leave host blank; the request below will fail and reject normally.
    }
    const headers = {
      accept: json ? "application/vnd.github+json" : "text/plain",
      "user-agent": "ai-skill-grader-preview",
    };
    // Authenticate only the rate-limited API host. Never attach the token to raw
    // or its redirect targets (objects.githubusercontent.com), which would leak
    // the credential to a different host.
    const token = githubAuthToken();
    if (token && host === "api.github.com") headers.authorization = `Bearer ${token}`;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        githubRequest(new URL(res.headers.location, url).toString(), { json }).then(resolve, reject);
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 2 * 1024 * 1024) {
          const tooLarge = new Error("Source file is too large to preview.");
          tooLarge.kind = "too_large";
          req.destroy(tooLarge);
        }
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`GitHub returned ${res.statusCode}.`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        if (!json) {
          resolve(raw);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(12000, () => {
      const timeout = new Error("GitHub request timed out.");
      timeout.kind = "timeout";
      req.destroy(timeout);
    });
    req.on("error", reject);
  });
}

function encodePathSegments(value) {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function rawGitHubUrl(owner, repo, ref, filePath) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${encodePathSegments(filePath)}`;
}

async function defaultBranch(owner, repo) {
  const meta = await githubRequest(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { json: true });
  return meta.default_branch || "main";
}

async function githubTree(owner, repo, ref) {
  const tree = await githubRequest(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { json: true }
  );
  return Array.isArray(tree.tree) ? tree.tree : [];
}

function dirname(value) {
  const dir = path.posix.dirname(String(value || ""));
  return dir === "." ? "" : dir;
}

function basename(value) {
  return path.posix.basename(String(value || "").replace(/\/$/, ""));
}

function githubSkillUrl(parsed, ref, skillPath) {
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${encodeURIComponent(ref)}/${encodePathSegments(dirname(skillPath))}`;
}

function skillRefsFromTree(source, parsed, ref, tree) {
  let prefix = String(parsed.sourcePath || "").replace(/^\/|\/$/g, "");
  const exactFile = /^skill\.md$/i.test(basename(prefix));
  const targetPrefix = exactFile ? dirname(prefix) : prefix;
  const single = isLikelySingleSkill(source.url);
  const rows = tree
    .filter((entry) => entry && entry.type === "blob" && isSkillFilePath(entry.path || ""))
    .filter((entry) => {
      if (!targetPrefix) return true;
      if (single) return dirname(entry.path).toLowerCase() === targetPrefix.toLowerCase();
      return entry.path.toLowerCase().startsWith(`${targetPrefix.toLowerCase()}/`) || entry.path.toLowerCase() === targetPrefix.toLowerCase();
    })
    .map((entry) => {
      const title = basename(dirname(entry.path)).replace(/-/g, " ") || parsed.repo.replace(/-/g, " ");
      return {
        path: entry.path,
        dir: dirname(entry.path),
        title,
        url: githubSkillUrl(parsed, ref, entry.path),
      };
    });
  return single ? rows.slice(0, 1) : rows.slice(0, LIVE_SOURCE_SKILL_LIMIT);
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function cachedReportForSourceUrl(cache, sourceUrl) {
  if (!cache) return null;
  const entry =
    (cache.bySkillPath && cache.bySkillPath[githubSkillPathKey(sourceUrl)]) ||
    (cache.byUrl && cache.byUrl[normalizedUrlKey(sourceUrl)]);
  const payload = materializeCachedPayload(cache, entry);
  if (!payload || !Array.isArray(payload.skills) || payload.skills.length !== 1) return null;
  return normalizeReportDisplay(payload.skills[0]);
}

function cachedReportsForRepo(cache, repoKey) {
  if (!cache || !repoKey || !cache.byRepo || !cache.reports) return [];
  return (cache.byRepo[repoKey] || []).map((id) => cache.reports[id]).filter(Boolean).map(normalizeReportDisplay);
}

function cachedReportForRepoRef(cache, repoKey, refRow) {
  const reports = cachedReportsForRepo(cache, repoKey);
  if (!reports.length || !refRow) return null;

  const refDir = slugKey(refRow.dir);
  const refLeaf = slugKey(basename(refRow.dir));
  const refTitle = slugKey(refRow.title);
  const matches = reports.filter((report) => {
    const id = slugKey(report.id);
    const title = slugKey(report.title);
    const summary = slugKey(report.summary);
    const idTail = slugKey(String(report.id || "").split("__").pop());
    return (
      idTail === refLeaf ||
      idTail === refDir ||
      id.endsWith(`-${refDir}`) ||
      title === refLeaf ||
      title === refTitle ||
      summary === refLeaf ||
      summary === refTitle
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function reportSortValue(report) {
  const riskOrder = { danger: 0, warn: 1, good: 2 };
  return riskOrder[report.risk] == null ? 3 : riskOrder[report.risk];
}

function slugKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sortMergedReports(left, right) {
  const riskDelta = reportSortValue(left.report) - reportSortValue(right.report);
  if (riskDelta) return riskDelta;
  if (left.cached !== right.cached) return left.cached ? -1 : 1;
  return left.report.title.localeCompare(right.report.title);
}

function dedupeMergedReports(entries) {
  const seen = new Set();
  const rows = [];
  for (const entry of entries) {
    const keys = [
      entry.report && entry.report.id,
      entry.skillPath,
      entry.report && entry.report.title && `title:${slugKey(entry.report.title)}`,
    ].filter(Boolean);
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    rows.push(entry);
  }
  return rows;
}

function frontmatterValue(text, key) {
  const match = String(text || "").match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((row) => row.toLowerCase().startsWith(`${key.toLowerCase()}:`));
  if (!line) return "";
  return line.slice(line.indexOf(":") + 1).trim().replace(/^["']|["']$/g, "");
}

function titleFromSkillText(text, fallback) {
  const named = frontmatterValue(text, "name");
  if (named) return named.replace(/-/g, " ");
  const heading = String(text || "").match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim().replace(/`/g, "");
  return fallback;
}

function summaryFromSkillText(text, fallback) {
  const described = frontmatterValue(text, "description");
  if (described) return sentence(described, fallback, 220);
  const cleaned = String(text || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line && !/^[-*]\s*$/.test(line) && !/^```/.test(line));
  const useWhen = cleaned.find((line) => /^use (this )?(skill )?when/i.test(line));
  return sentence(useWhen || cleaned[0], fallback, 220);
}

function packageTagFromText(text) {
  if (SCRIPT_RE.test(text)) return "script backed";
  if (CREDENTIAL_RE.test(text) || API_BACKED_RE.test(text)) return "API backed";
  return "instruction only";
}

function touchFromText(text) {
  const surfaces = [];
  if (/\b(github|repo|pull request|branch|commit|code)\b/i.test(text)) surfaces.push("repos or code");
  if (/\b(crm|hubspot|salesforce|customer|lead|prospect)\b/i.test(text)) surfaces.push("customer or CRM data");
  if (/\b(email|slack|calendar|meeting|transcript)\b/i.test(text)) surfaces.push("messages or meeting content");
  if (/\b(revenue|arr|cac|margin|budget|spend|financial|investor|dataroom)\b/i.test(text)) surfaces.push("business or financial information");
  if (CREDENTIAL_RE.test(text)) surfaces.push("tokens or account credentials");
  if (!surfaces.length) return "The text and files you provide. No obvious live-account surface was found.";
  return `It may touch ${Array.from(new Set(surfaces)).join(", ")} if you give it that access.`;
}

function verifyFromSignals(signals) {
  if (signals.manipulation) return "Do not run it until the suspicious instruction language has been reviewed.";
  if (signals.directLiveAction) return "Try it in a sandbox or throwaway account before connecting anything real.";
  if (signals.credentials) return "Use a fake or tightly scoped token first; do not paste a production credential.";
  if (signals.scripts) return "Run it on a small fake example before using real data.";
  if (signals.decisionCritical) return "Check its answer against a source or person you already trust.";
  return "Try it on a small example and read the result before using it.";
}

function triageSignals(text) {
  const operationalSurface = OPERATIONAL_SURFACE_RE.test(text) || CREDENTIAL_RE.test(text) || SCRIPT_RE.test(text);
  const directLiveAction = operationalSurface && ACTION_RE.test(text) && LIVE_ACTION_SURFACE_RE.test(text);
  const credentials = CREDENTIAL_RE.test(text);
  const scripts = SCRIPT_RE.test(text);
  const sensitive = SENSITIVE_RE.test(text);
  const paid = PAID_RE.test(text);
  const decisionCritical = DECISION_CRITICAL_RE.test(text);
  const manipulation = MANIPULATION_RE.test(text);
  return { directLiveAction, credentials, scripts, sensitive, paid, decisionCritical, manipulation, operationalSurface };
}

function reportFromLiveSkill(ref, skillText, source) {
  const text = String(skillText || "");
  const signals = triageSignals(text);
  const risk = signals.manipulation ? "danger" : signals.directLiveAction || signals.credentials || signals.sensitive || signals.paid || signals.decisionCritical ? "warn" : "good";
  const title = titleFromSkillText(text, ref.title);
  const summary = summaryFromSkillText(text, `A public skill found in ${source.display && source.display.repo ? source.display.repo : "this source"}.`);
  const tag = packageTagFromText(text);
  const touch = touchFromText(text);
  const verify = verifyFromSignals(signals);
  const outputProminent = signals.decisionCritical || signals.paid || signals.directLiveAction;
  const findingText = signals.manipulation
    ? "Possible instruction-manipulation language surfaced in the public skill file. Review before running it."
    : risk === "warn"
      ? "Review before relying on it. The preview found account, data, script, or decision-risk surfaces that deserve a closer look."
      : PACKAGE_REVIEW_CLEAN;
  const runLabel = signals.manipulation
    ? "Do not run yet"
    : signals.directLiveAction
      ? "Use a sandbox first"
      : signals.credentials
        ? "Use fake credentials first"
        : signals.scripts
          ? "Safe to test locally"
          : "Safe to inspect";
  const runWhy = signals.manipulation
    ? "The public instructions include suspicious language. Read the full context before using it."
    : signals.directLiveAction
      ? "The skill appears able to affect accounts or systems if connected. Test away from production first."
      : signals.credentials
        ? "The skill references tokens or account credentials. Start with a fake or tightly scoped credential."
        : signals.scripts
          ? "The skill appears to include runnable commands or scripts. Use a small fake example first."
          : "No obvious state-changing behavior showed up in the pre-install review.";

  return normalizeReportDisplay({
    id: `live-${crypto.createHash("sha256").update(`${source.url}:${ref.path}`).digest("hex").slice(0, 16)}`,
    reportDepth: "live-preview",
    risk,
    title,
    tag,
    verdict: risk === "danger" ? "Do not trust output" : risk === "warn" ? "Use with care" : "Nothing flagged",
    sub: tag,
    summary,
    run: {
      tone: risk === "danger" ? "danger" : risk === "warn" ? "warn" : "good",
      label: runLabel,
      why: runWhy,
    },
    trust: {
      tone: outputProminent || risk === "danger" ? "warn" : "good",
      label: outputProminent || risk === "danger" ? "Needs your review" : "Output not evaluated",
      why: outputProminent || risk === "danger"
        ? "This skill may affect important decisions, accounts, or data. Check its output in your own setup before relying on it."
        : "Output correctness was not evaluated for this skill.",
      prominent: outputProminent || risk === "danger",
    },
    finding: {
      tone: risk === "danger" ? "danger" : risk === "warn" ? "warn" : "good",
      text: findingText,
    },
    touch,
    verify,
    checked: "We reviewed the public skill file, instructions, links, commands, and risky surfaces before install.",
    bl: {
      tone: risk,
      title: risk === "danger" ? "Do not run this yet." : risk === "warn" ? "Useful, but review before relying." : "Low-risk to inspect.",
      answer:
        risk === "good"
          ? "No package issue surfaced in the fast preview. That still is not proof the output is correct for your situation."
          : "The skill may be useful, but the preview found surfaces that should be checked before real use.",
      rec: verify,
    },
    // Surface the triage reason as a shown finding so the preview never reads
    // "Nothing surfaced in the evaluated review" over a warn/danger verdict.
    // A live triage is a static read, not an output evaluation, so the badge
    // says so rather than claiming a confirmed defect.
    findings: signals.manipulation
      ? [["High", "likely", "Suspicious instruction language surfaced in the public skill file."]]
      : risk === "warn"
        ? [["Heads-up", "preview", findingText]]
        : [],
    picture: [
      ["What it actually does", summary],
      ["Who it is for", "People whose workflow matches the skill description."],
      ["Who it is not for", "Anyone who needs guaranteed correctness without checking the result."],
      ["What can go wrong", findingText],
      ["What it needs access to", touch],
      ["What kind of package it is", tag],
    ],
    checklist: [
      verify,
      signals.sensitive ? "Use fake or non-sensitive data before pasting anything private." : "Use a small fake example first.",
      "Review the result before putting it into a real workflow.",
    ],
    scope: [
      ["v", "Checked", "We reviewed the public skill file and looked for obvious action, account, credential, data, script, and manipulation surfaces."],
      ["i", "Inferred", "The use case, audience, and first safe test are inferred from the public instructions."],
      [
        "n",
        "Not tested",
        "We did not connect any accounts, use real credentials, or run production workflows. That is intentional: a generic test cannot prove the skill will behave correctly inside your exact setup.",
      ],
    ],
    afterNote: "The parts to confirm once it is running on your side.",
    after: ["Try one realistic but non-production example.", "Compare the result against a source you already trust.", "Only then decide whether it belongs in a real workflow."],
  });
}

// Every live-preview failure maps to one specific, plain message the user can
// act on, instead of the old catch-all "we could not read that public source."
const LIVE_FAILURE_MESSAGES = {
  rate_limited:
    "We're checking a lot of skills right now and GitHub is throttling us. Give it a minute and try again.",
  not_found:
    "We couldn't find that repo. Check the link. We can read public GitHub repos and SKILL.md files.",
  no_skills:
    "We couldn't find a skill to grade there. We look for a SKILL.md file, so point us at a repo or folder that has one.",
  too_large:
    "That skill file is too big to preview. Check that the link points to a SKILL.md file.",
  timeout: "GitHub took too long to respond. Give it a moment and try again.",
  unreadable:
    "We couldn't read that source from GitHub just now. Please try again in a minute.",
};

function classifyLiveError(error) {
  if (!error) return "unreadable";
  if (error.kind === "too_large") return "too_large";
  if (error.kind === "timeout") return "timeout";
  const status = Number(error.status || 0);
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  const message = String((error && error.message) || "");
  if (/timed out/i.test(message)) return "timeout";
  if (/too large/i.test(message)) return "too_large";
  return "unreadable";
}

function liveSourceFailure(reason, error) {
  return {
    ok: false,
    live: true,
    reason,
    status: (error && error.status) || null,
    error: LIVE_FAILURE_MESSAGES[reason] || LIVE_FAILURE_MESSAGES.unreadable,
  };
}

async function loadLiveGitHubSource(source, cache) {
  const parsed = parseGitHubSource(source.url);
  if (!parsed) return null;
  try {
    const ref = parsed.ref || (await defaultBranch(parsed.owner, parsed.repo));
    let refs = [];
    if (parsed.mode === "blob" && /^skill\.md$/i.test(basename(parsed.sourcePath))) {
      refs = [
        {
          path: parsed.sourcePath,
          dir: dirname(parsed.sourcePath),
          title: basename(dirname(parsed.sourcePath)).replace(/-/g, " "),
          url: githubSkillUrl(parsed, ref, parsed.sourcePath),
        },
      ];
    } else {
      refs = skillRefsFromTree(source, parsed, ref, await githubTree(parsed.owner, parsed.repo, ref));
    }
    if (!refs.length) {
      logServerEvent({ event: "preview_no_skills", reason: "no_skills", source: source.url });
      return liveSourceFailure("no_skills", null);
    }

    const merged = [];
    const repoKey = normalizeRepoUrl(source.url);
    const uncachedRefs = [];
    const verifyRefs = [];
    for (const refRow of refs) {
      const cached = cachedReportForSourceUrl(cache, refRow.url) || cachedReportForRepoRef(cache, repoKey, refRow);
      if (cached && cached.contentSha256) verifyRefs.push({ refRow, cached });
      else if (cached) merged.push({ report: cached, cached: true, skillPath: refRow.dir.toLowerCase() });
      else uncachedRefs.push(refRow);
    }

    // Freshness gate: a cached grade is only trustworthy if the current SKILL.md
    // still hashes to what we graded. Fetch the current file (raw, not the
    // rate-limited API), compare the sha256, and re-grade from the text we just
    // pulled if it changed. If we cannot fetch to verify, fall back to the cached
    // grade rather than failing. Legacy entries (no hash) never reach here.
    const verified = await mapConcurrent(verifyRefs, LIVE_SOURCE_FETCH_CONCURRENCY, async ({ refRow, cached }) => {
      let text;
      try {
        text = await githubRequest(rawGitHubUrl(parsed.owner, parsed.repo, ref, refRow.path));
      } catch (_error) {
        return { report: cached, cached: true, skillPath: refRow.dir.toLowerCase() };
      }
      const currentSha = contentSha256(text);
      if (currentSha === cached.contentSha256) {
        return { report: cached, cached: true, skillPath: refRow.dir.toLowerCase() };
      }
      logServerEvent({ event: "cache_stale_regrade", source: refRow.url, gradedSha: cached.contentSha256, currentSha });
      return { report: reportFromLiveSkill(refRow, text, source), cached: false, skillPath: refRow.dir.toLowerCase() };
    });
    merged.push(...verified.filter(Boolean));

    const liveReports = await mapConcurrent(uncachedRefs, LIVE_SOURCE_FETCH_CONCURRENCY, async (refRow) => {
      const text = await githubRequest(rawGitHubUrl(parsed.owner, parsed.repo, ref, refRow.path));
      return { report: reportFromLiveSkill(refRow, text, source), cached: false, skillPath: refRow.dir.toLowerCase() };
    });

    const skills = dedupeMergedReports(merged.concat(liveReports.filter(Boolean))).sort(sortMergedReports).map((entry) => entry.report);
    if (!skills.length) {
      logServerEvent({ event: "preview_no_skills", reason: "no_skills", source: source.url });
      return liveSourceFailure("no_skills", null);
    }
    return {
      ok: true,
      source,
      previewCap: PREVIEW_CAP,
      skills,
    };
  } catch (error) {
    const reason = classifyLiveError(error);
    logServerEvent({
      event: "preview_failed",
      reason,
      status: (error && error.status) || null,
      source: source.url,
      message: (error && (error.message || String(error))) || "unknown",
    });
    return liveSourceFailure(reason, error);
  }
}

function textFrom(value, fallback = "") {
  if (!value) return fallback;
  return String(value).replace(/^>\s*/, "").replace(/\s+/g, " ").trim();
}

// Plain-English for the internal behavioral-eval flag names that leak into
// finding text (e.g. "2 high score without warnings signals surfaced.").
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

function userFacingText(value) {
  return textFrom(value)
    .replace(/Static-only; needs sample-data walkthrough/gi, "Needs testing with sample inputs")
    .replace(/Static-only inspectable/gi, "Reviewed before install")
    .replace(/^critique:\s*/i, "")
    .replace(/^(\d+)\s+(.+?)\s+signals?\s+surfaced\.?$/i, (m, n, flag) => FLAG_PLAIN[flag.toLowerCase().trim()] || m)
    .replace(/\b\d+\s+review signals?\s+surfaced in sample-output checks\.?/gi, "The sample output review found issues to check before relying on it.")
    .replace(/Output is very short for a behavioral walkthrough\./gi, "Its sample answer is too thin to show that the skill really handled the task.")
    .replace(/Output barely uses the dummy context\./gi, "Its sample answer barely uses the details it was given.")
    .replace(/Output misses too many expected skill\/task checks\./gi, "Its sample answer skipped parts of the task we expected it to cover.")
    .replace(/Output does not clearly label assumptions\/evidence\/unknowns\./gi, "Its sample answer does not clearly separate facts, assumptions, and unknowns.")
    .replace(/Output lacks clear sandbox\/dummy\/approval controls\./gi, "Its sample answer does not give enough test-data or approval guidance.")
    .replace(/Output appears to claim direct side effects without enough draft\/approval framing\./gi, "Its sample answer talks about taking action without enough review or approval framing.")
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
    .replace(/No obvious state-changing action surface surfaced in static review\./gi, "No obvious state-changing behavior showed up in the pre-install review.")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(value, fallback, limit = 260) {
  const text = textFrom(value, fallback);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}...`;
}

function toneForLabel(label) {
  const lower = String(label || "").toLowerCase();
  if (lower.includes("do not") || lower.includes("don't") || lower.includes("not trust")) return "danger";
  if (lower.includes("verify") || lower.includes("care") || lower.includes("sandbox") || lower.includes("dummy")) return "warn";
  return "good";
}

function riskFor(readiness, auditSkill, decisionCritical) {
  const decision = readiness.decision || {};
  const trust = decision.output_trust || {};
  const label = String(trust.label || "");
  const flags = Object.keys((auditSkill && auditSkill.flag_counts) || {});
  const review = (readiness.breadth && readiness.breadth.review) || [];
  const hasConfirmed = Boolean(review.some((f) => f.confirmation_tier === "CONFIRMED"));
  const manipulationText = compactText([
    decision.override,
    decision.run_safety && decision.run_safety.why,
    readiness.limits && readiness.limits.injection_findings,
  ]);
  if (hasConfirmed || /manipulation|exfiltrat|do not test\/install/i.test(manipulationText)) return "danger";
  if (review.length && /do not|not trust/i.test(label)) return "danger";
  if (/do not|not trust/i.test(label)) return "warn";
  if (/verify|care/i.test(label) || (/not evaluated/i.test(label) && decisionCritical)) return "warn";
  if (flags.includes("weak_safety_controls") || flags.includes("low_expected_coverage")) return "warn";
  return "good";
}

function shortName(skillId, candidate) {
  if (candidate && candidate.upstream_name) return candidate.upstream_name;
  return String(skillId || "skill").split("__").pop().split("-skills-").pop();
}

function compactFamily(families) {
  if (!Array.isArray(families) || !families.length) return "reviewed skill";
  if (families.includes("regulated-advice")) return "qualified review";
  if (families.includes("finance/business-analysis")) return "finance";
  if (families.includes("gtm/strategy-ops")) return "GTM";
  if (families.includes("design/content-generation")) return "content";
  return families[0].split("/").pop();
}

const FAMILY_AUDIENCE_LABELS = {
  "deployment/infrastructure": "engineering teams shipping or operating software",
  "api/developer": "software teams working with code, APIs, or developer workflows",
  "browser/scraping": "teams automating browser or web-data workflows",
  "lead-enrichment/gtm": "sales and GTM teams working with leads or account research",
  "gtm/strategy-ops": "GTM, sales, and strategy teams",
  "support/ops": "support and operations teams",
  "regulated-advice": "teams working in legal, compliance, medical, tax, or other high-stakes domains",
  "finance/business-analysis": "finance or business-operations teams",
  "seo/content/compliance": "marketing, SEO, and content teams",
  "design/content-generation": "design, brand, and content teams",
  "security/dual-use": "security teams or authorized technical reviewers",
  "script-heavy utility": "technical users comfortable inspecting scripts before running them",
  "pure workflow/advisory": "people using the skill as guidance rather than automation",
};

function audienceFor(readiness, families) {
  const summaryAudience = readiness && readiness.summary && readiness.summary.intended_user;
  if (summaryAudience && !/[a-z-]+\/[a-z-]+/.test(String(summaryAudience))) {
    return `People in ${summaryAudience} workflows.`;
  }
  const labels = [];
  for (const family of Array.isArray(families) ? families : []) {
    const label = FAMILY_AUDIENCE_LABELS[family];
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 2) break;
  }
  if (!labels.length) return "People whose workflow matches the skill description.";
  return labels.length === 1 ? labels[0] + "." : `${labels[0]}, plus ${labels[1]}.`;
}

function displayTag(readiness, fallbackFamilies) {
  const map = (readiness.evaluation && readiness.evaluation.capability_map) || {};
  if (map.package_shape) return String(map.package_shape).replace(/-/g, " ");
  return compactFamily(fallbackFamilies);
}

function compactText(value) {
  if (Array.isArray(value)) return value.map(compactText).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(compactText).join(" ");
  return value == null ? "" : String(value);
}

function isInstructionOnlyText(value) {
  return /\binstruction[- ]only\b/i.test(String(value || ""));
}

function isInstructionOnlyReport(skill) {
  return isInstructionOnlyText(skill && skill.tag);
}

function reportHasDirectOperationalSurface(skill) {
  if (!skill) return false;
  if (!isInstructionOnlyReport(skill)) return true;
  return false;
}

function pictureValue(skill, label) {
  const row = Array.isArray(skill && skill.picture)
    ? skill.picture.find((item) => item && item[0] === label)
    : null;
  return row ? row[1] : "";
}

function instructionOnlySourceText(skill) {
  return compactText([
    skill && skill.id,
    skill && skill.title,
    skill && skill.summary,
    pictureValue(skill, "What it actually does"),
  ]);
}

function instructionOnlyHighStakes(skill) {
  return HIGH_STAKES_INSTRUCTION_RE.test(instructionOnlySourceText(skill));
}

function instructionOnlyTouchText(skill) {
  const text = instructionOnlySourceText(skill).toLowerCase();
  if (/\b(customer|lead|prospect|crm|outreach|email|slack|transcript|pii|private|confidential|sensitive)\b/.test(text)) {
    return "Customer or message context you provide. No direct account connection or write surface was found.";
  }
  if (/\b(financial|finance|revenue|arr|cac|margin|budget|spend|accounting|investor|diligence|dataroom)\b/.test(text)) {
    return "Business context you provide. No direct account connection or write surface was found.";
  }
  if (/\b(file|repo|github|code|branch|pull request|pr)\b/.test(text)) {
    return "Files or repo context you provide. No direct account connection or write surface was found.";
  }
  return "Inputs you provide. No direct account connection or write surface was found.";
}

function isOutputNotEvaluatedTrust(trust) {
  return /not evaluated/i.test(`${trust && trust.label} ${trust && trust.why}`);
}

function isOutputNotEvaluatedLine(finding) {
  return /output correctness was not evaluated|output not evaluated/i.test(`${finding && finding.text}`);
}

function isCleanFindingLine(finding) {
  const text = textFrom(finding && finding.text);
  return (
    text === CLEAN_FINDINGS ||
    /^no package issue flagged/i.test(text) ||
    /^nothing surfaced in the evaluated review\./i.test(text)
  );
}

// Name what the skill actually makes, so the trust verdict can say
// "Don't trust its numbers" instead of the generic "Do not trust output".
// Safe default is "its output"; a wrong guess only softens the noun, never
// the verdict.
function outputNoun(skill) {
  // Classify from what the skill is about, not its mechanism tag ("script
  // backed" would otherwise pull everything to "its code").
  const instructionOnly = isInstructionOnlyReport(skill);
  const t = `${skill.title || ""} ${skill.summary || ""} ${instructionOnly ? "" : skill.touch || ""}`.toLowerCase();
  if (instructionOnly) {
    if (/\b(summary|summaries|summariz|draft|drafts|email|copy|rewrite|content|blog|post|message|caption|newsletter|communication|update)\b/.test(t)) return "what it writes";
    if (/\b(plan|plans|roadmap|workflow|playbook|launch|sequence|architecture|strategy)\b/.test(t)) return "its plan";
    if (/\b(recommend|advice|advis|suggest|decision|choose|selection|investor|board|pricing|diligence|partnership)\b/.test(t)) return "its advice";
  }
  if (/\b(sql|query|queries|code|script|scripts|function|regex|config|yaml|terraform|schema|migration)\b/.test(t)) return "its code";
  if (/\b(number|numbers|calcul|metric|forecast|budget|revenue|arr|cac|ltv|margin|roi|financ|econom|pricing|valuation)\b/.test(t)) return "its numbers";
  if (/\b(summary|summaries|summariz|draft|drafts|email|copy|rewrite|content|blog|post|message|caption|newsletter)\b/.test(t)) return "what it writes";
  if (!instructionOnly && /\b(scrape|scraper|extract|crawl|pull|fetch|dataset|records|enrich)\b/.test(t)) return "the data it pulls";
  if (/\b(score|scores|scoring|rank|ranking|rate|rating|grade|grading|classif|label|prioritiz)\b/.test(t)) return "its scores";
  if (/\b(plan|plans|roadmap|workflow|playbook|itinerary|schedule|sequence)\b/.test(t)) return "its plan";
  if (/\b(recommend|advice|advis|suggest|decision|choose|selection)\b/.test(t)) return "its advice";
  if (/\b(research|answer|answers|question|lookup|search)\b/.test(t)) return "its answers";
  return "its output";
}

function finalizeReportDisplay(next) {
  if (next.risk === "danger") next.verdict = `Don't trust ${outputNoun(next)}`;
  // Name the output for a warn only when output-trust is the concern (prominent).
  // A run-safety warn keeps the generic "Use with care".
  else if (next.risk === "warn" && next.trust && next.trust.prominent) next.verdict = `Double-check ${outputNoun(next)}`;
  next.sub = userFacingText(next.sub);
  next.summary = userFacingText(next.summary);
  next.touch = userFacingText(next.touch);
  next.verify = userFacingText(next.verify);
  next.checked = userFacingText(next.checked);
  if (next.run) next.run.why = userFacingText(next.run.why);
  if (next.trust) next.trust.why = userFacingText(next.trust.why);
  if (next.finding) next.finding.text = userFacingText(next.finding.text);
  if (next.bl) {
    next.bl.answer = userFacingText(next.bl.answer);
    next.bl.rec = userFacingText(next.bl.rec);
  }
  if (Array.isArray(next.findings)) next.findings = next.findings.map((row) => [row[0], row[1], userFacingText(row[2])]);
  if (Array.isArray(next.picture)) next.picture = next.picture.map((row) => [row[0], userFacingText(row[1])]);
  if (Array.isArray(next.checklist)) next.checklist = next.checklist.map(userFacingText);
  if (Array.isArray(next.scope)) next.scope = next.scope.map((row) => [row[0], row[1], userFacingText(row[2])]);
  next.afterNote = userFacingText(next.afterNote);
  if (Array.isArray(next.after)) next.after = next.after.map(userFacingText);
  return next;
}

function decisionCriticalFromReadiness(readiness, item, candidate) {
  const map = (readiness.evaluation && readiness.evaluation.capability_map) || {};
  const surfaces = compactText((map.tool_surfaces || []).map((s) => s.tool_or_surface || s));
  if (map.direct_actions_detected && LIVE_ACTION_SURFACE_RE.test(surfaces)) return true;
  const families = [
    ...((item && item.families) || []),
    ...((readiness && readiness.families) || []),
    ...((readiness && readiness.incidental_families) || []),
  ];
  if (families.includes("regulated-advice") || families.includes("finance/business-analysis")) return true;
  const text = compactText([
    item && item.name,
    candidate && candidate.upstream_name,
    candidate && candidate.description,
    families,
    readiness.evaluation && readiness.evaluation.claims,
    readiness.evaluation && readiness.evaluation.capability_map,
  ]);
  return DECISION_CRITICAL_RE.test(text);
}

function decisionCriticalFromReport(skill) {
  if (!skill) return false;
  if (isInstructionOnlyReport(skill) && !reportHasDirectOperationalSurface(skill)) {
    return instructionOnlyHighStakes(skill);
  }
  const touch = skill.touch || "";
  const touchEvidence = touch.replace(/test away from production first\.?/gi, "");
  if (/high-stakes|regulated|qualified review/i.test(`${skill.trust && skill.trust.why} ${skill.bl && skill.bl.answer}`)) return true;
  if (/may change external systems or records/i.test(touch) && !LIVE_ACTION_SURFACE_RE.test(touchEvidence)) return false;
  const text = compactText([
    skill.id,
    skill.title,
    skill.tag,
    skill.summary,
    touchEvidence,
    skill.verify,
    skill.finding && skill.finding.text,
  ]);
  return DECISION_CRITICAL_RE.test(text);
}

function normalizeReportDisplay(skill) {
  if (!skill) return skill;
  const next = {
    ...skill,
    run: skill.run ? { ...skill.run } : skill.run,
    trust: skill.trust ? { ...skill.trust } : skill.trust,
    finding: skill.finding ? { ...skill.finding } : skill.finding,
    bl: skill.bl ? { ...skill.bl } : skill.bl,
  };
  const noDetailedFindings = !Array.isArray(next.findings) || next.findings.length === 0;
  const instructionOnlyWithoutOps = isInstructionOnlyReport(next) && !reportHasDirectOperationalSurface(next);
  if (instructionOnlyWithoutOps) {
    const highStakesAdvice = instructionOnlyHighStakes(next);
    next.touch = instructionOnlyTouchText(next);
    if (Array.isArray(next.picture)) {
      next.picture = next.picture.map((row) => (
        row && row[0] === "What it needs access to" ? [row[0], next.touch] : row
      ));
    }
    if (next.run && next.run.tone !== "danger") {
      const needsFakeInputs = highStakesAdvice;
      next.run = {
        ...next.run,
        tone: needsFakeInputs ? "warn" : "good",
        label: needsFakeInputs ? "Safe to test with fake inputs" : "Safe to inspect",
        why: needsFakeInputs
          ? "No direct write or account-connection surface was found. Use fake business context before pasting sensitive information."
          : "No direct write or account-connection surface was found in the pre-install review.",
      };
    }
    if (noDetailedFindings && !highStakesAdvice && next.trust && /verify|care|not evaluated/i.test(next.trust.label || "")) {
      next.trust = {
        ...next.trust,
        tone: "good",
        label: "Output not evaluated",
        why: "We did not run an output-quality check for this skill.",
        prominent: false,
      };
    }
    if (next.risk === "danger" && noDetailedFindings) {
      next.risk = "warn";
      next.verdict = "Use with care";
    }
    if (noDetailedFindings && next.trust && /do not|not trust/i.test(next.trust.label || "")) {
      next.risk = next.risk === "good" ? "warn" : next.risk;
      next.verdict = "Use with care";
      next.trust = {
        ...next.trust,
        tone: "warn",
        label: "Use with care",
        why: next.trust.why || "This skill may affect important decisions. Check its output in your own setup before relying on it.",
      };
    }
  }

  if (!isOutputNotEvaluatedTrust(next.trust)) {
    if (next.trust) next.trust.prominent = next.trust.prominent !== false;
    return finalizeReportDisplay(next);
  }

  const critical = decisionCriticalFromReport(next);
  next.trust = {
    ...(next.trust || {}),
    tone: critical ? "warn" : "good",
    label: (next.trust && next.trust.label) || "Output not evaluated",
    why: (next.trust && next.trust.why) || "Output correctness was not evaluated for this skill.",
    prominent: critical,
  };

  if (isOutputNotEvaluatedLine(next.finding) || isCleanFindingLine(next.finding)) {
    next.finding = { tone: "good", text: PACKAGE_REVIEW_CLEAN };
  }
  if (!instructionOnlyWithoutOps && !critical && /may change external systems or records named in the package/i.test(next.touch || "")) {
    next.touch = "It may affect files, repositories, or developer workflow state if you give it that access. Use a throwaway workspace first.";
  }
  if (
    !instructionOnlyWithoutOps &&
    !critical &&
    noDetailedFindings &&
    (!next.run || next.run.tone === "good") &&
    /^It references .+ and may handle sensitive inputs you provide\.?$/i.test(next.touch || "")
  ) {
    next.touch = "It may use files, repo context, or local test state you provide. No direct account connection or live-account write surface was found.";
    if (Array.isArray(next.picture)) {
      next.picture = next.picture.map((row) => (
        row && row[0] === "What it needs access to" ? [row[0], next.touch] : row
      ));
    }
  }

  if (critical && next.risk === "good") {
    next.risk = "warn";
    next.verdict = "Use with care";
  }
  if (!critical && next.risk === "warn" && (!next.run || next.run.tone === "good") && noDetailedFindings) {
    next.risk = "good";
    next.verdict = "Nothing flagged";
  }
  return finalizeReportDisplay(next);
}

function checkedText(readiness, auditSkill) {
  const method = (readiness.decision && readiness.decision.method) || "Static pre-install review; no live account or production workflow was executed.";
  if (!auditSkill) return method;
  return `${method} We also reviewed sample outputs for basic task fit, use of context, and safety boundaries.`;
}

function auditIssueRows(auditSkill) {
  const rows = [];
  const seen = new Set();
  const add = (severity, confidence, text) => {
    const clean = userFacingText(text);
    const key = `${severity}|${confidence}|${clean}`.toLowerCase();
    if (!clean || seen.has(key)) return;
    seen.add(key);
    rows.push([severity, confidence, clean]);
  };

  ((auditSkill && auditSkill.tasks) || []).forEach((task) => {
    (task.warnings || []).forEach((warning) => add("Med", "likely", warning));
  });
  Object.entries((auditSkill && auditSkill.flag_counts) || {}).forEach(([flag, count]) => {
    if (!count) return;
    const plainFlag = flag.replace(/_/g, " ");
    add("Low", "likely", FLAG_PLAIN[plainFlag] || `${plainFlag} needs review before you rely on the output.`);
  });
  return rows.slice(0, 8);
}

function skillSubtitle(foundRows, gradeability) {
  if (foundRows.length) return `${foundRows.length} issue${foundRows.length === 1 ? "" : "s"}`;
  const status = String((gradeability && gradeability.status) || "").toLowerCase();
  if (/sample|walkthrough/.test(status)) return "Needs testing with sample inputs";
  if (/mocked|live-account|integration/.test(status)) return "Needs a sandbox or mocked test";
  if (/static-only|inspectable|reviewed/.test(status)) return "Reviewed before install";
  if (/not[- ]?gradeable|unsupported/.test(status)) return "Could not fully grade";
  return "Reviewed before install";
}

function outputTrust(readiness, auditSkill, decisionCritical) {
  const decisionTrust = (readiness.decision && readiness.decision.output_trust) || {};
  const review = (readiness.breadth && readiness.breadth.review) || [];
  if (review.length) {
    return {
      tone: toneForLabel(decisionTrust.label || "Use with care"),
      label: decisionTrust.label || "Use with care",
      why: decisionTrust.why || `${review.length} review finding${review.length === 1 ? "" : "s"} surfaced.`,
      prominent: true,
    };
  }
  if (/verify before relying/i.test(decisionTrust.label || "")) {
    return {
      tone: "warn",
      label: decisionTrust.label,
      why: decisionTrust.why || "This is a high-stakes domain, so correctness needs qualified review.",
      prominent: true,
    };
  }
  if (auditSkill) {
    const issueRows = auditIssueRows(auditSkill);
    if (issueRows.length) {
      return {
        tone: "warn",
        label: "Use with care",
        why: "The sample output review found issues to check before relying on it. No confirmed defect surfaced.",
        prominent: true,
      };
    }
    return {
      tone: "good",
      label: "Nothing flagged",
      why: "Sample-output checks ran and no output defect surfaced. This is not proof the output is correct for every case.",
      prominent: true,
    };
  }
  if (isOutputNotEvaluatedTrust(decisionTrust)) {
    return {
      tone: decisionCritical ? "warn" : "good",
      label: decisionTrust.label || "Output not evaluated",
      why: decisionTrust.why || "Output correctness was not evaluated for this skill.",
      prominent: decisionCritical,
    };
  }
  return {
    tone: toneForLabel(decisionTrust.label || "Output not evaluated"),
    label: decisionTrust.label || "Output not evaluated",
    why: decisionTrust.why || "Output correctness was not evaluated for this skill.",
    prominent: decisionCritical,
  };
}

function touchText(readiness) {
  const map = (readiness.evaluation && readiness.evaluation.capability_map) || {};
  const surfaces = (map.tool_surfaces || []).map((s) => s.tool_or_surface).filter(Boolean);
  const surfaceText = compactText(surfaces);
  if (map.direct_actions_detected && LIVE_ACTION_SURFACE_RE.test(surfaceText)) {
    return "It may change live systems or business records named in the package. Test away from production first.";
  }
  if (map.direct_actions_detected) return "It may affect files, repositories, or developer workflow state if you give it that access. Use a throwaway workspace first.";
  const hasCommandSurface = Array.isArray(map.commands) && map.commands.length > 0;
  if (surfaces.length && !hasCommandSurface) {
    return "It may use files, repo context, or local test state you provide. No direct account connection or live-account write surface was found.";
  }
  if (surfaces.length) return `It references ${surfaces.join(", ")} and may handle sensitive inputs you provide.`;
  if (map.live_or_sensitive_surface_detected) return "It may handle sensitive business, customer, legal, financial, or operational information you provide.";
  return "The text and files you give it. No obvious live-account or write surface was found.";
}

function findingLine(readiness, auditSkill, decisionCritical) {
  const review = (readiness.breadth && readiness.breadth.review) || [];
  const confirmed = review.filter((f) => f.confirmation_tier === "CONFIRMED").length;
  const plausible = review.length - confirmed;
  if (review.length) {
    const parts = [];
    if (confirmed) parts.push(`${confirmed} confirmed`);
    if (plausible) parts.push(`${plausible} likely`);
    return {
      tone: confirmed ? "danger" : "warn",
      text: `${review.length} issue${review.length === 1 ? "" : "s"} found (${parts.join(", ")}). Review before relying on it.`,
    };
  }
  const issueRows = auditIssueRows(auditSkill);
  if (issueRows.length) {
    return {
      tone: "warn",
      text: `${issueRows.length} issue${issueRows.length === 1 ? "" : "s"} found in the sample output review. Review before relying on it.`,
    };
  }
  const trust = readiness.decision && readiness.decision.output_trust;
  if (trust && /not evaluated/i.test(trust.label || "")) {
    return { tone: "good", text: PACKAGE_REVIEW_CLEAN };
  }
  return { tone: "good", text: CLEAN_FINDINGS };
}

function findings(readiness, auditSkill) {
  const review = (readiness.breadth && readiness.breadth.review) || [];
  const rows = review.map((f) => [
    textFrom(f.severity || "Med"),
    f.confirmation_tier === "CONFIRMED" ? "confirmed" : "likely",
    sentence(f.reasoning || f.category || f.quote, "Review finding surfaced.", 220),
  ]);
  if (rows.length) return rows;
  return auditIssueRows(auditSkill);
}

function reportFromArtifacts(item, candidate, auditSkill) {
  const readinessPath =
    item.artifact ||
    item.readiness_json ||
    (item.artifacts && (item.artifacts.readiness_json || item.artifacts.readiness));
  const readiness = readJsonFile(path.resolve(process.cwd(), readinessPath || ""));
  if (!readiness) return null;
  const itemName =
    item.name ||
    item.skill_id ||
    (item.skill && (item.skill.name || item.skill.corpus_id)) ||
    (readiness.skill && (readiness.skill.name || readiness.skill.corpus_id)) ||
    item.index_name;
  const decision = readiness.decision || {};
  const run = decision.run_safety || {};
  const decisionCritical = decisionCriticalFromReadiness(readiness, item, candidate);
  const trust = outputTrust(readiness, auditSkill, decisionCritical);
  const name = shortName(itemName, candidate);
  const families = item.families || readiness.families || [];
  const risk = riskFor(readiness, auditSkill, decisionCritical);
  const found = findingLine(readiness, auditSkill, decisionCritical);
  const foundRows = findings(readiness, auditSkill);
  const capability = sentence(
    (candidate && candidate.description) || (readiness.evaluation && readiness.evaluation.claims && readiness.evaluation.claims[0] && readiness.evaluation.claims[0].quote),
    "Reviewed skill package."
  );
  const gradeability = readiness.evaluation && readiness.evaluation.gradeability;
  const nextTests = (readiness.evaluation && readiness.evaluation.evidence_accounting && readiness.evaluation.evidence_accounting.next_tests_needed) || [];
  const verified = (readiness.evaluation && readiness.evaluation.evidence_accounting && readiness.evaluation.evidence_accounting.verified_now) || [];
  const inferred = (readiness.evaluation && readiness.evaluation.evidence_accounting && readiness.evaluation.evidence_accounting.inferred_only) || [];
  const notTested = (readiness.evaluation && readiness.evaluation.evidence_accounting && readiness.evaluation.evidence_accounting.not_tested) || [];

  const display = normalizeReportDisplay({
    id: itemName || name,
    risk,
    title: name,
    tag: displayTag(readiness, families),
    verdict: risk === "danger" ? "Do not trust output" : risk === "warn" ? "Use with care" : "Nothing flagged",
    sub: skillSubtitle(foundRows, gradeability),
    summary: capability,
    run: {
      tone: toneForLabel(run.label),
      label: run.label || "Safe to inspect",
      why: run.why || "No obvious state-changing action surface surfaced in static review.",
    },
    trust: {
      tone: trust.tone,
      label: trust.label || "Output not evaluated",
      why: trust.why || "Output correctness was not evaluated for this skill.",
      prominent: trust.prominent,
    },
    finding: found,
    touch: touchText(readiness),
    verify: nextTests[0] || "Try it with sample inputs first, then check the result before relying on it.",
    checked: checkedText(readiness, auditSkill),
    bl: {
      tone: risk,
      title: risk === "danger" ? "Do not rely on this yet." : risk === "warn" ? "Useful, but review before relying." : "Low-risk to inspect.",
      answer:
        risk === "good"
          ? "No major issue surfaced in the checks we have for this skill. That still is not proof the output is correct for your situation."
          : "The skill has useful intent, but the review surfaced enough risk or uncertainty that you should test it carefully before using it for real decisions.",
      rec: nextTests[0] || "Use sample data first and review the output before real use.",
    },
    findings: foundRows,
    picture: [
      ["What it actually does", capability],
      ["Who it is for", audienceFor(readiness, families)],
      ["Who it is not for", "Anyone who needs guaranteed correctness without checking the result."],
      ["What can go wrong", found.text],
      ["What it needs access to", touchText(readiness)],
      ["What kind of package it is", readiness.evaluation && readiness.evaluation.capability_map ? readiness.evaluation.capability_map.package_shape : "Unknown package shape."],
    ],
    checklist: [
      nextTests[0] || "Use sample data first.",
      nextTests[1] || "Review outputs before relying on them.",
      "Do not paste sensitive real data until the first run behaves as expected.",
    ],
    scope: [
      ["v", "Checked", verified.join(" ") || "Package text, file inventory, and risky surfaces were inspected."],
      ["i", "Inferred", inferred.join(" ") || "Audience and use case were inferred from package text."],
      [
        "n",
        "Not tested",
        notTested.join(" ") ||
          "We did not connect any accounts, use real credentials, or run production workflows. That is intentional: a generic test cannot prove the skill will behave correctly inside your exact setup.",
      ],
    ],
    afterNote: "The parts to confirm once it is running on your side.",
    after: [
      "Try one realistic but non-production example.",
      "Compare the result against a source you already trust.",
      "Only then decide whether it belongs in a real workflow.",
    ],
  });
  if (display) {
    // Content fingerprint of the SKILL.md we graded (the harness's
    // skill_md_sha256). The live path compares it to the current file so a
    // changed skill gets a fresh grade instead of this cached one.
    const sha =
      (candidate && (candidate.skill_md_sha256 || candidate.canonical_skill_md_sha256)) ||
      item.skill_md_sha256 ||
      (readiness.skill && readiness.skill.skill_md_sha256);
    if (sha) display.contentSha256 = String(sha);
  }
  return display;
}

function submissionSummaryRows(summary) {
  if (!summary) return [];
  if (Array.isArray(summary.skills)) return summary.skills;
  const artifact =
    summary.artifact ||
    summary.readiness_json ||
    (summary.artifacts && (summary.artifacts.readiness_json || summary.artifacts.readiness));
  return artifact ? [summary] : [];
}

function reportPayloadFromSubmissionSummary(source, summary) {
  const rows = submissionSummaryRows(summary);
  const skills = rows
    .map((row) => reportFromArtifacts(row, row, null))
    .filter(Boolean)
    .sort(byRisk);
  if (!skills.length) return null;
  return {
    ok: true,
    source,
    previewCap: PREVIEW_CAP,
    skills,
  };
}

function findBehavioralBatch(readinessDir) {
  const root = path.resolve(__dirname, "..", "..", "corpus-index", "behavioral-sample-batches");
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const summaryPath = path.join(root, dir, "summary.json");
    const summary = readJsonFile(summaryPath);
    if (!summary) continue;
    if (summary.readiness_source === readinessDir || summary.readiness_source === readinessDir.replace(/^\.\//, "")) {
      const audit = readJsonFile(path.join(root, dir, "behavioral-audit.json"));
      return { summary, audit };
    }
  }
  return null;
}

function loadCandidates(slug) {
  const file = path.resolve(__dirname, "..", "..", "corpus-index", "public-candidates", `${slug}-index.json`);
  const data = readJsonFile(file);
  if (!data || !Array.isArray(data.skills)) return new Map();
  return new Map(data.skills.map((skill) => [skill.name, skill]));
}

function resultFromReadinessSummary(source, dir, summary) {
  const wantedRepo = normalizeRepoUrl(source.url);
  const wantedPath = githubPathAfterRepo(source.url);
  if (!wantedRepo || !summary || !summary.top_source_repos) return null;
  const repos = Object.keys(summary.top_source_repos).map(normalizeRepoUrl).filter(Boolean);
  if (!repos.includes(wantedRepo)) return null;
  const slug = dir.replace(/^readiness-/, "");
  const candidates = loadCandidates(slug);
  const batch = findBehavioralBatch(`corpus-index/${dir}`);
  const auditById = new Map(((batch && batch.audit && batch.audit.skills) || []).map((skill) => [skill.skill_id, skill]));
  const skillScoped = Boolean(wantedPath && (wantedPath === "skills" || wantedPath.startsWith("skills/") || wantedPath.includes("/skills/")));
  const matchingArtifacts = (summary.artifacts || []).filter((item) => {
    if (!wantedPath || !skillScoped) return true;
    const candidate = candidates.get(item.name);
    const possible = [
      item.path,
      item.source_url,
      candidate && candidate.path,
      candidate && candidate.source_url,
    ].filter(Boolean);
    return possible.some((value) => {
      const fromUrl = githubPathAfterRepo(value);
      const normalized = (fromUrl || String(value)).toLowerCase();
      return normalized.endsWith(wantedPath) || normalized.includes(wantedPath);
    });
  });
  const skills = matchingArtifacts
    .map((item) => reportFromArtifacts(item, candidates.get(item.name), auditById.get(item.name)))
    .filter(Boolean)
    .sort(byRisk);
  if (!skills.length) return null;
  return {
    ok: true,
    source,
    previewCap: PREVIEW_CAP,
    skills,
  };
}

function loadRealSource(source) {
  const wantedRepo = normalizeRepoUrl(source.url);
  if (!wantedRepo) return null;
  const corpusRoot = path.resolve(__dirname, "..", "..", "corpus-index");
  if (!fs.existsSync(corpusRoot)) return null;
  const readinessRoot = path.join(corpusRoot);
  const dirs = fs.readdirSync(readinessRoot).filter((name) => name.startsWith("readiness-"));
  for (const dir of dirs) {
    const summary = readJsonFile(path.join(readinessRoot, dir, "summary.json"));
    const result = resultFromReadinessSummary(source, dir, summary);
    if (result) return result;
  }
  return null;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

module.exports = {
  PREVIEW_CAP,
  buildSourceResult,
  classifyLiveError,
  contentSha256,
  githubSkillPathKey,
  isSkillFilePath,
  isSupportedHost,
  isValidEmail,
  logServerEvent,
  normalizeRepoUrl,
  normalizeReportDisplay,
  normalizeSourceUrl,
  normalizedUrlKey,
  reportPayloadFromSubmissionSummary,
  reportFromArtifacts,
  reportNeedsBackgroundGrade,
  readJson,
  readJsonFile,
  resultFromReadinessSummary,
  sourceNeedsBackgroundGrade,
  stripFull,
  triageSignals,
};
