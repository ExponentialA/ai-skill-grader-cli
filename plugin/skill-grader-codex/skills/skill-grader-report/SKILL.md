---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo, including what it can touch, what to check first, and any issues found. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
---

The user wants the full AI Skill Grader report on a skill (they will have named it or pasted a GitHub link).

Run this command and show the user its output **verbatim** (do not summarize or reformat it):

```bash
node "$HOME/.ai-skill-grader/scripts/report-installed.js" "<skill name or GitHub URL>"
```

Replace `<skill name or GitHub URL>` with what the user gave you.

- An already-graded skill returns the full report instantly.
- A new skill returns the fast preview. Do NOT poll, wait, or re-run for a deep report to appear: the deep grade for a new skill is produced on request and delivered by email only. The output tells the user how to get it; show that and stop.
- If the installed report command does not exist, ask the user to run `npx ai-skill-grader codex`.
