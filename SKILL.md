---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo — is it safe to run, and does it do what it says. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
---

The user wants the full AI Skill Grader report on a skill or repo (they will have named it or pasted a GitHub link).

Run this command and show the user its output **verbatim** — do not summarize or reformat it:

```bash
npx ai-skill-grader report "<skill name or GitHub URL>"
```

Replace `<skill name or GitHub URL>` with what the user gave you.

- An already-graded skill returns the full report instantly.
- A brand-new one returns the fast preview with a note that the deep grade takes a few minutes.

For the automatic guard — a read on every skill your agent loads, plus blocking a
manipulative skill's scripts — install it in your agent instead:
`npx ai-skill-grader <codex|claude|cursor|cline|windsurf>`
(details at https://www.aiskillgrader.com/install.html).
