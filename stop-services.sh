#!/bin/bash

# Stop coding services script
# Graceful shutdown of all live logging and service processes

set -e

echo "🛑 Stopping Coding Services..."

# Resolve repo root (this script lives at the repo root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODING_REPO="$SCRIPT_DIR"

# All host ports owned by the coding stack (Docker-published + native services).
# Docker-published: 8080 3848 3849 3850 3030 3031 3032 3033 (coding-services),
#   6333 6334 (qdrant), 6379 (redis), 7687 3100 (memgraph).
# Native host services: 3847 9090 12435 (LLM CLI proxy, etc.).
CODING_PORTS="3030 3031 3032 3033 3100 3847 3848 3849 3850 6333 6334 6379 7687 8001 8080 9090 12435"

# Function to gracefully stop a process
stop_process() {
    local pid=$1
    local name=$2
    local timeout=${3:-10}
    
    if [ -n "$pid" ] && [ "$pid" != "stdio" ] && ps -p "$pid" > /dev/null 2>&1; then
        echo "🔴 Stopping $name (PID: $pid)..."
        
        # Send SIGTERM first
        kill -TERM "$pid" 2>/dev/null || true
        
        # Wait for graceful shutdown
        for i in $(seq 1 $timeout); do
            if ! ps -p "$pid" > /dev/null 2>&1; then
                echo "✅ $name stopped gracefully"
                return 0
            fi
            sleep 1
        done
        
        # Force kill if still running
        echo "⚠️ $name not responding, force killing..."
        kill -KILL "$pid" 2>/dev/null || true
        echo "✅ $name force stopped"
    else
        echo "ℹ️ $name not running"
    fi
}

# Gracefully tear down the Docker compose stack (containers, network, orphans).
# This stops coding-services + qdrant/redis/memgraph and removes the docker-proxy
# processes Docker spawns for each published port. Leaving the stack up is the
# usual cause of "address already in use" on the next start.
stop_docker_stack() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "ℹ️ Docker not installed - skipping container shutdown"
        return 0
    fi
    if ! timeout 5 docker info >/dev/null 2>&1; then
        echo "ℹ️ Docker daemon not responding - skipping container shutdown"
        return 0
    fi

    local compose_file="$CODING_REPO/docker/docker-compose.yml"
    if [ -f "$compose_file" ]; then
        echo "🐳 Stopping Docker coding stack (containers + orphans)..."
        CODING_REPO="$CODING_REPO" docker compose -f "$compose_file" down --remove-orphans 2>/dev/null \
            && echo "✅ Docker compose stack stopped" \
            || echo "⚠️ docker compose down reported an issue (continuing)"
    else
        echo "ℹ️ No docker-compose.yml found at $compose_file"
    fi

    # Belt-and-braces: remove any lingering coding containers by name even if they
    # weren't tied to the current compose project (e.g. after a project rename).
    local names
    names=$(docker ps -aq --filter 'name=coding-' 2>/dev/null || true)
    if [ -n "$names" ]; then
        echo "🧹 Removing stray coding-* containers..."
        echo "$names" | xargs docker rm -f 2>/dev/null || true
    fi
}

