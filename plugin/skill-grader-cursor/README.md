# AI Skill Grader (in Cursor)

The AI Skill Grader, brought inside Cursor. Add one hook and you get a
plain-English read on what your skills can touch and what to check first,
without leaving your session. The full report on any skill is one ask away.

Same static check as the site and the other adapters
(`triageSignals`), and the same read builder (`plugin/shared/skill-read.js`) —
no LLM, no network.

## What you see

- **First session (once):** a one-line welcome, then a read on the skills you
  already have.
- **At the start of a session with a new skill:** the preview — same read as the
  site: `✓ safe to inspect`, `⚠️ use with care…`, or `⛔ manipulation/exfiltration
  (its scripts are blocked from running)`, shown **worst-first**, capped at three,
  with a count roll-up for the rest.
- **The full report:** just ask — "full report on `<skill>`", or paste its
  GitHub link. It renders in the thread using the site's own report.
- **Skills you've already seen: silent.**

## How it surfaces on Cursor

Cursor loads a skill as **context**, not as a tool call, and its `sessionStart`
hook has no user-facing message channel — only `additional_context` injected into
the conversation. So this adapter does two things:

- **Reads** at `sessionStart`: any skill it hasn't shown you yet, injected as
  context framed for the agent to show you.
- **Blocks** via a **`beforeShellExecution`** hook: any shell command that would
  run a script from a skill flagged **manipulative** (`permission: "deny"` — the
  only verdict Cursor reliably enforces — exactly right for the grader, which
  only ever tightens).

What it does **not** block: risky-but-not-manipulative skills, inline commands
with no script path, and MCP calls. Sandbox anything flagged before trusting it.

## Install (prototype)

Fast install from the website:

```bash
curl -fsSL https://www.aiskillgrader.com/install.sh | sh -s -- cursor
```

Manual install from this repo:

1. Add `sessionStart` (the read) and `beforeShellExecution` (the script-block)
   entries to your Cursor hooks at `~/.cursor/hooks.json` (create the file if it
   doesn't exist), pointing at these scripts with **absolute paths**:

   ```json
   {
     "version": 1,
     "hooks": {
       "sessionStart": [
         {
           "type": "command",
           "command": "node \"/ABSOLUTE/PATH/TO/ai-skill-grader/plugin/skill-grader-cursor/scripts/scan-session.js\"",
           "timeout": 15
         }
       ],
       "beforeShellExecution": [
         {
           "type": "command",
           "command": "node \"/ABSOLUTE/PATH/TO/ai-skill-grader/plugin/skill-grader-cursor/scripts/scan-command.js\"",
           "timeout": 10
         }
       ]
     }
   }
   ```

   Replace the paths with the absolute paths in your clone. (See
   `hooks/hooks.json` for the same template.) Cursor watches the file and
   reloads it; if it doesn't pick up, restart Cursor.

2. (Optional) To route natural-language "full report on X" requests, copy the
   report skill into your Cursor skills:

   ```bash
   cp -r plugin/skill-grader-cursor/skills/skill-grader-report ~/.cursor/skills/
   ```

The full-report command talks to the live service (`aiskillgrader.com`); set
`SKILL_GRADER_API` / `SKILL_GRADER_SITE` to point elsewhere.

## Behavior notes

- **Fails open:** any error → it stays silent and the session proceeds. It never
  breaks the session it protects. (`failClosed` is left at Cursor's default of
  `false`.)
- **Reads each skill once**, then stays quiet (state in `~/.cursor/`:
  `skill-grader-seen.json`, `skill-grader-welcomed`).
- Discovers skills in `~/.cursor/skills`, `~/.agents/skills`, and the project's
  `.cursor/skills` / `.agents/skills` (`CURSOR_PROJECT_DIR`).
- The full report is **instant for a skill we've already graded**; a brand-new
  one comes back as the fast preview with "grading, back in a few minutes."

## Next steps (if this validates)

- Widen the block beyond flagged-skill *scripts* — inline commands and MCP calls
  (`beforeMCPExecution`) a flagged skill would trigger (needs command-level
  judgment, not just skill-text triage).
- Standalone packaging so install needs no repo clone.

Note: `beforeShellExecution` (and `beforeMCPExecution`) don't run in Cursor
Cloud Agents, so the script-block is desktop-only; the read still runs everywhere.
