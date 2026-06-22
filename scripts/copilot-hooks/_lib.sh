#!/bin/bash
#
# Shared helper for Copilot CLI native hooks (.github/hooks/copilot-coding.json).
#
# Design goal: NEVER hard-block the CLI. These hooks run the unified hook system
# for logging / observations / constraint monitoring, but any concern is surfaced
# as a WARNING on stderr only. The script always exits 0 and never emits a
# permission "deny" decision, so Copilot CLI is free to execute the tool call.
#
# A non-zero exit (or a missing script) is interpreted by Copilot CLI as a hook
# error and causes the tool call to be DENIED — which is exactly what we avoid here.

# Resolve repo root from this script's location: scripts/copilot-hooks/_lib.sh -> repo
_HOOK_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODING_REPO="${CODING_REPO:-$(dirname "$(dirname "$_HOOK_SCRIPT_DIR")")}"
export CODING_REPO

# Map Copilot-native event name -> unified event name used by the handler.
_map_unified_event() {
  case "$1" in
    "sessionStart")         echo "startup" ;;
    "sessionEnd")           echo "shutdown" ;;
    "preToolUse")           echo "pre-tool" ;;
    "postToolUse")          echo "post-tool" ;;
    "userPromptSubmitted")  echo "pre-prompt" ;;
    "errorOccurred")        echo "error" ;;
    *)                      echo "$1" ;;
  esac
}

# run_hook <nativeEvent>
# Reads native context from stdin, runs the unified handler (best-effort), prints
# any returned messages to stderr as warnings, and ALWAYS allows the operation.
run_hook() {
  local native_event="$1"
  local unified_event
  unified_event="$(_map_unified_event "$native_event")"

  # Read native context from stdin (may be empty).
  local context
  context="$(cat 2>/dev/null || true)"
  [ -z "$context" ] && context='{}'

  local handler="$CODING_REPO/lib/agent-api/hooks/copilot-bridge-handler.js"
  local result='{"allow":true}'

  if [ -f "$handler" ] && command -v node >/dev/null 2>&1; then
    local unified_context
    unified_context=$(cat <<EOF
{
  "event": "$unified_event",
  "agentEvent": "$native_event",
  "agentType": "copilot",
  "sessionId": "${COPILOT_SESSION_ID:-copilot-$$}",
  "timestamp": $(date +%s)000,
  "nativeContext": $context
}
EOF
)
    # Best-effort: never let a handler failure turn into a non-zero exit / block.
    result="$(printf '%s' "$unified_context" | node "$handler" 2>/dev/null || echo '{"allow":true}')"
  fi

  # Surface any handler messages as warnings on stderr (non-blocking).
  if command -v node >/dev/null 2>&1; then
    local messages
    messages="$(printf '%s' "$result" | node -pe 'try{(JSON.parse(require("fs").readFileSync(0,"utf8")).messages||[]).join("\n")}catch(e){""}' 2>/dev/null || true)"
    if [ -n "$messages" ]; then
      printf '⚠️  Warning (%s hook): %s\n' "$native_event" "$messages" >&2
    fi
  fi

  # Always allow. Emit nothing to stdout so Copilot CLI proceeds with the call.
  exit 0
}
