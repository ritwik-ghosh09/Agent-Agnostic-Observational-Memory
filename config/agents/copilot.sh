#!/bin/bash
# Agent definition: GitHub CoPilot
# Sourced by launch-agent-common.sh

AGENT_NAME="copilot"
AGENT_DISPLAY_NAME="CoPilot"
AGENT_COMMAND="copilot"
AGENT_SESSION_PREFIX="copilot"
AGENT_SESSION_VAR="COPILOT_SESSION_ID"
AGENT_TRANSCRIPT_FMT="copilot"
AGENT_ENABLE_PIPE_CAPTURE=true
AGENT_PROMPT_REGEX='❯\s+([^\n\r]+)[\n\r]'
# Live Memory Context preview: capture the prompt being typed (pre-submission)
# from the tmux pane and show retrieved memory in the dashboard "Live Context" tab.
AGENT_ENABLE_LIVE_CONTEXT=true
AGENT_REQUIRES_COMMANDS="copilot"
# No AGENT_INSTALL_COMMAND — copilot install is org-specific

# Track HTTP adapter PID for cleanup
HTTP_SERVER_PID=""
# Track received-context logger daemon PID for cleanup
RECV_CTX_LOGGER_PID=""

# Verify copilot CLI and tmux are available
agent_check_requirements() {
  _agent_log "Checking CoPilot requirements..."

  if ! command -v copilot &>/dev/null; then
    _agent_log "Error: copilot CLI is not installed or not in PATH"
    _agent_log "Ensure the 'copilot' command is available"
    return 1
  fi

  if ! command -v tmux &>/dev/null; then
    _agent_log "Error: tmux is not installed (required for session wrapper)"
    _agent_log "Install: brew install tmux"
    return 1
  fi

  _agent_log "✅ copilot CLI and tmux detected"
}

# Start CoPilot HTTP adapter server and set log dir
agent_pre_launch() {
  # Set copi log directory
  export COPI_LOG_DIR="$CODING_REPO/.logs/copi"
  mkdir -p "$COPI_LOG_DIR"

  _agent_log "Starting CoPilot HTTP adapter server..."

  if [ ! -f "$CODING_REPO/lib/adapters/copilot-http-server.js" ]; then
    _agent_log "Warning: CoPilot HTTP adapter not found, some features may not work"
    return 0
  fi

  cd "$CODING_REPO"
  nohup node lib/adapters/copilot-http-server.js > .logs/copilot-http-adapter.log 2>&1 &
  HTTP_SERVER_PID=$!

  sleep 2
  if kill -0 "$HTTP_SERVER_PID" 2>/dev/null; then
    _agent_log "✅ HTTP adapter server started (PID: $HTTP_SERVER_PID)"
    export COPILOT_HTTP_ADAPTER_PID="$HTTP_SERVER_PID"
  else
    _agent_log "⚠️ HTTP adapter server may have failed to start"
    HTTP_SERVER_PID=""
  fi

  # Validate GitHub API connectivity
  validate_agent_connectivity "$AGENT_NAME" || true

  # --- Auto-capture what the LLM actually receives (zero manual intervention) ---
  # Enable Copilot CLI OpenTelemetry content capture and start the
  # received-context logger daemon so every prompt submission is aggregated into
  # a tier-segregated JSONL log automatically. No env exports or hooks needed by
  # the user — this is wired into the Copilot launch path.
  if command -v node &>/dev/null && [ -f "$CODING_REPO/scripts/received-context-logger.mjs" ]; then
    export COPILOT_OTEL_FILE_EXPORTER_PATH="${COPILOT_OTEL_FILE_EXPORTER_PATH:-$CODING_REPO/.data/otel/copilot-otel.jsonl}"
    export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="${OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT:-true}"
    export RECEIVED_CONTEXT_LOG_DIR="${RECEIVED_CONTEXT_LOG_DIR:-$CODING_REPO/.data/received-context-log}"
    mkdir -p "$(dirname "$COPILOT_OTEL_FILE_EXPORTER_PATH")" "$RECEIVED_CONTEXT_LOG_DIR"

    # Idempotent: don't spawn a second watcher if one is already tailing this file.
    if ! pgrep -f "received-context-logger.mjs --watch" >/dev/null 2>&1; then
      cd "$CODING_REPO"
      nohup node scripts/received-context-logger.mjs --watch \
        --otel "$COPILOT_OTEL_FILE_EXPORTER_PATH" \
        --log-dir "$RECEIVED_CONTEXT_LOG_DIR" \
        > "$RECEIVED_CONTEXT_LOG_DIR/watcher.log" 2>&1 &
      RECV_CTX_LOGGER_PID=$!
      export RECEIVED_CONTEXT_LOGGER_PID="$RECV_CTX_LOGGER_PID"
      _agent_log "✅ Received-context logger watching (PID: $RECV_CTX_LOGGER_PID) → $RECEIVED_CONTEXT_LOG_DIR"
    else
      _agent_log "ℹ️  Received-context logger already running"
    fi
  fi

  _agent_log "📚 CoPilot features available:"
  _agent_log "   • Copilot CLI in tmux session with I/O capture"
  _agent_log "   • Session logging (JSON Lines format)"
  _agent_log "   • Memory/Knowledge management (fallback services)"
  _agent_log "   • Browser automation (Playwright fallback)"
  _agent_log "   • LSL system integration"
}

# Stop CoPilot-specific services on exit
agent_cleanup() {
  if [ -n "$HTTP_SERVER_PID" ] && kill -0 "$HTTP_SERVER_PID" 2>/dev/null; then
    _agent_log "Stopping HTTP adapter server (PID: $HTTP_SERVER_PID)"
    kill "$HTTP_SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$RECV_CTX_LOGGER_PID" ] && kill -0 "$RECV_CTX_LOGGER_PID" 2>/dev/null; then
    # Final one-shot flush so the last turn's span is logged before we stop.
    if command -v node &>/dev/null && [ -f "$CODING_REPO/scripts/received-context-logger.mjs" ]; then
      (cd "$CODING_REPO" && node scripts/received-context-logger.mjs \
        --otel "$COPILOT_OTEL_FILE_EXPORTER_PATH" \
        --log-dir "$RECEIVED_CONTEXT_LOG_DIR" >/dev/null 2>&1) || true
    fi
    _agent_log "Stopping received-context logger (PID: $RECV_CTX_LOGGER_PID)"
    kill "$RECV_CTX_LOGGER_PID" 2>/dev/null || true
  fi
}
