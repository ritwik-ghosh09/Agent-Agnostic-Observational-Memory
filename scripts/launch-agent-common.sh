#!/bin/bash

# Agent-Agnostic Shared Launcher Orchestration
# Extracts all common startup logic from agent-specific launchers.
#
# Usage (from a thin wrapper):
#   source "$SCRIPT_DIR/launch-agent-common.sh"
#   launch_agent "$CODING_REPO/config/agents/<name>.sh" "$@"
#
# Agent config files define:
#   AGENT_NAME            - e.g. "claude", "copilot"
#   AGENT_COMMAND         - binary/script to exec inside tmux
#   AGENT_DISPLAY_NAME    - human-readable name for log messages (default: AGENT_NAME)
#   AGENT_SESSION_PREFIX  - prefix for session ID (default: AGENT_NAME)
#   AGENT_SESSION_VAR     - env var to export session ID as (e.g. CLAUDE_SESSION_ID)
#   AGENT_TRANSCRIPT_FMT  - transcript format (default: AGENT_NAME)
#   AGENT_ENABLE_PIPE_CAPTURE - "true" to enable tmux pipe-pane capture (default: false)
#   AGENT_PROMPT_REGEX    - regex for prompt detection (required if pipe capture enabled)
#
# Agent config files may define hook functions:
#   agent_check_requirements() - verify agent-specific dependencies
#   agent_pre_launch()         - run before launching (start servers, log info, etc.)
#   agent_cleanup()            - called on EXIT (stop agent-specific processes)

set -e

# Resolve the docker command once per session: plain `docker` when the user
# can reach the daemon, otherwise non-interactive sudo (covers users who were
# added to the docker group but have not re-logged-in yet, and root-only daemons).
_docker_bin() {
  if [ -z "${_DOCKER_BIN_CACHE:-}" ]; then
    if timeout 5 docker ps >/dev/null 2>&1; then
      _DOCKER_BIN_CACHE="docker"
    elif command -v sudo >/dev/null 2>&1 && timeout 10 sudo -n docker ps >/dev/null 2>&1; then
      _DOCKER_BIN_CACHE="sudo -n docker"
    else
      _DOCKER_BIN_CACHE="docker"
    fi
    export _DOCKER_BIN_CACHE
  fi
  # No args: print the resolved command. With args: execute it.
  # sudo strips the environment, so CODING_REPO (used by docker-compose.yml
  # volume interpolation) must be re-exported explicitly.
  if [ "$#" -eq 0 ]; then
    echo "$_DOCKER_BIN_CACHE"
  elif [ "$_DOCKER_BIN_CACHE" = "sudo -n docker" ]; then
    sudo -n env CODING_REPO="${CODING_REPO:-$(pwd)}" docker "$@"
  else
    docker "$@"
  fi
}

# ============================================
# Shared Functions
# ============================================

# Log with agent display name prefix
_agent_log() {
  echo "[${AGENT_DISPLAY_NAME:-Agent}] $1"
}

# Wait if a Docker mode transition is in progress
_check_transition_lock() {
  local lock_file="$CODING_REPO/.transition-in-progress"
  local wait_count=0
  local max_wait=60

  while [ -f "$lock_file" ] && [ $wait_count -lt $max_wait ]; do
    if [ $wait_count -eq 0 ]; then
      _agent_log "⏳ Docker mode transition in progress, waiting..."
    fi
    sleep 1
    ((wait_count++))
  done

  if [ -f "$lock_file" ]; then
    _agent_log "⚠️  Transition still in progress after ${max_wait}s, proceeding anyway..."
  elif [ $wait_count -gt 0 ]; then
    _agent_log "✅ Transition complete, continuing startup"
  fi
}

# Docker is the only supported deployment mode. The DOCKER_MODE / CODING_DOCKER_MODE
# variables are kept for backwards-compatibility with downstream scripts and
# log lines that key off them — they're effectively constants now and could
# be folded out in a later cleanup pass.
_detect_docker_mode() {
  DOCKER_MODE=true
  export CODING_DOCKER_MODE=true
}

# Generate unique session ID
_generate_session_id() {
  local prefix="${AGENT_SESSION_PREFIX:-$AGENT_NAME}"
  SESSION_ID="${prefix}-$$-$(date +%s)"
  export SESSION_ID

  # Export agent-specific session var if defined
  if [ -n "$AGENT_SESSION_VAR" ]; then
    export "$AGENT_SESSION_VAR"="$SESSION_ID"
  fi
}

