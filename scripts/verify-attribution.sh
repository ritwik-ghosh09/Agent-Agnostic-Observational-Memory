#!/bin/sh
# verify-attribution.sh — audit a repository for AI (Claude/Copilot) attribution.
#
# Checks two independent layers:
#   1. GIT LAYER  — every ref (local + remote-tracking + tags): author/committer
#      identities and commit-message trailers/footers naming AI tools.
#   2. GITHUB UI  — the live surfaces visitors actually see:
#        /_sidebar                (repo homepage Contributors sidebar; the cache
#                                  that does NOT self-heal after force-push)
#        /stats/contributors      (Insights -> Contributors computation)
#     The REST /contributors endpoint deliberately omits co-authors, so it is
#     NOT a reliable check and is not used here.
#
# Usage:
#   sh scripts/verify-attribution.sh [--git-only] [--no-fetch] [<owner/repo>]
#
#     <owner/repo>  defaults to the origin remote slug. Required for the UI layer.
#     --git-only    skip the GitHub UI checks (e.g. in CI on private/firewalled runners)
#     --no-fetch    do not run `git fetch --prune` first
#
# Exit codes: 0 = clean, 1 = attribution found or check failed.
# Portable POSIX sh: Linux, macOS, Git for Windows.

set -u

GIT_ONLY=0
NO_FETCH=0
SLUG=""
for arg in "$@"; do
    case "$arg" in
        --git-only) GIT_ONLY=1 ;;
        --no-fetch) NO_FETCH=1 ;;
        *) SLUG="$arg" ;;
    esac
done

fail=0
note() { printf '%s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
bail() { printf 'FAIL  %s\n' "$*"; fail=1; }

# AI identity/trailer patterns (case-insensitive).
IDENT_RE='claude|copilot|anthropic\.com|copilot-copilot@github|noreply@github\.com\[bot\]'
TRAILER_RE='^[[:space:]]*(co-authored-by|co-developed-by|assisted-by|helped-by|signed-off-by):.*(claude|copilot|anthropic)'
FOOTER_RE='generated with.*(claude code|copilot)|^🤖'

if [ "$NO_FETCH" -eq 0 ]; then
    git fetch --prune --quiet origin 2>/dev/null || note 'WARN  git fetch failed; auditing local refs only'
fi

# ---------------------------------------------------------------- git layer --
# 1a. Author/committer identities across all refs.
bad_idents=$(git log --all --format='%an <%ae>%n%cn <%ce>' 2>/dev/null \
    | grep -iE "$IDENT_RE" | sort -u)
if [ -n "$bad_idents" ]; then
    bail "AI identities found in commit author/committer fields:"
    printf '%s\n' "$bad_idents" | sed 's/^/        /'
else
    pass "no AI identities in any commit author/committer field"
fi

# 1b. Attribution trailers/footers in commit messages across all refs.
bad_msgs=$(git log --all --format='%h %B' 2>/dev/null \
    | grep -iE "$TRAILER_RE|$FOOTER_RE" | sed 's/[[:space:]]*$//' | sort -u)
# Filter out prose mentions inside subjects (e.g. docs describing the rule):
bad_msgs=$(printf '%s\n' "$bad_msgs" | grep -viE 'disable.*Co-Authored-By|attribution trailer' || true)
if [ -n "$bad_msgs" ]; then
    bail "AI trailers/footers found in commit messages:"
    printf '%s\n' "$bad_msgs" | sed 's/^/        /'
else
    pass "no AI trailers/footers in any commit message"
fi

# ------------------------------------------------------------- github ui ----
if [ "$GIT_ONLY" -eq 1 ]; then
    note 'SKIP  GitHub UI checks (--git-only)'
elif [ -z "$SLUG" ]; then
    origin_url=$(git config --get remote.origin.url 2>/dev/null || true)
    case "$origin_url" in
        *github.com[:/]*) SLUG=$(printf '%s' "$origin_url" | sed -E 's#.*github\.com[:/]##; s#\.git$##') ;;
    esac
    [ -n "$SLUG" ] && note "INFO  derived slug from origin: $SLUG"
fi

if command -v curl >/dev/null 2>&1 && [ -n "$SLUG" ] && [ "$GIT_ONLY" -eq 0 ]; then
    # 2a. Homepage sidebar (the sticky cache).
    sidebar=$(curl -sL --max-time 20 -H 'X-Requested-With: XMLHttpRequest' \
        "https://github.com/${SLUG}/_sidebar" || true)
    if [ -z "$sidebar" ]; then
        note 'WARN  could not fetch /_sidebar (rate limit or private repo?)'
    else
        ghost_logins=$(printf '%s' "$sidebar" \
            | grep -oE '"login":"[^"]*"' \
            | grep -iE '"login":"(claude|copilot)"' || true)
        if [ -n "$ghost_logins" ]; then
            bail "homepage Contributors sidebar still lists AI accounts:"
            printf '%s\n' "$ghost_logins" | sed 's/^/        /'
            printf '        fix: toggle default branch away+back in repo Settings\n'
            printf '             (or PATCH default_branch twice via API), then re-run.\n'
        else
            pass "homepage Contributors sidebar is clean"
        fi
    fi

    # 2b. Insights contributors stats (lazy-recomputed; poll briefly for 202).
    i=0
    while [ $i -lt 4 ]; do
        http=$(curl -sL --max-time 30 -o /tmp/va-stats.$$ -w '%{http_code}' \
            "https://api.github.com/repos/${SLUG}/stats/contributors" || echo 000)
        [ "$http" = "200" ] && break
        sleep 15
        i=$((i + 1))
    done
    if [ "$http" = "200" ]; then
        stat_ghosts=$(grep -oE '"login": *"[^"]*"' /tmp/va-stats.$$ 2>/dev/null \
            | grep -iE 'claude|copilot' || true)
        if [ -n "$stat_ghosts" ]; then
            bail "Insights contributor stats list AI accounts:"
            printf '%s\n' "$stat_ghosts" | sed 's/^/        /'
        else
            pass "Insights contributor stats are clean"
        fi
    else
        note "WARN  stats endpoint returned HTTP ${http:-000}; try again later"
    fi
    rm -f /tmp/va-stats.$$
fi

if [ "$fail" -eq 0 ]; then
    note 'OK    attribution audit clean'
else
    note 'ERROR attribution audit FAILED — see FAIL lines above'
fi
exit "$fail"