# Clean up leaked docker-proxy processes that survive a crashed/interrupted run.
# These are root-owned children of dockerd that keep host ports bound even after
# the container is gone, and they are NOT released by `docker compose down`.
# We can only kill them with sufficient privileges; otherwise we surface clear
# remediation instructions.
clean_leaked_docker_proxies() {
    local leaked
    # Match docker-proxy procs whose published host-port is one of ours.
    leaked=$(ps -eo pid,cmd 2>/dev/null \
        | grep '[d]ocker-proxy' \
        | grep -E "host-port ($(echo "$CODING_PORTS" | tr ' ' '|'))" \
        | awk '{print $1}' || true)

    if [ -z "$leaked" ]; then
        echo "ℹ️ No leaked docker-proxy processes found"
        return 0
    fi

    echo "🧟 Found leaked docker-proxy process(es): $(echo "$leaked" | tr '\n' ' ')"

    # Try a normal kill first (works if we own them), then sudo -n (passwordless),
    # never an interactive sudo prompt from a teardown script.
    echo "$leaked" | xargs kill 2>/dev/null || true
    sleep 1

    local still
    still=$(ps -eo pid,cmd 2>/dev/null | grep '[d]ocker-proxy' \
        | grep -E "host-port ($(echo "$CODING_PORTS" | tr ' ' '|'))" \
        | awk '{print $1}' || true)

    if [ -n "$still" ]; then
        if sudo -n true 2>/dev/null; then
            echo "🔐 Using passwordless sudo to clear root-owned proxies..."
            echo "$still" | xargs sudo -n kill 2>/dev/null || true
            sleep 1
            still=$(ps -eo pid,cmd 2>/dev/null | grep '[d]ocker-proxy' \
                | grep -E "host-port ($(echo "$CODING_PORTS" | tr ' ' '|'))" \
                | awk '{print $1}' || true)
        fi
    fi

    if [ -n "$still" ]; then
        echo "⚠️ Leaked docker-proxy process(es) still running (root-owned): $(echo "$still" | tr '\n' ' ')"
        echo "   These hold host ports and require privileges to clear. Run ONE of:"
        echo "     sudo kill $(echo "$still" | tr '\n' ' ')"
        echo "     sudo systemctl restart docker   # clears all leaked proxies"
    else
        echo "✅ Leaked docker-proxy processes cleared"
    fi
}

# Kill stale/orphaned coding node processes spawned from this repo's
# scripts/integrations/src/lib trees (e.g. dashboards left in native dev mode).
# Deliberately scoped to this repo path so we never touch unrelated node procs.
kill_stale_coding_processes() {
    echo "🧹 Cleaning stale coding node processes..."

    # Supervisors/coordinators that respawn children -- kill these first.
    local supervisor_patterns="global-process-supervisor.js global-lsl-coordinator.js live-logging-coordinator.js start-services-robust.js"
    for pat in $supervisor_patterns; do
        pkill -f "$pat" 2>/dev/null && echo "   ✅ Stopped $pat" || true
    done

    # Native system-health-dashboard dev processes (vite / server.js) bound to
    # 3032/3033 -- a common leftover that blocks the Docker port mappings.
    pkill -f "system-health-dashboard/node_modules/.bin/vite" 2>/dev/null \
        && echo "   ✅ Stopped native dashboard vite dev server" || true
    pkill -f "system-health-dashboard/server.js" 2>/dev/null \
        && echo "   ✅ Stopped native dashboard server.js" || true
    pkill -f "system-health-dashboard/static-server.js" 2>/dev/null \
        && echo "   ✅ Stopped native dashboard static-server.js" || true

    # Any remaining node process whose command line points into this repo's
    # runnable trees. Excludes the current shell/script via the path filter.
    local remaining
    remaining=$(pgrep -f "$CODING_REPO/(scripts|integrations|src|lib)/.*\.(js|ts|mjs|cjs)" 2>/dev/null || true)
    if [ -n "$remaining" ]; then
        echo "   🔥 Killing remaining repo node processes: $(echo "$remaining" | tr '\n' ' ')"
        echo "$remaining" | xargs kill 2>/dev/null || true
        sleep 1
        remaining=$(pgrep -f "$CODING_REPO/(scripts|integrations|src|lib)/.*\.(js|ts|mjs|cjs)" 2>/dev/null || true)
        [ -n "$remaining" ] && echo "$remaining" | xargs kill -9 2>/dev/null || true
    else
        echo "   ℹ️ No stale repo node processes found"
    fi
}

