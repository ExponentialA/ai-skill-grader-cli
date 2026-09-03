---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo — whether it is safe to run and whether it does what it says. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
arguments: [skill]
---

The full AI Skill Grader report for `$0`:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/report.js "$0"`
