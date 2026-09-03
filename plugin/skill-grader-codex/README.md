# AI Skill Grader (in Codex)

The AI Skill Grader, brought inside OpenAI Codex. Install it once and you get a
plain-English read on what your skills can touch and what to check first,
without leaving your session. The full report on any skill is one ask away.

Same static check as the site and the Claude adapter
(`triageSignals`) — no LLM, no network — so it's instant and works offline.

## What you see

- **On install, first session (once):** a one-line welcome, then a read on the
  skills you already have.
- **At the start of a session with a new skill:** the preview — same read as the
  site.
  - clean → `✓ <skill> — nothing risky showed up, safe to inspect.`
  - risky → `⚠️ <skill> — use with care: it runs scripts, wants credentials…`
  - malicious → `⛔ <skill> — manipulation/exfiltration; its scripts are blocked from running.`
  - Reads are shown **worst-first**, capped at three, with a one-line roll-up
    (`+ N more scanned — 2 with flags, 5 clean`) for the rest.
- **The full report:** just ask — "full report on `<skill>`", or paste its
  GitHub link. It renders in the thread using the site's own report, with a link
  to the styled version.
- **Skills you've already seen: silent.**

## Read at session start, block scripts at run

Claude Code invokes a skill through a tool call, so the Claude adapter reads (and
can **block**) each skill the moment it runs. **Codex loads a skill as context**,
not as a tool call — there's no per-skill "run" event to gate. So this adapter
does two things:

- **Reads** every skill it hasn't shown you yet at **`SessionStart`** (the read
  above).
- **Blocks** — via a **`PreToolUse`** hook — any shell command that would run a
  script from a skill flagged **manipulative** (the ⛔ case), enforcing that
  verdict at run time.

What it does **not** block: risky-but-not-manipulative skills (you get the ⚠️
read, not a block), inline commands a skill tells the agent to run with no script
path, and MCP calls (no path to attribute). Sandbox anything flagged before
trusting it.

## Install (prototype)

Fast install from the website:

```bash
curl -fsSL https://www.aiskillgrader.com/install.sh | sh -s -- codex
```

Manual install from this repo:

1. Add a local entry to your personal Codex marketplace at
   `~/.agents/plugins/marketplace.json` pointing at this plugin directory:

   ```json
   {
     "name": "skill-grader-dev",
     "interface": { "displayName": "AI Skill Grader (dev)" },
     "plugins": [
       {
         "name": "skill-grader",
         "source": { "source": "local", "path": "/ABSOLUTE/PATH/TO/ai-skill-grader/plugin/skill-grader-codex" }
       }
     ]
   }
   ```

   Replace the `path` with the absolute path to this directory in your clone.

2. Install it:

   ```bash
   codex plugin add skill-grader@skill-grader-dev
   ```

3. Start a Codex session. The welcome + first reads appear on `SessionStart`,
   and the `PreToolUse` script-block is active. (`codex plugin list` confirms it's
   installed.) Both hooks are registered by the plugin's `hooks/hooks.json` — no
   extra setup.

The full-report command talks to the live service (`aiskillgrader.com`); set
`SKILL_GRADER_API` / `SKILL_GRADER_SITE` to point elsewhere.

## Behavior notes

- **Fails open:** any error → it stays silent and the session proceeds. It never
  breaks the session it protects.
- **Reads each skill once**, then stays quiet (state in `$CODEX_HOME`, default
  `~/.codex/`: `skill-grader-seen.json`, `skill-grader-welcomed`).
- Discovers skills in `~/.codex/skills`, `~/.agents/skills`, and the project's
  `.codex/skills` / `.agents/skills`.
- The full report is **instant for a skill we've already graded**; a brand-new
  one comes back as the fast preview with "grading, back in a few minutes."

## Next steps (if this validates)

- Widen the block beyond flagged-skill *scripts* — e.g. inline commands and MCP
  calls a flagged skill would trigger (needs command-level judgment, not just
  skill-text triage).
- Standalone/marketplace packaging (bundle the engine with a drift-check) so
  install needs no repo clone.