# Free any non-Docker host process still holding a coding port. Docker proxies
# are handled separately (clean_leaked_docker_proxies); here we only kill plain
# host listeners (native servers that didn't shut down).
free_coding_ports() {
    echo "🔌 Releasing coding host ports..."
    local freed_any=false
    for port in $CODING_PORTS; do
        local pids
        pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
        [ -z "$pids" ] && continue
        for pid in $pids; do
            local pname
            pname=$(ps -p "$pid" -o comm= 2>/dev/null || true)
            # Leave docker-proxy/dockerd to the proxy/compose cleanup paths.
            case "$pname" in
                *docker-proxy*|*dockerd*|*com.docker*) continue ;;
            esac
            echo "   🔥 Port $port held by PID $pid ($pname) - killing"
            kill "$pid" 2>/dev/null || true
            freed_any=true
        done
    done
    if [ "$freed_any" = true ]; then
        sleep 1
        echo "✅ Port cleanup complete"
    else
        echo "ℹ️ No stray host processes on coding ports"
    fi
}

# Read current services if available
SERVICES_FILE=".services-running.json"
if [ -f "$SERVICES_FILE" ]; then
    echo "📋 Reading current services from $SERVICES_FILE"
    
    # Extract PIDs using simple parsing
    TRANSCRIPT_PID=$(grep -o '"transcript-monitor": [0-9]*' "$SERVICES_FILE" 2>/dev/null | cut -d: -f2 | tr -d ' ' || echo "")
    LIVE_LOGGING_PID=$(grep -o '"live-logging": [0-9]*' "$SERVICES_FILE" 2>/dev/null | cut -d: -f2 | tr -d ' ' || echo "")
    VKB_PID=$(grep -o '"vkb-server": [0-9]*' "$SERVICES_FILE" 2>/dev/null | cut -d: -f2 | tr -d ' ' || echo "")
    
    # Stop services gracefully
    stop_process "$TRANSCRIPT_PID" "Transcript Monitor" 15
    stop_process "$LIVE_LOGGING_PID" "Live Logging Coordinator" 10
    stop_process "$VKB_PID" "VKB Server" 10
else
    echo "⚠️ No services file found, using process name search"
fi

# Additional cleanup - search by process name
echo "🧹 Additional process cleanup..."

# Kill by process name patterns
pkill -f "transcript-monitor.js" 2>/dev/null && echo "✅ Killed remaining transcript monitors" || echo "ℹ️ No transcript monitors found"
pkill -f "start-live-logging.js" 2>/dev/null && echo "✅ Killed remaining live-logging coordinators" || echo "ℹ️ No live-logging coordinators found"
pkill -f "live-logging-coordinator.js" 2>/dev/null && echo "✅ Killed remaining live-logging processes" || echo "ℹ️ No live-logging processes found"
pkill -f "statusline-health-monitor.js" 2>/dev/null && echo "✅ Killed remaining health monitors" || echo "ℹ️ No health monitors found"
pkill -f "health-verifier.js" 2>/dev/null && echo "✅ Killed health verifier" || echo "ℹ️ No health verifier found"
pkill -f "vkb.*server" 2>/dev/null && echo "✅ Killed remaining VKB servers" || echo "ℹ️ No VKB servers found"

# Stop the Docker stack (containers, network, orphans + their docker-proxy procs)
stop_docker_stack

# Kill stale/orphaned coding node processes (supervisors, native dashboards, etc.)
kill_stale_coding_processes

# Clear leaked docker-proxy processes that survive a crashed/interrupted run
clean_leaked_docker_proxies

# Release any remaining non-Docker host process holding a coding port
free_coding_ports

# Log shutdown
mkdir -p "$CODING_REPO/logs" 2>/dev/null || true
echo "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ") - Services stopped" >> "$CODING_REPO/logs/live-logging.log" 2>/dev/null || true

# Remove services tracking file
if [ -f "$SERVICES_FILE" ]; then
    rm "$SERVICES_FILE"
    echo "🗑️ Removed services tracking file"
fi

# Show final status
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "🛑 SERVICES SHUTDOWN COMPLETE"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "✅ All coding services stopped"
echo "📝 Shutdown logged to live-logging.log"
echo ""
echo "To restart services, run: ./start-services.sh or coding"
echo "═══════════════════════════════════════════════════════════════════════"