# Register session with Process State Manager
_register_session() {
  _agent_log "Registering session: $SESSION_ID"
  node "$SCRIPT_DIR/psm-register-session.js" "$SESSION_ID" "$$" "$TARGET_PROJECT_DIR" 2>/dev/null || {
    _agent_log "Warning: Failed to register session with Process State Manager"
  }
}

# Cleanup handler for session termination
_cleanup_session() {
  _agent_log "Session ending - cleaning up services..."

  # Call agent-specific cleanup if defined
  if type agent_cleanup &>/dev/null; then
    agent_cleanup
  fi

  # Write session state for cross-agent continuity (D-07, PROF-02)
  node "$SCRIPT_DIR/write-session-state.js" "$AGENT_NAME" "$TARGET_PROJECT_DIR" 2>/dev/null || {
    _agent_log "Warning: Session state write failed"
  }

  node "$SCRIPT_DIR/psm-session-cleanup.js" "$SESSION_ID" 2>/dev/null || {
    _agent_log "Warning: Session cleanup failed"
  }
}

# Mandatory monitoring verification
_verify_monitoring() {
  local target_project="$1"

  _agent_log "🔐 MANDATORY: Verifying monitoring systems before ${AGENT_DISPLAY_NAME} startup..."

  if node "$SCRIPT_DIR/monitoring-verifier.js" --project "$target_project" --strict; then
    _agent_log "✅ MONITORING VERIFIED: All systems operational - ${AGENT_DISPLAY_NAME} startup approved"
    return 0
  else
    _agent_log "❌ MONITORING FAILED: Critical systems not operational"
    _agent_log "🚨 BLOCKING ${AGENT_DISPLAY_NAME} STARTUP - monitoring must be healthy first"
    _agent_log "💡 Run 'node scripts/monitoring-verifier.js --install-all' to fix"
    exit 1
  fi
}

# Resolve target project directory
_resolve_target_project() {
  if [ -n "$CODING_PROJECT_DIR" ]; then
    TARGET_PROJECT_DIR="$CODING_PROJECT_DIR"
    _agent_log "Target project: $TARGET_PROJECT_DIR"
    _agent_log "Coding services from: $CODING_REPO"
  else
    TARGET_PROJECT_DIR="$CODING_REPO"
    _agent_log "Working in coding repository: $TARGET_PROJECT_DIR"
  fi
}

# Load environment configuration files
_load_env_files() {
  if [ -f "$CODING_REPO/.env" ]; then
    set -a
    source "$CODING_REPO/.env"
    set +a
  fi

  if [ -f "$CODING_REPO/.env.ports" ]; then
    set -a
    source "$CODING_REPO/.env.ports"
    set +a
  fi
}

# Check and start Docker — required (Docker is the only supported mode).
_ensure_docker() {
  if ! ensure_docker_running; then
    _agent_log "❌ Docker is required but not running. Start Docker Desktop and retry."
    exit 1
  fi
}

# Ensure the host-side health coordinator (port 3034) is running BEFORE
# monitoring verification (scripts/monitoring-verifier.js STEP 1 + STEP 2).
#
# Platform ownership:
#   - macOS  → launchd job com.coding.health-coordinator (KeepAlive) auto-starts
#              it at login; nothing to do here.
#   - Linux  → systemd *user* service coding-health-coordinator.service. The unit
#              is enabled at install time, but a user service only auto-starts at
#              login when lingering is enabled — otherwise it sits 'inactive' and
#              monitoring-verifier.js fails systemWatchdog + coordinator checks.
#              We start it here so `coding` is self-sufficient.
_ensure_health_coordinator() {
  # Only Linux needs launcher-side intervention; macOS launchd owns this.
  [ "$PLATFORM" = "linux" ] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0

  local unit="coding-health-coordinator.service"
  local coord_url="${HEALTH_COORDINATOR_URL:-http://localhost:3034}"

  # Fast path: already active and responding.
  if systemctl --user is-active "$unit" >/dev/null 2>&1 \
     && curl -sf "$coord_url/health" >/dev/null 2>&1; then
    _agent_log "✅ Health coordinator already active (systemd: $unit)"
    return 0
  fi

  # Unit installed? If not, point at the installer (this matches the systemd
  # unit name that monitoring-verifier.js STEP 1 checks for).
  local unit_file="$HOME/.config/systemd/user/$unit"
  if [ ! -f "$unit_file" ]; then
    _agent_log "⚠️  Health coordinator systemd unit not installed ($unit)."
    _agent_log "   monitoring-verifier.js requires it. Install with:"
    _agent_log "     ./install.sh        # runs setup_health_coordinator"
    return 0
  fi

  _agent_log "🩺 Starting health coordinator (systemd user service: $unit)..."
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user start "$unit" 2>/dev/null || true

  # Wait briefly for the unit to become active and :3034 to respond.
  local i
  for i in $(seq 1 10); do
    if systemctl --user is-active "$unit" >/dev/null 2>&1 \
       && curl -sf "$coord_url/health" >/dev/null 2>&1; then
      _agent_log "✅ Health coordinator active after ${i}s"
      return 0
    fi
    sleep 1
  done

  _agent_log "⚠️  Health coordinator did not become active. Diagnose with:"
  _agent_log "     systemctl --user status $unit"
  _agent_log "     systemctl --user start $unit"
  return 0
}

