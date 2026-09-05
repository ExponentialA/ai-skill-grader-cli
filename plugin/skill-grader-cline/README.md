# AI Skill Grader (in Cline)

The AI Skill Grader, brought inside Cline. Add one hook and you get a
plain-English read on what your skills can touch and what to check first,
without leaving your session. The full report on any skill is one ask away.

Same static check as the site and the other adapters
(`triageSignals`), and the same read builder (`plugin/shared/skill-read.js`) —
no LLM, no network.

## What you see

- **First task (once):** a one-line welcome, then a read on the skills you
  already have.
- **At the start of a task with a new skill:** the preview — same read as the
  site: `✓ safe to inspect`, `⚠️ use with care…`, or `⛔ manipulation/exfiltration
  (its scripts are blocked from running)`, shown **worst-first**, capped at three,
  with a count roll-up for the rest.
- **The full report:** just ask — "full report on `<skill>`", or paste its
  GitHub link.
- **Skills you've already seen: silent.**

## How it surfaces on Cline

Cline loads skills as context, so — like the Codex and Cursor adapters — this
does two things:

- **Reads** at **`TaskStart`** (a task = a Cline session), which can inject
  context via `contextModification`: any skill it hasn't shown you yet, framed
  for the agent to show you.
- **Blocks** via a **`PreToolUse`** hook (`{"cancel": true}`): any shell command
  that would run a script from a skill flagged **manipulative**.

What it does **not** block: risky-but-not-manipulative skills, inline commands
with no script path, and MCP calls. Sandbox anything flagged before trusting it.

## Install

Fast install from the website:

```bash
npx ai-skill-grader cline
```

Manual install from this repo:
**macOS / Linux only** (Cline hooks are not supported on Windows).

1. Symlink both hooks into your Cline hooks directory — `TaskStart` (the read)
   and `PreToolUse` (the script-block). Global shown; or use `.clinerules/hooks/`
   for one project:

   ```bash
   mkdir -p ~/Documents/Cline/Hooks
   ln -s "$PWD/plugin/skill-grader-cline/hooks/TaskStart"  ~/Documents/Cline/Hooks/TaskStart
   ln -s "$PWD/plugin/skill-grader-cline/hooks/PreToolUse" ~/Documents/Cline/Hooks/PreToolUse
   ```

   Each file must be named exactly after its hook type (no extension) and be
   executable — the symlinks preserve both.

2. (Optional) To route natural-language "full report on X" requests, copy the
   report skill into your skills:

   ```bash
   cp -r plugin/skill-grader-cline/skills/skill-grader-report ~/.agents/skills/
   ```

The full-report command talks to the live service (`aiskillgrader.com`); set
`SKILL_GRADER_API` / `SKILL_GRADER_SITE` to point elsewhere.

## Behavior notes

- **Fails open:** any error → it stays silent and the task proceeds. It never
  breaks the session it protects.
- **Reads each skill once**, then stays quiet (state in `~/.skill-grader-cline/`:
  `skill-grader-seen.json`, `skill-grader-welcomed`).
- Discovers skills in `~/.agents/skills`, `.agents/skills`, and `.clinerules/skills`.
- The full report is **instant for a skill we've already graded**; a brand-new
  one comes back as the fast preview with "grading, back in a few minutes."

## Still limited

- Widen the block beyond flagged-skill *scripts* — inline commands and MCP calls
  a flagged skill would trigger (needs command-level judgment, not just
  skill-text triage).
