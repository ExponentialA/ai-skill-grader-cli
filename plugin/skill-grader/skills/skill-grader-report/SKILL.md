---
name: skill-grader-report
description: Get the full AI Skill Grader report on a skill or repo: what it can touch, what to check first, and whether anything was flagged. Use whenever the user asks for the full report, a deep report, or to "grade" a skill they named or pasted a GitHub link to.
arguments: [skill]
---

The full AI Skill Grader report for `$0`:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/report.js "$0"`

Show the output above to the user as-is. If it is the full report, you are done. If it says this is a fast preview (the skill isn't deep-graded yet), do NOT poll, wait, re-run, or start a background task expecting a deep report to appear: the deep grade for a new skill is produced on request and delivered by email only. Just make sure the user sees the preview and the "To get the full deep report" instructions in the output, and stop.
