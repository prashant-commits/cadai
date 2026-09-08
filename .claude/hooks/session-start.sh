#!/bin/bash
# SessionStart hook: prepare the repo so linting and tests work immediately.
# Runs synchronously so dependencies are ready before the session starts.
set -euo pipefail

# Only run in Claude Code on the web; local machines manage their own installs.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

echo "[session-start] node $(node -v), npm $(npm -v)"

# npm install (not ci) so the cached container layer is reused on later sessions.
# .npmrc sets legacy-peer-deps=true, which this project's dependency tree needs.
# --no-save keeps package-lock.json clean: this npm version would otherwise strip
# "libc" metadata written by a newer npm and dirty the tree on every session.
echo "[session-start] installing npm dependencies..."
npm install --no-save --no-audit --no-fund

echo "[session-start] done: $(ls node_modules | wc -l) packages present in node_modules"
