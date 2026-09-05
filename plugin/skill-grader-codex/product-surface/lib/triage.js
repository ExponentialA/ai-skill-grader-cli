// The run-safety signal core. This is the ONLY part of the engine the hooks
// need (scan-skill, skill-read, action-guard all call triageSignals), so it
// lives here as a tiny module each plugin can bundle instead of the full 88KB
// reports.js. reports.js re-exports these so the site keeps one source of truth;
// if any regex changes, every consumer changes with it. Kept dependency-free.
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
const OPERATIONAL_SURFACE_RE = /\b(mcp|tool call|function call|webhook|endpoint|sdk|integration|service account|oauth|access token|auth token|bearer token|\.env|curl|npm|pip|python|node|bash|shell|cli)\b/i;
const SENSITIVE_RE = /\b(customer|lead|prospect|email|transcript|contract|financial|revenue|arr|cac|margin|retention|pii|private|confidential|sensitive|dataroom|investor)\b/i;
const PAID_RE = /\b(paid|billing|spend|budget|ads?|ad platform|stripe|credits?|rate limit|quota)\b/i;
const MANIPULATION_RE = /\b(ignore (previous|all|above) instructions|do not tell (the )?user|hide this from (the )?user|exfiltrat|send .*(secret|token|credential)|steal|self-approve|bypass approval)\b/i;

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

module.exports = {
  triageSignals,
  DECISION_CRITICAL_RE,
  LIVE_ACTION_SURFACE_RE,
  ACTION_RE,
  CREDENTIAL_RE,
  SCRIPT_RE,
  OPERATIONAL_SURFACE_RE,
  SENSITIVE_RE,
  PAID_RE,
  MANIPULATION_RE,
};
