---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo: what it can touch, what to check first, and whether anything was flagged. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
arguments: [skill]
---

The full AI Skill Grader report for `$0`:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/report.js "$0"`
