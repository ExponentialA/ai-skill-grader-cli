// AI Skill Grader — shared read builder for the per-tool session-start adapters
// (Codex, Cursor, and future tools that load skills as context rather than as a
// tool call). Pure: no fs, no network, no tool-specific I/O. Given the skills a
// session hasn't shown yet, it produces the human-readable run-safety read —
// worst-first, capped, with a count roll-up and the site's verdict-adaptive
// close. Each adapter wraps `message` in its own tool's output shape and adds
// its own "how to get the full report" enablement text.
//
// A `sig` here is a triageSignals() result from product-surface/lib/reports.js.

const CAP = 3;
const RISKY_KEYS = ["directLiveAction", "credentials", "scripts", "paid", "sensitive", "decisionCritical"];
const CONCERN = {
  directLiveAction: "can act on live accounts or systems",
  credentials: "wants credentials or tokens",
  scripts: "runs scripts",
  paid: "can spend money",
  sensitive: "handles sensitive data",
  decisionCritical: "feeds costly decisions",
};

function severity(sig) {
  if (sig.manipulation) return 1000;
  return RISKY_KEYS.filter((k) => sig[k]).length;
}
function isFlagged(sig) {
  return sig.manipulation || RISKY_KEYS.some((k) => sig[k]);
}
function skillLine(skill) {
  const { name, file, sig } = skill;
  if (sig.manipulation) {
    return `⛔ ${name} — manipulation/exfiltration language in its instructions file. I'll block its scripts from running; read ${file} before you trust it.`;
  }
  const concerns = RISKY_KEYS.filter((k) => sig[k]).map((k) => CONCERN[k]);
  if (concerns.length) {
    return `⚠️ ${name} — use with care: it ${concerns.join(", ")}. Try it in a sandbox first.`;
  }
  return `✓ ${name} — nothing risky showed up, safe to inspect.`;
}

// skills: [{ name, file, sig }]. opts: { welcome: bool }.
// Returns { message, shownCount, flaggedCount } or null when there is nothing
// worth saying (no new skills and no welcome).
function buildRead(skills, opts) {
  const welcome = !!(opts && opts.welcome);
  if (!skills.length && !welcome) return null;

  const ranked = skills.slice().sort((a, b) => severity(b.sig) - severity(a.sig));
  const shown = ranked.slice(0, CAP);
  const flaggedCount = ranked.filter((s) => isFlagged(s.sig)).length;

  const lines = [];
  if (welcome) {
    lines.push(
      "AI Skill Grader is on. Before you rely on a skill, here's a plain-English read on what it can touch and what to check first."
    );
  }

  if (!skills.length) {
    lines.push("No skills installed yet — I'll read the first one you add.");
  } else {
    lines.push(welcome ? "I read the skills you have now:" : "New skill this session:");
    for (const s of shown) lines.push(skillLine(s));

    const remaining = ranked.length - shown.length;
    if (remaining > 0) {
      const remFlagged = ranked.slice(CAP).filter((s) => isFlagged(s.sig)).length;
      lines.push(
        remFlagged > 0
          ? `+ ${remaining} more scanned — ${remFlagged} with flags, ${remaining - remFlagged} clean. Ask for the full report on any by name.`
          : `+ ${remaining} more scanned — none flagged.`
      );
    }

    // Verdict-adaptive close, mirroring the site's gate copy: with flags the
    // pull is depth (how serious, what to do); clean, it's the anatomy (what it
    // can reach, what to check first).
    const example = ranked[0].name;
    lines.push(
      flaggedCount > 0
        ? `The full report shows how serious each flag is and exactly what to do — free. Say "full report on ${example}" for any skill above.`
        : `Nothing flagged — but a skill can still reach more than you think. The full report shows what each can reach and what to check first — free. Say "full report on ${example}".`
    );
  }

  return { message: lines.join("\n"), shownCount: shown.length, flaggedCount };
}

module.exports = { buildRead, severity, skillLine, isFlagged, CAP, RISKY_KEYS, CONCERN };
