#!/bin/bash
# Copilot preToolUse hook — non-blocking, warning-only.
# IMPORTANT: This hook must never deny a tool call. Concerns are emitted as
# warnings on stderr and the hook always exits 0 so the CLI can proceed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
run_hook "preToolUse"
