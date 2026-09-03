# AI Skill Grader

**A plain-English run-safety read on the skills your coding agent runs — installed where you work.**

Public agent skills are one command to install and hard to vet. The AI Skill Grader,
installed in your agent, gives you a read on a skill **before you rely on it** — is it
safe to run, and does it do what it says — and blocks a skill flagged manipulative from
running its scripts. Same static engine as [aiskillgrader.com](https://www.aiskillgrader.com/):
no LLM, no network, so it's instant and works offline.

This repo is the public distribution (CLI + plugins + engine). It's meant to be read.

## Install

```bash
npx ai-skill-grader codex        # or: claude, cursor, cline, windsurf
npx ai-skill-grader --all        # every tool it detects
```

| Tool | What you get |
|---|---|
| Codex | Reads new skills at session start, blocks a flagged skill's scripts |
| Claude Code | Reads (and can block) each skill the moment it runs |
| Cursor | Reads new skills at session start, blocks a flagged skill's scripts |
| Cline | Reads new skills at task start, blocks a flagged skill's scripts (macOS/Linux) |
| Windsurf | Blocks a flagged skill's scripts + on-demand report (can't show the session read) |

## Report on any skill

```bash
npx ai-skill-grader report "owner/repo"      # or a GitHub URL, or an installed skill name
```

Or install the on-demand report as a skill via [skills.sh](https://skills.ws):

```bash
npx skills add ExponentialA/ai-skill-grader-cli
```

## Uninstall

```bash
npx ai-skill-grader uninstall            # every tool
npx ai-skill-grader uninstall cursor     # one tool
```

## What it does — and doesn't

- **Reads** every skill it hasn't shown you yet: `✓ safe to inspect`, `⚠️ use with care…`,
  or `⛔ manipulation/exfiltration`. Worst-first, capped, with a count roll-up.
- **Blocks** a shell command that would run a script from a skill flagged manipulative.
- **Does not** block risky-but-not-manipulative skills, inline commands with no script
  path, or MCP calls — those stay in the read. Sandbox anything flagged before you trust it.

## Safe by construction

- **`npx`, nothing piped into your shell.** Read the installer first:
  [`scripts/install-plugin.mjs`](scripts/install-plugin.mjs).
- **Backs up** every file before it changes it; **merges** into your existing hook config
  (never clobbers your other hooks); idempotent; **never** asks for credentials or API keys.
- **Fails open:** if anything goes wrong, the check is skipped and your session proceeds —
  a safety tool must never break the session it protects.
- Installs to `~/.ai-skill-grader`. macOS / Linux (Cline hooks are macOS/Linux only).

## License

MIT
