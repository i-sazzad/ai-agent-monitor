#!/usr/bin/env bash
# Agent Monitor — Linux/macOS launcher
# Run manually or add to cron:
#   crontab -e
#   */15 * * * * bash /path/to/start.sh >> /tmp/agent-monitor.log 2>&1
cd "$(dirname "$0")"
node agent.js
