#!/bin/bash

# Attach the Live Memory-Context monitor to a running tmux session.
#
# The Live Context feature previews retrieved Working + Observational memory for
# the prompt a user has *typed but not yet submitted*. Capture works by reading
# the agent's tmux pane (`tmux capture-pane`), so the CLI MUST be running inside
# tmux. Sessions launched via `coding --copilot|--claude|--opencode` start this
# monitor automatically; use this helper to enable it for a session that is
# already running (e.g. one that predates the feature, or where the monitor was
# disabled).
#
# Usage:
#   scripts/live-context-attach.sh [SESSION] [AGENT]
#   scripts/live-context-attach.sh                 # auto-detect from $TMUX or a single coding-* session
#   scripts/live-context-attach.sh coding-copilot-12345 copilot
#
# Environment:
#   LQM_DASHBOARD_PORT   override dashboard API port (default: .env.ports or 3033)
#
# Stop:
#   The monitor self-exits when its tmux session disappears. To stop it sooner,
#   kill the PID printed below (also stored in .pids/live-query-monitor-<session>.pid).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODING_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

SESSION="${1:-}"
AGENT="${2:-}"

# 1. Resolve the target tmux session.
if [ -z "$SESSION" ]; then
  if [ -n "${TMUX:-}" ]; then
    SESSION="$(tmux display-message -p '#S' 2>/dev/null || true)"
  fi
fi
if [ -z "$SESSION" ]; then
  # Auto-detect a single coding-* session.
  mapfile -t _sessions < <(tmux list-sessions -F '#S' 2>/dev/null | grep -E '^coding-' || true)
  if [ "${#_sessions[@]}" -eq 1 ]; then
    SESSION="${_sessions[0]}"
  elif [ "${#_sessions[@]}" -gt 1 ]; then
    echo "[live-context-attach] Multiple coding tmux sessions found — specify one:" >&2
    printf '  %s\n' "${_sessions[@]}" >&2
    exit 2
  fi
fi
if [ -z "$SESSION" ]; then
  echo "[live-context-attach] No tmux session given and none auto-detected." >&2
  echo "  Run inside a tmux session, or pass one explicitly:" >&2
  echo "    scripts/live-context-attach.sh <session> [agent]" >&2
  echo "  Tip: launch agents via 'coding --copilot' to enable Live Context automatically." >&2
  exit 2
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "[live-context-attach] tmux session '$SESSION' does not exist." >&2
  exit 2
fi

# 2. Infer the agent from the session name (coding-<agent>-<pid>) if not given.
if [ -z "$AGENT" ]; then
  AGENT="$(printf '%s' "$SESSION" | sed -nE 's/^coding-([a-zA-Z0-9]+)-.*/\1/p')"
  [ -z "$AGENT" ] && AGENT="agent"
fi

# 3. Idempotency: skip if a monitor for this session is already running.
mkdir -p "$CODING_REPO/.pids"
PIDFILE="$CODING_REPO/.pids/live-query-monitor-${SESSION}.pid"
if [ -f "$PIDFILE" ]; then
  _old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$_old" ] && kill -0 "$_old" 2>/dev/null; then
    echo "[live-context-attach] Monitor already running for '$SESSION' (PID $_old)."
    exit 0
  fi
fi

# 4. Start the monitor in the background, detached so it survives this helper
#    exiting (it self-exits when the tmux session disappears).
LQM_SESSION="$SESSION" \
  LQM_AGENT="$AGENT" \
  CODING_REPO="$CODING_REPO" \
  nohup node "$CODING_REPO/scripts/live-query-monitor.js" >/dev/null 2>&1 &
MON_PID=$!
disown "$MON_PID" 2>/dev/null || true
echo "$MON_PID" > "$PIDFILE"

echo "[live-context-attach] Live Context monitor started"
echo "  session : $SESSION"
echo "  agent   : $AGENT"
echo "  PID     : $MON_PID  (pidfile: $PIDFILE)"
echo "  Open the dashboard 'Live Context' tab and start typing in '$SESSION'."
