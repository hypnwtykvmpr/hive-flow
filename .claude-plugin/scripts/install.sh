#!/usr/bin/env bash
# Hive Flow Plugin Installation Script
# Version: 3.0.0
#
# Delegates to the workspace CLI's 'setup' command (runbook §18 step 7).
# All integration logic lives in the TypeScript adapters — this script is
# a thin bootstrap shim for the pre-pnpm-link install path.
#
# Usage:
#   bash install.sh                      # auto-detect agents, user scope
#   bash install.sh --dry-run            # plan only, no writes
#   HIVE_FLOW_SCOPE=project bash install.sh   # project-local registration
#
# NOTE: Do NOT run this script to do a real install during CI syntax checks.
#       Syntax-check only:  bash -n install.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve REPO_ROOT: two levels up from scripts/ -> .claude-plugin/ -> repo root
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Workspace CLI — pre-pnpm-link path (runbook §18 step 7 requirement 2)
# ---------------------------------------------------------------------------
CLI_BIN="${REPO_ROOT}/cli/bin/cli.js"

# ---------------------------------------------------------------------------
# Colors for output
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { printf "${BLUE}i${NC} %s\n" "$1"; }
success() { printf "${GREEN}v${NC} %s\n" "$1"; }
warning() { printf "${YELLOW}!${NC} %s\n" "$1"; }
err()     { printf "${RED}x${NC} %s\n" "$1" >&2; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
if ! command -v node > /dev/null 2>&1; then
    err "Node.js not found. Hive Flow requires Node.js >= 20."
    exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
    err "Node.js >= 20 required (found $(node -v))."
    exit 1
fi

if [ ! -f "${CLI_BIN}" ]; then
    err "Workspace CLI not found at: ${CLI_BIN}"
    err "Run 'pnpm install && pnpm build' from the repo root first."
    exit 1
fi

# ---------------------------------------------------------------------------
# One-time warning if plaintext API keys are detected in ~/.claude/settings.json
# (keys are OUT OF SCOPE for this script — we never move/copy/display them)
# ---------------------------------------------------------------------------
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
if [ -f "${CLAUDE_SETTINGS}" ]; then
    # Look for common key patterns on the first ~15 lines only (shallow scan)
    if head -15 "${CLAUDE_SETTINGS}" | grep -qiE '"(api_key|apiKey|ANTHROPIC_API_KEY|secret)"\s*:\s*"[A-Za-z0-9_\-]{20,}"'; then
        warning "Possible plaintext API key detected in ${CLAUDE_SETTINGS} (lines 1-15)."
        warning "Consider moving secrets to environment variables or a secrets manager."
        warning "This installer will NOT read, move, or display those values."
        echo ""
    fi
fi

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
DRY_RUN_FLAG=""
SCOPE="${HIVE_FLOW_SCOPE:-user}"

for arg in "$@"; do
    case "${arg}" in
        --dry-run) DRY_RUN_FLAG="--dry-run" ;;
        --scope=*) SCOPE="${arg#--scope=}" ;;
        --scope)   ;;   # next positional handled below; keep simple
        *) ;;
    esac
done

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
printf '%s' "${BLUE}"
cat << "BANNER"
+-----------------------------------------------------------+
|                                                           |
|            Hive Flow Installer v3.0.0                    |
|       Enterprise AI Agent Orchestration Platform          |
|                                                           |
+-----------------------------------------------------------+
BANNER
printf '%s' "${NC}"
echo ""

# ---------------------------------------------------------------------------
# Invoke hive-flow setup (runbook §18 step 7 — requirement 1)
#
# Flags used:
#   --auto       non-interactive idempotent run (requirement 3 / §7.1)
#   --scope user registers globally so all agent CLIs see hive-flow
#                (runbook §7 Codex pass-6 item 1 — user scope is the default)
#
# NO destructive flags: no --force-adopt, no --uninstall, no rm/rm -rf
# (requirement 4 + critical safety)
# ---------------------------------------------------------------------------
info "Running: node \"${CLI_BIN}\" setup --auto --scope \"${SCOPE}\" --features mcp,statusline${DRY_RUN_FLAG:+ $DRY_RUN_FLAG}"
echo ""

