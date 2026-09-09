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

// A skill may carry `graded` ("d"|"w"|"g") — OUR authoritative verdict from the
// content-hash index. When present it wins over the fast regex signals.
function gradedSeverity(g) {
  return g === "d" ? 1000 : g === "w" ? 1 : 0;
}
function skillSeverity(skill) {
  return skill.graded ? gradedSeverity(skill.graded) : severity(skill.sig);
}
function skillFlagged(skill) {
  return skill.graded ? skill.graded !== "g" : isFlagged(skill.sig);
}
function skillLine(skill) {
  const { name, graded, sig } = skill;
  // Authoritative graded verdict: we've deep-graded this exact content.
  if (graded === "d") return `⛔ ${name}: we graded this, do not rely on it. Say "full report on ${name}" for what and why.`;
  if (graded === "w") return `⚠️ ${name}: we graded this, use with care. Say "full report on ${name}" for what and why.`;
  if (graded === "g") return `✓ ${name}: we graded this; nothing flagged in our review. Say "full report on ${name}" for what it can touch.`;
  // Fast regex read: we haven't graded this one, so a flag is a suspicion, not a verdict.
  if (sig.manipulation) {
    return `⛔ ${name}: held back for a closer look. Its instructions contain manipulation-style language; say "full report on ${name}" to find out whether it's a real risk before you run it.`;
  }
  const concerns = RISKY_KEYS.filter((k) => sig[k]).map((k) => CONCERN[k]);
  if (concerns.length) {
    return `⚠️ ${name}: use with care. It ${concerns.join(", ")}. Try it in a sandbox first.`;
  }
  return `✓ ${name}: nothing risky showed up, safe to inspect.`;
}

// skills: [{ name, file, sig }]. opts: { welcome: bool }.
// Returns { message, shownCount, flaggedCount } or null when there is nothing
// worth saying (no new skills and no welcome).
function buildRead(skills, opts) {
  const welcome = !!(opts && opts.welcome);
  if (!skills.length && !welcome) return null;

  const ranked = skills.slice().sort((a, b) => skillSeverity(b) - skillSeverity(a));
  const shown = ranked.slice(0, CAP);
  const flaggedCount = ranked.filter((s) => skillFlagged(s)).length;

  const lines = [];

  if (!skills.length) {
    // Only reachable with welcome (non-welcome + no skills returns null above).
    // Don't promise a read there's nothing to show; invite a try instead.
    lines.push(
      "AI Skill Grader is on. From now on, before you rely on a skill, you'll get a plain-English read on what it can touch and what to check first."
    );
    lines.push(
      "No skills installed yet, so nothing to check right now. Want to see how it works? Paste any public skill's GitHub link and I'll grade it."
    );
  } else {
    lines.push(
      welcome
        ? "AI Skill Grader is on. Here's a plain-English read on the skills you already have, so you know what each can touch before you rely on it:"
        : "New skill this session:"
    );
    for (const s of shown) lines.push(skillLine(s));

    const remaining = ranked.length - shown.length;
    if (remaining > 0) {
      const remFlagged = ranked.slice(CAP).filter((s) => skillFlagged(s)).length;
      lines.push(
        remFlagged > 0
          ? `+ ${remaining} more scanned: ${remFlagged} with flags, ${remaining - remFlagged} clean. Ask for the full report on any by name.`
          : `+ ${remaining} more scanned, none flagged.`
      );
    }

    // Verdict-adaptive close, mirroring the site's gate copy: with flags the
    // pull is depth (how serious, what to do); clean, it's the anatomy (what it
    // can reach, what to check first).
    const example = ranked[0].name;
    lines.push(
      flaggedCount > 0
        ? `The full report shows how serious each flag is and exactly what to do, free. Say "full report on ${example}" for any skill above.`
        : `Nothing flagged, but a skill can still reach more than you think. The full report shows what each can reach and what to check first, free. Say "full report on ${example}".`
    );
  }

  return { message: lines.join("\n"), shownCount: shown.length, flaggedCount };
}

module.exports = { buildRead, severity, skillLine, isFlagged, CAP, RISKY_KEYS, CONCERN };