# Ensure the host-side Observations API server (port 12436) is running.
#
# The dashboard inside the coding-services container forwards /api/observations*
# to this host process (OBS_API_URL=host.docker.internal:12436); the
# .observations DB is its single owner and is NOT bind-mounted into the
# container. Unlike the Docker stack, obs-api is a *host* node process, so
# `coding` must bring it up explicitly — otherwise the dashboard shows
# "Observations API unreachable".
#
# We delegate to scripts/restart-obs-api.mjs, the canonical idempotent
# (re)starter that spawns obs-api detached and registers it with the Process
# State Manager (same startFn as start-services-robust.js). It is a no-op-ish
# fast path when the server is already healthy.
_ensure_obs_api() {
  command -v node >/dev/null 2>&1 || return 0

  local obs_url="${OBS_API_URL:-http://localhost:12436}"
  # Strip any host.docker.internal form down to localhost for host-side probe.
  obs_url="${obs_url/host.docker.internal/localhost}"

  # Fast path: already responding.
  if curl -sf "$obs_url/health" >/dev/null 2>&1; then
    _agent_log "✅ Observations API already running (12436)"
    return 0
  fi

  local helper="$CODING_REPO/scripts/restart-obs-api.mjs"
  if [ ! -f "$helper" ]; then
    _agent_log "⚠️  Observations API not running and restart helper missing ($helper)"
    return 0
  fi

  _agent_log "📚 Starting Observations API server (host process, port 12436)..."
  ( cd "$CODING_REPO" && node "$helper" ) 2>&1 | sed 's/^/   /' || true

  # Confirm it came up.
  local i
  for i in $(seq 1 10); do
    if curl -sf "$obs_url/health" >/dev/null 2>&1; then
      _agent_log "✅ Observations API healthy after ${i}s"
      return 0
    fi
    sleep 1
  done

  _agent_log "⚠️  Observations API did not become healthy. Diagnose with:"
  _agent_log "     tail -n 50 $CODING_REPO/.data/observations-api.log"
  _agent_log "     node $helper"
  return 0
}

# Ensure the host-side LLM CLI Proxy (port 12435) is running.
#
# This HTTP bridge (src/llm-proxy/llm-proxy.mjs → @rapid/llm-proxy) routes
# observation-summarization LLM calls through subscription providers
# (Copilot/Claude). The obs-api server (host) and the in-container ETM reach it
# at localhost:12435 / host.docker.internal:12435. When it is DOWN, observations
# are still written but as low-quality "[Raw] … LLM summary unavailable" rows
# (llmModel=null) and the digest/insight pipeline has nothing to consolidate —
# i.e. new chat history appears in the dashboard only as raw, unsummarized text.
#
# Like obs-api and the health coordinator, it is a *host* process, so `coding`
# must bring it up explicitly. We spawn the canonical wrapper detached (mirroring
# SERVICE_CONFIGS.llmCliProxy.startFn in start-services-robust.js).
_ensure_llm_cli_proxy() {
  command -v node >/dev/null 2>&1 || return 0

  local port="${LLM_CLI_PROXY_PORT:-12435}"
  local url="http://localhost:${port}"

  # Fast path: already responding.
  if curl -sf "$url/health" >/dev/null 2>&1; then
    _agent_log "✅ LLM CLI Proxy already running (${port})"
    return 0
  fi

  local entry="$CODING_REPO/src/llm-proxy/llm-proxy.mjs"
  if [ ! -f "$entry" ]; then
    _agent_log "⚠️  LLM CLI Proxy entry missing ($entry) — observation summaries will be raw"
    return 0
  fi
  if [ ! -d "$CODING_REPO/node_modules/@rapid/llm-proxy" ]; then
    _agent_log "⚠️  @rapid/llm-proxy not installed — run: npm install (summaries will be raw)"
    return 0
  fi

  _agent_log "🔌 Starting LLM CLI Proxy (host process, port ${port})..."
  mkdir -p "$CODING_REPO/.data" 2>/dev/null || true
  ( cd "$CODING_REPO" && LLM_PROXY_PORT="$port" nohup node "$entry" \
      >> "$CODING_REPO/.data/llm-cli-proxy.log" 2>&1 & ) || true

  # Confirm it came up.
  local i
  for i in $(seq 1 10); do
    if curl -sf "$url/health" >/dev/null 2>&1; then
      _agent_log "✅ LLM CLI Proxy healthy after ${i}s"
      return 0
    fi
    sleep 1
  done

  _agent_log "⚠️  LLM CLI Proxy did not become healthy (observation summaries will be raw). Diagnose with:"
  _agent_log "     tail -n 50 $CODING_REPO/.data/llm-cli-proxy.log"
  _agent_log "     LLM_PROXY_PORT=$port node $entry"
  return 0
}

