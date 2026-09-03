---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo — whether it is safe to run and whether it does what it says. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
---

The user wants the full AI Skill Grader report on a skill (they will have named it or pasted a GitHub link).

Run this command and show the user its output **verbatim** — do not summarize or reformat it:

```bash
node "$(cat "$HOME/.skill-grader-cline/skill-grader-root")/scripts/report.js" "<skill name or GitHub URL>"
```

Replace `<skill name or GitHub URL>` with what the user gave you.

- An already-graded skill returns the full report instantly.
- A brand-new one returns the fast preview with a note that the deep grade takes a few minutes.
- If the `skill-grader-root` file does not exist, the grader hasn't run yet — start a new Cline task (the TaskStart hook records it) and try again.
