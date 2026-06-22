#!/bin/bash
# Copilot userPromptSubmitted hook — non-blocking, warning-only.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
run_hook "userPromptSubmitted"