# Check if coding-services container has unbound ports (running but ports not mapped to host).
# Returns 0 if ports are broken, 1 if OK or container not running.
_container_has_unbound_ports() {
  local state
  state=$(_docker_bin inspect coding-services --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  [ "$state" != "running" ] && return 1

  local port_bindings
  port_bindings=$(_docker_bin inspect coding-services --format '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{if $conf}}{{(index $conf 0).HostPort}}{{else}}UNBOUND{{end}} {{end}}' 2>/dev/null || true)

  echo "$port_bindings" | grep -q "UNBOUND"
}

# Force-recreate coding-services after resolving port conflicts.
# Returns 0 on successful recovery, 1 on failure.
_recover_stale_container() {
  local docker_dir="$1"
  local max_wait="${2:-20}"

  _agent_log "⚠️  Container has unbound ports — resolving conflicts and recreating..."
  _resolve_port_conflicts "$docker_dir/docker-compose.yml"

  $(_docker_bin) compose -f "$docker_dir/docker-compose.yml" up -d --force-recreate coding-services 2>/dev/null

  for j in $(seq 1 "$max_wait"); do
    if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
      _agent_log "✅ Recovered after port conflict resolution (${j}s)"
      return 0
    fi
    sleep 1
  done

  _agent_log "❌ Recovery failed after ${max_wait}s"
  return 1
}

# Diagnose why coding-services failed to become healthy.
# Attempts recovery and returns 0 on success, 1 on failure.
_diagnose_unhealthy_services() {
  local docker_dir="$1"

  local state
  state=$(_docker_bin inspect coding-services --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  _agent_log "   Container state: $state"

  if [ "$state" = "running" ] && _container_has_unbound_ports; then
    _recover_stale_container "$docker_dir" 20 && return 0
  fi

  # Show recent logs for debugging
  _agent_log "   Recent logs:"
  $(_docker_bin) compose -f "$docker_dir/docker-compose.yml" logs --tail 10 coding-services 2>/dev/null | sed 's/^/   /'
  _agent_log "   Full logs: docker compose -f $docker_dir/docker-compose.yml logs coding-services"
  return 1
}

# Resolve port conflicts before starting Docker services.
# Extracts published host ports from docker-compose.yml and kills any
# non-Docker process occupying them.
_resolve_port_conflicts() {
  local compose_file="$1"
  local conflicts_found=false

  # Extract host ports from docker-compose port mappings (format: "HOST:CONTAINER")
  local host_ports
  host_ports=$(grep -oE '^\s+- "([0-9]+):' "$compose_file" | grep -oE '[0-9]+' || true)

  if [ -z "$host_ports" ]; then
    return 0
  fi

  for port in $host_ports; do
    # Find PID listening on this port (exclude docker-proxy which is expected)
    local pid
    pid=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)

    if [ -z "$pid" ]; then
      continue
    fi

    # Check if this is a Docker process (com.docker or docker-proxy) — leave those alone
    local proc_name
    proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || true)
    if [[ "$proc_name" == *docker* ]] || [[ "$proc_name" == *com.docker* ]]; then
      continue
    fi

    local proc_cmd
    proc_cmd=$(ps -p "$pid" -o args= 2>/dev/null | head -c 120 || true)
    _agent_log "⚠️  Port $port blocked by PID $pid: $proc_cmd"

    kill "$pid" 2>/dev/null && {
      _agent_log "   Killed PID $pid to free port $port"
      conflicts_found=true
    } || {
      _agent_log "   Failed to kill PID $pid — try: sudo kill $pid"
    }
  done

  if [ "$conflicts_found" = true ]; then
    # Brief pause for ports to be released by the kernel
    sleep 1
  fi
}

