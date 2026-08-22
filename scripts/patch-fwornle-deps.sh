#!/bin/sh
# patch-fwornle-deps.sh — neutralize unavailable upstream dependencies.
#
# Rewrites, idempotently:
#   integrations/mcp-server-semantic-analysis/package.json
#     "@fwornle/km-core"      -> "@local/km-core"    (file:../../lib/km-core)
#     "@rapid/llm-proxy"      -> "@local/llm-proxy"  (file:../../lib/llm-proxy)
#   .../dist/**/*.js|*.d.ts   import specifiers likewise
#
# Safe to run repeatedly. Works on host checkouts and inside image builds
# (paths are relative to this script's repository root).

set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SUB="$REPO/integrations/mcp-server-semantic-analysis"
KM_LOCAL="@local/km-core"
LLM_LOCAL="@local/llm-proxy"

[ -f "$SUB/package.json" ] || { echo "[patch-fwornle] $SUB/package.json not found - skipped"; exit 0; }

# 1. package.json dependency specifiers -> local file paths (any version spec).
sed -i.bak \
    -e "s|\"@fwornle/km-core\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"$KM_LOCAL\": \"file:../../lib/km-core\"|g" \
    -e "s|\"@rapid/llm-proxy\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"$LLM_LOCAL\": \"file:../../lib/llm-proxy\"|g" \
    "$SUB/package.json"
rm -f "$SUB/package.json.bak"

# 2. Import specifiers in compiled output AND TypeScript sources.
for tree in "$SUB/dist" "$SUB/src"; do
    [ -d "$tree" ] || continue
    find "$tree" -type f \( -name '*.js' -o -name '*.d.ts' -o -name '*.cjs' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' \) -exec \
        sed -i \
            -e "s|@fwornle/km-core|$KM_LOCAL|g" \
            -e "s|@rapid/llm-proxy|$LLM_LOCAL|g" \
            {} +
done

# 2b. Prose references inside the submodule README.
if [ -f "$SUB/README.md" ]; then
    sed -i -e "s|@fwornle/km-core|$KM_LOCAL|g" "$SUB/README.md"
fi

# 3. Stale lockfile pins the old tarball URLs — drop it so npm re-resolves.
rm -f "$SUB/package-lock.json"

echo "[patch-fwornle] dependencies neutralized (km-core, llm-proxy)"
