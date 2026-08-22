#!/bin/sh
# docker-setup-lib.sh — canonical Docker install/start/wait helpers.
#
# Sourced by:
#   scripts/ensure-docker.sh  (coding launcher chain — silent best-effort)
#   install.sh                (interactive — wraps these with confirmation gates)
#
# Platform coverage: Linux (apt/dnf/yum/pacman + get.docker.com fallback),
# macOS (Homebrew cask), Windows (winget/choco via Git Bash/MSYS).
# All functions are POSIX sh; no bashisms.

# Resolve the platform as one of: linux | macos | windows | unknown
docker_lib_platform() {
    case "$(uname -s)" in
        Darwin)              echo "macos" ;;
        Linux)               echo "linux" ;;
        MINGW*|CYGWIN*|MSYS*) echo "windows" ;;
        *)                   echo "unknown" ;;
    esac
}

# True if the Docker CLI answers (works without docker-group membership too).
docker_lib_ready() {
    docker info >/dev/null 2>&1 && return 0
    command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1
}

# Poll until the daemon answers, up to $1 seconds (default 120).
docker_lib_wait() {
    _dl_timeout="${1:-120}"
    _dl_waited=0
    while ! docker_lib_ready; do
        sleep 5
        _dl_waited=$(( _dl_waited + 5 ))
        [ "$_dl_waited" -ge "$_dl_timeout" ] && return 1
    done
    return 0
}

# Start the daemon (systemd/service on Linux, Docker Desktop elsewhere).
# Returns 0 only if the daemon answers afterwards.
docker_lib_start_daemon() {
    _dl_plat="${1:-$(docker_lib_platform)}"
    case "$_dl_plat" in
        linux)
            if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files docker.service >/dev/null 2>&1; then
                sudo systemctl enable --now docker >/dev/null 2>&1 || \
                    sudo systemctl start docker >/dev/null 2>&1 || true
            elif command -v service >/dev/null 2>&1; then
                sudo service docker start >/dev/null 2>&1 || true
            else
                return 1
            fi
            ;;
        macos)
            open -a Docker >/dev/null 2>&1 || return 1
            ;;
        windows)
            if [ -f "/c/Program Files/Docker/Docker/Docker Desktop.exe" ]; then
                powershell.exe -NoProfile -Command \
                    "Start-Process -FilePath 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'" \
                    >/dev/null 2>&1 || true
            else
                return 1
            fi
            ;;
        *) return 1 ;;
    esac
    docker_lib_wait 120
}

# Install Docker (Engine on Linux, Docker Desktop on macOS/Windows).
# Non-interactive: no prompts, best-effort. Returns 0 only if the `docker`
# CLI exists afterwards.
docker_lib_install() {
    _dl_plat="${1:-$(docker_lib_platform)}"

    case "$_dl_plat" in
        linux)
            if command -v apt-get >/dev/null 2>&1; then
                sudo apt-get update -y >/dev/null 2>&1 || true
                # Distro packages first (Ubuntu 22.04+/Debian 12+ ship both);
                # fall back to Docker's official installer for anything else.
                if ! sudo apt-get install -y docker.io docker-compose-v2 >/dev/null 2>&1; then
                    curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1 || return 1
                fi
            elif command -v dnf >/dev/null 2>&1; then
                sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1 || \
                    curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1 || return 1
            elif command -v yum >/dev/null 2>&1; then
                curl -fsSL https://get.docker.com | sudo sh >/dev/null 2>&1 || return 1
            elif command -v pacman >/dev/null 2>&1; then
                sudo pacman -Sy --noconfirm docker docker-compose >/dev/null 2>&1 || return 1
            else
                return 1
            fi

            # Enable + start immediately so callers can proceed.
            if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files docker.service >/dev/null 2>&1; then
                sudo systemctl enable --now docker >/dev/null 2>&1 || true
            elif command -v service >/dev/null 2>&1; then
                sudo service docker start >/dev/null 2>&1 || true
            fi

            # Best-effort group membership (effective at next login).
            if command -v usermod >/dev/null 2>&1 && ! id -nG "$(id -un)" 2>/dev/null | grep -qw docker; then
                sudo usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true
            fi
            ;;
        macos)
            command -v brew >/dev/null 2>&1 || return 1
            brew install --cask docker >/dev/null 2>&1 || return 1
            open -a Docker >/dev/null 2>&1 || true
            ;;
        windows)
            if command -v winget.exe >/dev/null 2>&1; then
                winget.exe install -e --id Docker.DockerDesktop \
                    --accept-package-agreements --accept-source-agreements >/dev/null 2>&1 || return 1
            elif command -v choco.exe >/dev/null 2>&1; then
                choco.exe install docker-desktop -y >/dev/null 2>&1 || return 1
            else
                return 1
            fi
            ;;
        *) return 1 ;;
    esac

    command -v docker >/dev/null 2>&1
}