# Clear leaked docker-proxy processes (Linux only).
#
# On Linux, Docker spawns a userland `docker-proxy` process per published host
# port. When a `docker compose up`/build is interrupted (Ctrl-C, crash, OOM)
# these can be orphaned: the container is gone but the proxy keeps the host
# port bound. They survive `docker compose down` and make the next start fail
# with "ports are not available ... address already in use".
#
# On macOS docker-proxy runs inside the Docker VM (never a host process), so
# _resolve_port_conflicts deliberately skips all docker-* procs there. This
# function is the Linux-specific counterpart and is a no-op on macOS.
#
# A proxy is treated as "leaked" only if its published host-port is NOT
# currently published by any *running* container — i.e. it points at a
# container that no longer exists. Proxies backing live containers are left
# untouched.
_clear_leaked_docker_proxies() {
  [ "$PLATFORM" = "linux" ] || return 0
  command -v docker >/dev/null 2>&1 || return 0

  # Map of "PID host-port" for every docker-proxy process on the host.
  local proxies
  proxies=$(ps -eo pid=,cmd= 2>/dev/null \
    | awk '/[d]ocker-proxy/ { for (i=1;i<=NF;i++) if ($i=="-host-port") print $1, $(i+1) }')
  [ -z "$proxies" ] && return 0

  # Host ports currently published by running containers (e.g. "0.0.0.0:3100->3000/tcp").
  local live_ports
  live_ports=$(_docker_bin ps --format '{{.Ports}}' 2>/dev/null \
    | grep -oE ':[0-9]+->' | grep -oE '[0-9]+' | sort -u || true)

  local leaked_pids=""
  while read -r pid hostport; do
    [ -z "$pid" ] && continue
    # Skip proxies that belong to a running container.
    if [ -n "$live_ports" ] && echo "$live_ports" | grep -qx "$hostport"; then
      continue
    fi
    _agent_log "🧟 Leaked docker-proxy on host port $hostport (PID $pid) — no live container"
    leaked_pids="$leaked_pids $pid"
  done <<< "$proxies"

  [ -z "$leaked_pids" ] && return 0

  # Try our own kill first, then passwordless sudo. Never prompt interactively
  # from the launcher — surface clear remediation instead.
  # shellcheck disable=SC2086
  kill $leaked_pids 2>/dev/null || true
  sleep 1

  local still
  still=$(ps -eo pid=,cmd= 2>/dev/null \
    | awk '/[d]ocker-proxy/ { for (i=1;i<=NF;i++) if ($i=="-host-port") print $1 }')
  # Re-filter to only those we wanted gone that are still alive.
  local stuck=""
  for pid in $leaked_pids; do
    if echo "$still" | grep -qx "$pid"; then
      stuck="$stuck $pid"
    fi
  done

  if [ -n "$stuck" ]; then
    if sudo -n true 2>/dev/null; then
      _agent_log "🔐 Clearing root-owned leaked proxies via passwordless sudo..."
      # shellcheck disable=SC2086
      sudo -n kill $stuck 2>/dev/null || true
      sleep 1
      local recheck=""
      local after
      after=$(ps -eo pid= 2>/dev/null)
      for pid in $stuck; do
        echo "$after" | grep -qx "$pid" && recheck="$recheck $pid"
      done
      stuck="$recheck"
    fi
  fi

  if [ -n "$stuck" ]; then
    _agent_log "⚠️  Leaked docker-proxy still running (root-owned):$stuck"
    _agent_log "   These hold host ports and need privileges to clear. Run ONE of:"
    _agent_log "     sudo kill$stuck"
    _agent_log "     sudo systemctl restart docker   # clears all leaked proxies"
  else
    _agent_log "✅ Cleared leaked docker-proxy process(es)"
  fi
}

