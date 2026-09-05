# AI Skill Grader (in Windsurf)

Two things inside Windsurf: it **blocks** a manipulative skill's scripts from
running, and it gives you the **full report** on any skill on request. Same
static engine and renderer as the site.

## What it does — and doesn't

Windsurf can't host the plain-English **read** the other adapters surface:

- **No automatic start-of-session event.** Windsurf's 12 Cascade hooks fire around specific
  actions (`pre_*` / `post_*`); nothing fires when a session begins.
- **No way to surface a read.** Cascade hooks communicate *only* through exit
  codes and stderr (and stderr shows only when a hook **blocks**) — there's no
  context/message channel to inject a read into the conversation.

So there's no automatic warning list on Windsurf. What *does* work:

- **Block (auto).** A `pre_run_command` hook blocks any shell command that would
  run a script from a skill flagged **manipulative** (exit 2; the reason goes to
  stderr, which Cascade sees). This is Windsurf's in-session grader.
- **Report (on ask).** Windsurf supports `SKILL.md` skills (Wave 13), so "full
  report on `<skill>`" routes to the report.

What it does **not** block: risky-but-not-manipulative skills, inline commands
with no script path, and MCP calls. There's no read to warn you first, so on
Windsurf especially — sandbox anything before you trust it.

## Install

Fast install from the website:

```bash
npx ai-skill-grader windsurf
```

Manual install from this repo:

1. Add a `pre_run_command` entry to your Windsurf hooks at
   `~/.codeium/windsurf/hooks.json` (create the file if it doesn't exist),
   pointing at the grader with an **absolute path**:

   ```json
   {
     "hooks": {
       "pre_run_command": [
         {
           "command": "node \"/ABSOLUTE/PATH/TO/ai-skill-grader/plugin/skill-grader-windsurf/scripts/scan-command.js\"",
           "show_output": true
         }
       ]
     }
   }
   ```

   Replace the path with the absolute path in your clone. (See `hooks/hooks.json`
   for the same template.)

2. (Optional) For the on-demand report, copy the report skill into your skills
   and set its path:

   ```bash
   cp -r plugin/skill-grader-windsurf/skills/skill-grader-report ~/.agents/skills/
   ```

   Then edit the copied `SKILL.md` and replace `/ABSOLUTE/PATH/TO/ai-skill-grader`
   with the path to this clone. Windsurf discovers skills in `.windsurf/skills/`,
   `.agents/skills/`, and `~/.agents/skills/`.

The report command talks to the live service (`aiskillgrader.com`); set
`SKILL_GRADER_API` / `SKILL_GRADER_SITE` to point elsewhere.

## Notes

- **Fails open:** any hook error → the command is allowed (exit 0). The grader
  never breaks the session it protects.
- The full report is **instant for a skill we've already graded**; a brand-new
  one comes back as the fast preview with "grading, back in a few minutes."
