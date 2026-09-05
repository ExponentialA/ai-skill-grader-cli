#!/bin/sh
# AI Skill Grader — run a plugin script with Node.
#
# Agents launched from the Dock/Finder (or a VS Code extension host) often run
# with a minimal PATH that doesn't include an nvm/homebrew Node. A hook that
# calls a bare `node` then fails to start — and a check that never runs means the
# grader silently isn't protecting the user, which is the worst outcome for a
# safety tool. This resolves Node from the usual install locations when PATH
# doesn't have it.
#
# Usage: run-node.sh <script.js> [args...]
# FAILS OPEN: if Node genuinely can't be found, it exits 0 so the agent proceeds
# normally rather than breaking the session.
set -u

NODE="${SKILL_GRADER_NODE:-}"
# An override that doesn't point at a runnable Node is ignored, not trusted —
# otherwise exec would hard-fail instead of falling through / failing open.
if [ -n "$NODE" ] && [ ! -x "$NODE" ]; then
  NODE=""
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  for candidate in \
    /usr/local/bin/node \
    /opt/homebrew/bin/node \
    /usr/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node
  do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  echo "AI Skill Grader: could not find Node, so this check was skipped." >&2
  exit 0
fi

exec "$NODE" "$@"