# Configure the proxy that the Docker *build* uses (apt-get, curl, etc.).
#
# Docker auto-injects http(s)_proxy build-args from ~/.docker/config.json. On a
# corporate laptop that points at a host-only proxy (e.g. 127.0.0.1 rewritten to
# the bridge gateway) which is unreachable from inside the build container when
# off-VPN — breaking `apt-get update`. We drive the build proxy from the same
# corporate-VPN detection the rest of the launcher uses (INSIDE_CN):
#   - On VPN  (INSIDE_CN=true):  pass the detected proxy through to the build.
#   - Off VPN (INSIDE_CN=false): force the build-args empty so the build goes
#     direct, overriding whatever ~/.docker/config.json would have injected.
# The vars are consumed by docker/docker-compose.yml build.args.
_configure_docker_build_proxy() {
  if [ "$INSIDE_CN" = "true" ]; then
    # On VPN: reuse whatever proxy the environment/config provides. Prefer an
    # explicit override, then the standard env vars.
    local proxy="${CODING_DOCKER_BUILD_PROXY:-${HTTP_PROXY:-${http_proxy:-}}}"
    export DOCKER_BUILD_HTTP_PROXY="$proxy"
    export DOCKER_BUILD_HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-$proxy}}"
    export DOCKER_BUILD_NO_PROXY="${NO_PROXY:-${no_proxy:-localhost,127.0.0.1,::1}}"
    _agent_log "🐳 Docker build proxy: ON (inside CN) → ${DOCKER_BUILD_HTTP_PROXY:-<none>}"
  else
    # Off VPN: empty build-args override any proxy from ~/.docker/config.json,
    # so the build reaches Debian/npm mirrors directly.
    export DOCKER_BUILD_HTTP_PROXY=""
    export DOCKER_BUILD_HTTPS_PROXY=""
    export DOCKER_BUILD_NO_PROXY="localhost,127.0.0.1,::1"
    _agent_log "🐳 Docker build proxy: OFF (outside CN) → direct"
  fi
}

# Start coding services (Docker or Native mode)
_start_services() {
  if ! command -v node &> /dev/null; then
    _agent_log "Error: Node.js is required but not found in PATH"
    exit 1
  fi

  # Drive Docker build proxy from corporate-VPN detection before any build.
  _configure_docker_build_proxy

  local docker_dir="$CODING_REPO/docker"
  if [ ! -f "$docker_dir/docker-compose.yml" ]; then
    _agent_log "Error: Docker compose file not found at $docker_dir/docker-compose.yml"
    exit 1
  fi

  # Fast path: already healthy and ports are bound
  # (skip this shortcut after --force, since we just tore everything down)
  if [ "$CODING_FORCE_CLEAN" != "true" ] && curl -sf http://localhost:8080/health >/dev/null 2>&1; then
    _agent_log "✅ coding-services already running and healthy - reusing existing containers"
  else
    # Linux: clear any leaked docker-proxy processes (orphaned from a previous
    # interrupted/crashed run) that still hold host ports. These survive
    # `docker compose down` and otherwise make `up` fail with
    # "ports are not available ... address already in use". No-op on macOS.
    _clear_leaked_docker_proxies

    # Detect stale container (running but ports not bound to host) — common after
    # Docker Desktop crashes or port conflicts. Fix it immediately instead of
    # waiting 60s to fail.
    if _container_has_unbound_ports; then
      _resolve_port_conflicts "$docker_dir/docker-compose.yml"
      _agent_log "🐳 Recreating coding-services (stale port bindings)..."
      export CODING_REPO
      $(_docker_bin) compose -f "$docker_dir/docker-compose.yml" up -d --force-recreate coding-services
    else
      _resolve_port_conflicts "$docker_dir/docker-compose.yml"
      _agent_log "🐳 Starting coding services via Docker..."
      export CODING_REPO
      local up_log
      if ! up_log=$(_docker_bin compose -f "$docker_dir/docker-compose.yml" up -d 2>&1); then
        echo "$up_log" | sed 's/^/   /'
        # A leaked docker-proxy or stray host listener is the usual cause of a
        # port-bind failure on Linux. Clear orphans + conflicts and retry once.
        if echo "$up_log" | grep -qiE 'address already in use|ports are not available'; then
          _agent_log "⚠️  Port bind conflict — clearing leaked proxies/host listeners and retrying..."
          _clear_leaked_docker_proxies
          _resolve_port_conflicts "$docker_dir/docker-compose.yml"
          $(_docker_bin) compose -f "$docker_dir/docker-compose.yml" down --remove-orphans 2>/dev/null || true
          if ! $(_docker_bin) compose -f "$docker_dir/docker-compose.yml" up -d; then
            _agent_log "Error: Failed to start Docker containers after conflict recovery"
            _agent_log "   A root-owned leaked proxy may still hold a port. Try:"
            _agent_log "     sudo systemctl restart docker   # then re-run 'coding'"
            exit 1
          fi
        else
          _agent_log "Error: Failed to start Docker containers"
          exit 1
        fi
      fi
    fi

    _agent_log "⏳ Waiting for coding-services to be healthy..."
    local max_wait=30
    for i in $(seq 1 $max_wait); do
      if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
        _agent_log "✅ coding-services healthy after ${i}s"
        break
      fi
      if [ "$i" -eq "$max_wait" ]; then
        _agent_log "❌ coding-services health check failed after ${max_wait}s"
        if _diagnose_unhealthy_services "$docker_dir"; then
          break  # recovery succeeded
        fi
        exit 1
      fi
      sleep 1
    done
  fi

  # Generate Docker MCP config if it doesn't exist or is outdated
  if [ ! -f "$CODING_REPO/claude-code-mcp-docker.json" ] || \
     [ "$CODING_REPO/docker/docker-compose.yml" -nt "$CODING_REPO/claude-code-mcp-docker.json" ]; then
    _agent_log "Generating Docker MCP configuration..."
    "$SCRIPT_DIR/generate-docker-mcp-config.sh" || _agent_log "Warning: Could not generate Docker MCP config"
  fi

  # Brief wait for services to stabilize
  sleep 2
}

