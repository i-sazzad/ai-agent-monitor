#!/usr/bin/env bash
# setup-terminal-hook.sh
# Installs shell functions that auto-capture sessions after every claude / opencode
# command, even when VS Code is not running.
#
# Usage:
#   INGEST_URL=http://192.168.x.x:4319  \
#   INGEST_TOKEN=<your-ingest-token>     \
#   CLAUDE_ACCOUNT_EMAIL=you@company.com \
#   bash setup-terminal-hook.sh
#
# Then restart your shell or: source ~/.bashrc  (or ~/.zshrc)

set -euo pipefail

MONITOR_DIR="$(cd "$(dirname "$0")" && pwd)"
INGEST_URL="${INGEST_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
CLAUDE_ACCOUNT_EMAIL="${CLAUDE_ACCOUNT_EMAIL:-}"

if [[ -z "$INGEST_URL" || -z "$INGEST_TOKEN" ]]; then
  echo "Error: INGEST_URL and INGEST_TOKEN must be set." >&2
  echo "Example:" >&2
  echo "  INGEST_URL=http://192.168.1.10:4319 INGEST_TOKEN=xxx bash setup-terminal-hook.sh" >&2
  exit 1
fi

# Detect shell config file
SHELL_RC=""
if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == */zsh ]]; then
  SHELL_RC="$HOME/.zshrc"
else
  SHELL_RC="$HOME/.bashrc"
fi

MARKER="# agent-monitor hook"

# Remove old block if present
if grep -q "$MARKER" "$SHELL_RC" 2>/dev/null; then
  sed -i "/$MARKER/,/$MARKER END/d" "$SHELL_RC"
fi

EMAIL_LINE=""
if [[ -n "$CLAUDE_ACCOUNT_EMAIL" ]]; then
  EMAIL_LINE="  export CLAUDE_ACCOUNT_EMAIL=\"$CLAUDE_ACCOUNT_EMAIL\""
fi

cat >> "$SHELL_RC" <<EOF

$MARKER
export INGEST_URL="$INGEST_URL"
export INGEST_TOKEN="$INGEST_TOKEN"
$EMAIL_LINE

_agent_capture() {
  (cd "$MONITOR_DIR" && npm run capture --silent 2>/dev/null &)
}

claude() {
  command claude "\$@"
  _agent_capture
}

opencode() {
  command opencode "\$@"
  _agent_capture
}
$MARKER END
EOF

echo "Hook installed in $SHELL_RC"
echo "Run: source $SHELL_RC"
echo ""
echo "After that, every 'claude' or 'opencode' command will auto-report to the monitor."