SETUP_OUTPUT="$(node "${CLI_BIN}" setup --auto --scope "${SCOPE}" --features mcp,statusline ${DRY_RUN_FLAG:+"$DRY_RUN_FLAG"} 2>&1)" || {
    EXIT_CODE=$?
    err "hive-flow setup exited with code ${EXIT_CODE}."
    echo ""
    printf "%s\n" "${SETUP_OUTPUT}"
    exit "${EXIT_CODE}"
}

printf "%s\n" "${SETUP_OUTPUT}"
echo ""

# ---------------------------------------------------------------------------
# Summary — count applied + already-registered outcomes (requirement 6)
# Idempotency assertion: a second run reports already-registered (requirement 3)
# ---------------------------------------------------------------------------
APPLIED_COUNT="$(printf "%s\n" "${SETUP_OUTPUT}" | grep -c 'applied' || true)"
REGISTERED_COUNT="$(printf "%s\n" "${SETUP_OUTPUT}" | grep -c 'already-registered' || true)"
SKIPPED_COUNT="$(printf "%s\n" "${SETUP_OUTPUT}" | grep -c 'missing-config' || true)"
TOTAL_AGENTS=$(( APPLIED_COUNT + REGISTERED_COUNT ))

if [ "${DRY_RUN_FLAG}" = "--dry-run" ]; then
    success "Dry-run complete. No changes written."
    info "  Planned: ${TOTAL_AGENTS} agent(s) (${APPLIED_COUNT} to apply, ${REGISTERED_COUNT} already registered)"
else
    success "Hive Flow installed for ${TOTAL_AGENTS} agent(s)."
    if [ "${APPLIED_COUNT}" -gt 0 ]; then
        info "  Newly registered: ${APPLIED_COUNT}"
    fi
    if [ "${REGISTERED_COUNT}" -gt 0 ]; then
        info "  Already registered (idempotent): ${REGISTERED_COUNT}"
    fi
    if [ "${SKIPPED_COUNT}" -gt 0 ]; then
        warning "  Skipped (missing config): ${SKIPPED_COUNT} — run 'hive-flow setup --create-config' to opt in"
    fi
fi

# NOTE: setup.ts emits results as pretty-printed JSON (indent=2), so a single
# result row spans multiple lines: `"feature": "statusline"` and
# `"outcome": "conflict:manual-entry"` appear on adjacent lines within the same
# `{ ... }` block. We use awk to track the current row's feature and only count
# conflict:manual-entry outcomes that occur inside a statusline-feature block.
STATUSLINE_CONFLICT_COUNT="$(printf "%s\n" "${SETUP_OUTPUT}" | awk '
    /^[[:space:]]*\{[[:space:]]*$/ { feature = ""; next }
    /"feature"[[:space:]]*:[[:space:]]*"statusline"/ { feature = "statusline"; next }
    /"feature"[[:space:]]*:[[:space:]]*"mcp"/ { feature = "mcp"; next }
    /"outcome"[[:space:]]*:[[:space:]]*"conflict:manual-entry"/ {
        if (feature == "statusline") count++
    }
    END { print count + 0 }
' || true)"
if [ "${STATUSLINE_CONFLICT_COUNT}" -gt 0 ]; then
    warning "  Existing user statusline was preserved. To adopt it intentionally:"
    warning "  node \"${CLI_BIN}\" setup --auto --scope ${SCOPE} --agents claude-code --features statusline --force-adopt"
fi

echo ""
info "To verify MCP:        node \"${CLI_BIN}\" setup --verify --scope ${SCOPE} --features mcp"
info "To verify statusline: node \"${CLI_BIN}\" setup --verify --scope ${SCOPE} --agents claude-code --features statusline"
info "To reconcile:   node \"${CLI_BIN}\" setup --auto --scope ${SCOPE}"
info "To uninstall:   node \"${CLI_BIN}\" setup --uninstall --scope ${SCOPE}"
echo ""