# Set standard agent environment variables
_set_agent_env_vars() {
  export CODING_AGENT="$AGENT_NAME"
  export CODING_TOOLS_PATH="$CODING_REPO"
  export TRANSCRIPT_SOURCE_PROJECT="$TARGET_PROJECT_DIR"
  export CODING_AGENT_ADAPTER_PATH="$CODING_REPO/lib/agent-api/adapters"
  export CODING_HOOKS_CONFIG="$CODING_REPO/config/hooks-config.json"
  export CODING_TRANSCRIPT_FORMAT="${AGENT_TRANSCRIPT_FMT:-$AGENT_NAME}"
}

# Inject knowledge context for non-Claude agents (D-06)
# Claude uses a per-prompt UserPromptSubmit hook (registered globally).
# Other agents get a session-start context file written before launch.
_inject_knowledge_context() {
  local agent="$AGENT_NAME"
  local hooks_dir="$CODING_REPO/src/hooks"

  # Claude uses per-prompt hook (registered in ~/.claude/settings.json) -- skip here
  if [ "$agent" = "claude" ]; then
    return 0
  fi

  local adapter="$hooks_dir/knowledge-injection-${agent}.js"
  if [ ! -f "$adapter" ]; then
    _agent_log "No knowledge injection adapter for ${agent} -- skipping"
    return 0
  fi

  _agent_log "Injecting knowledge context for ${AGENT_DISPLAY_NAME}..."

  # Export target project dir for the adapter to use
  export TARGET_PROJECT_DIR="${TARGET_PROJECT_DIR}"
  export CODING_PROJECT_DIR="${TARGET_PROJECT_DIR}"

  # Run adapter with timeout (fail-open -- never block agent startup)
  if timeout 10 node "$adapter" 2>/dev/null; then
    _agent_log "Knowledge context injected for ${AGENT_DISPLAY_NAME}"
  else
    _agent_log "Knowledge injection skipped (service unavailable or timeout)"
  fi
}

# ============================================
# Main Entry Point
# ============================================

