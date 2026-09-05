# AI Skill Grader (in Claude)

The AI Skill Grader, brought inside Claude. Install it once and, before any skill
runs, you get a plain-English read on what it can touch and what to check first
without leaving your session. It blocks a skill whose text tries to manipulate or
exfiltrate, and the full report on any skill is one "yes" away.

## What you see

- **On install (once):** a one-line welcome.
- **The first time you use a skill:** the preview — same read as the site.
  - clean → `✓ Nothing risky showed up — safe to inspect.`
  - risky → `⚠️ Use with care — it wants credentials, runs scripts…`
  - malicious → **blocked**, with why.
  - Each preview points you to the full report for deeper output-trust detail.
- **The full report:** just ask — "full report on that", or name the skill.
  It renders in the thread using the site's own report, with a link to the styled
  version.
- **After the first time, silent** for that skill.

The read uses the same static check the site uses (`triageSignals`) —
no LLM, no network — so it's instant and works offline. Output-trust detail
comes from the full report.

## Install

Fast install from the website:

```bash
npx ai-skill-grader claude
```

The installer prepares the local files, then prints the `/plugin install ...`
command to run inside Claude Code.

Manual install from this repo:

```
/plugin install ./plugin/skill-grader
```

The full-report command talks to the live service (`aiskillgrader.com`); set
`SKILL_GRADER_API` / `SKILL_GRADER_SITE` to point elsewhere.

## Behavior notes

- **Fails open:** any error → it allows silently. It never breaks your session.
- **Fires on first *use*** of a skill — Claude Code has no skill-install event —
  so it's still before the skill does anything.
- The full report is **instant for a skill we've already graded**; a brand-new
  one comes back as the fast preview with "grading, back in a few minutes."

## Still limited

- Claude Code still requires one command inside Claude Code after the installer
  prepares the local files.