launch_agent() {
  local agent_config="$1"
  shift

  # Validate agent config exists
  if [ ! -f "$agent_config" ]; then
    echo "Error: Agent config not found: $agent_config" >&2
    exit 1
  fi

  # Source agent config — sets AGENT_NAME, AGENT_COMMAND, hooks, etc.
  source "$agent_config"

  # Validate required config
  if [ -z "$AGENT_NAME" ]; then
    echo "Error: Agent config must define AGENT_NAME" >&2
    exit 1
  fi
  if [ -z "$AGENT_COMMAND" ]; then
    echo "Error: Agent config must define AGENT_COMMAND" >&2
    exit 1
  fi

  # Set defaults
  AGENT_DISPLAY_NAME="${AGENT_DISPLAY_NAME:-$AGENT_NAME}"
  AGENT_SESSION_PREFIX="${AGENT_SESSION_PREFIX:-$AGENT_NAME}"
  AGENT_ENABLE_PIPE_CAPTURE="${AGENT_ENABLE_PIPE_CAPTURE:-false}"

  # Override the log function so agent-common-setup.sh messages also use our prefix
  log() {
    _agent_log "$1"
  }

  # --- Orchestration Pipeline ---

  # 1. Transition lock
  _check_transition_lock

  # 2. Docker detection
  _detect_docker_mode

  # 3. Source Docker helpers
  source "$SCRIPT_DIR/ensure-docker.sh"
  detect_platform

  # 4. Resolve target project (needed for dry-run output and session registration)
  _resolve_target_project

  # 5. Load env files (before dry-run so env is available)
  _load_env_files

  # 6. Network detection (needed early for dry-run output and agent config)
  _agent_log "Detecting network environment..."
  detect_network_and_configure_proxy

  # 7. Dry-run exit
  if [ "$CODING_DRY_RUN" = "true" ]; then
    _agent_log "DRY-RUN: All startup logic completed successfully"
    _agent_log "DRY-RUN: Would launch in tmux: $AGENT_COMMAND"
    _agent_log "DRY-RUN: Agent=$AGENT_NAME, Docker=$DOCKER_MODE, Platform=$PLATFORM"
    _agent_log "DRY-RUN: Project=$TARGET_PROJECT_DIR"
    _agent_log "DRY-RUN: Network: CN=$INSIDE_CN, Proxy=$PROXY_WORKING, Required=$PROXY_REQUIRED"
    # Run agent pre-launch to show model selection
    if type agent_pre_launch &>/dev/null; then
      agent_pre_launch
    fi
    exit 0
  fi

  # 7. Early Docker launch (parallel with setup)
  early_docker_launch

  # 8. Session ID + register
  _generate_session_id
  _register_session

  # 9. Cleanup trap
  trap _cleanup_session EXIT INT TERM

  # 10. Ensure Docker running
  _ensure_docker

  # 11. Start services
  _start_services

  # 11.5. Ensure host-side health coordinator is up (Linux systemd / macOS launchd)
  #       BEFORE monitoring verification, which requires it (STEP 1 + STEP 2).
  _ensure_health_coordinator

  # 11.55. Ensure the host-side LLM CLI Proxy (12435) is up BEFORE obs-api so
  #        observation summaries are generated (not saved as raw [Raw] rows).
  _ensure_llm_cli_proxy

  # 11.6. Ensure host-side Observations API (port 12436) is up so the dashboard's
  #       /api/observations* forwards resolve (it's a host process, not in Docker).
  _ensure_obs_api

  # 12. Verify monitoring
  _verify_monitoring "$TARGET_PROJECT_DIR"

  # 12.5. Inject knowledge context (session-start adapters)
  _inject_knowledge_context

  # 13. Agent-specific requirements check (with auto-install)
  if type agent_check_requirements &>/dev/null; then
    if ! agent_check_requirements; then
      if [ -n "$AGENT_INSTALL_COMMAND" ]; then
        _agent_log ""
        _agent_log "Would you like to install it now?"
        _agent_log "  Command: $AGENT_INSTALL_COMMAND"
        _agent_log ""
        printf "[%s] Install now? [Y/n] " "$AGENT_DISPLAY_NAME"
        read -r response
        if [ -z "$response" ] || [[ "$response" =~ ^[Yy] ]]; then
          _agent_log "📦 Installing: $AGENT_INSTALL_COMMAND"
          if eval "$AGENT_INSTALL_COMMAND"; then
            _agent_log "✅ Installed successfully, retrying requirements check..."
            if ! agent_check_requirements; then
              _agent_log "❌ Requirements still not met after install"
              exit 1
            fi
          else
            _agent_log "❌ Install failed. Run manually: $AGENT_INSTALL_COMMAND"
            exit 1
          fi
        else
          _agent_log "Skipped. Install manually: $AGENT_INSTALL_COMMAND"
          exit 1
        fi
      else
        exit 1
      fi
    fi
  fi

  # 15. Set env vars (must precede agent_pre_launch: the pre-launch hook may
  #     spawn helper servers — e.g. the CoPilot HTTP adapter — that resolve
  #     CODING_TOOLS_PATH at startup. Exporting here ensures those children
  #     inherit the correct repo path instead of falling back to ~/Agentic/coding.)
  _set_agent_env_vars

  # 16. Agent-specific pre-launch hook (can use INSIDE_CN, PROXY_WORKING)
  if type agent_pre_launch &>/dev/null; then
    agent_pre_launch
  fi

  # 17. Agent-common init (LSL, monitoring, gitignore, etc.)
  agent_common_init "$TARGET_PROJECT_DIR" "$CODING_REPO"

  # 18. Log mode info
  _agent_log "MCP servers run via stdio-proxy → SSE connections to Docker"

  # 19. cd to project
  cd "$TARGET_PROJECT_DIR"
  _agent_log "Changed working directory to: $(pwd)"

  # 20. Launch via tmux session wrapper
  _agent_log "Launching ${AGENT_DISPLAY_NAME}..."
  source "$SCRIPT_DIR/tmux-session-wrapper.sh"
  tmux_session_wrapper "$AGENT_COMMAND" "$@"
}
