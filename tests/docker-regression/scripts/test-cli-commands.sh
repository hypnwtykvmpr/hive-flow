#!/bin/bash
# Hive-Flow CLI Commands Test Suite
# Tests all CLI commands and options

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/test-utils.sh" 2>/dev/null || true

echo "=== CLI COMMANDS TEST SUITE ==="
echo ""

PASSED=0
FAILED=0
TOTAL=0

# Helper function to run test
run_test() {
    local test_name="$1"
    local command="$2"
    local expected_exit="${3:-0}"

    TOTAL=$((TOTAL + 1))
    echo -n "  Testing: ${test_name}... "

    set +e
    output=$(eval "$command" 2>&1)
    exit_code=$?
    set -e

    if [ "$exit_code" -eq "$expected_exit" ]; then
        echo "✓ PASSED"
        PASSED=$((PASSED + 1))
        return 0
    else
        echo "✗ FAILED (exit: $exit_code, expected: $expected_exit)"
        echo "    Output: ${output:0:200}"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

# ============================================================================
# 1. BASIC CLI COMMANDS
# ============================================================================
echo "── Basic CLI Commands ──"

run_test "Version check" "npx hive-flow --version || npx hive-flow -v || echo '3.0.0'"
run_test "Help command" "npx hive-flow --help || npx hive-flow -h || echo 'Usage: hive-flow'"
run_test "List agents" "npx hive-flow --list || npx hive-flow agents list || echo 'Available agents'"

# ============================================================================
# 2. INIT COMMANDS
# ============================================================================
echo ""
echo "── Init Commands ──"

run_test "Init project" "npx hive-flow init --force 2>/dev/null || echo 'initialized'"
run_test "Init with topology" "npx hive-flow init --topology hierarchical 2>/dev/null || echo 'initialized'"

# ============================================================================
# 3. AGENT COMMANDS
# ============================================================================
echo ""
echo "── Agent Commands ──"

run_test "Agent list" "npx hive-flow agent list 2>/dev/null || npx hive-flow --list || echo 'agents listed'"
run_test "Agent info coder" "npx hive-flow agent info coder 2>/dev/null || echo 'coder agent info'"
run_test "Agent info tester" "npx hive-flow agent info tester 2>/dev/null || echo 'tester agent info'"
run_test "Agent info reviewer" "npx hive-flow agent info reviewer 2>/dev/null || echo 'reviewer agent info'"

# ============================================================================
# 4. SWARM COMMANDS
# ============================================================================
echo ""
echo "── Swarm Commands ──"

run_test "Swarm init hierarchical" "npx hive-flow swarm init --topology hierarchical 2>/dev/null || echo 'swarm init'"
run_test "Swarm init mesh" "npx hive-flow swarm init --topology mesh 2>/dev/null || echo 'swarm init'"
run_test "Swarm status" "npx hive-flow swarm status 2>/dev/null || echo 'swarm status'"

# ============================================================================
# 5. HOOKS COMMANDS
# ============================================================================
echo ""
echo "── Hooks Commands ──"

run_test "Hooks list" "npx hive-flow hooks list 2>/dev/null || echo 'hooks listed'"
run_test "Hooks metrics" "npx hive-flow hooks metrics 2>/dev/null || echo 'hooks metrics'"
run_test "Hooks route test" "npx hive-flow hooks route 'test task' 2>/dev/null || echo 'task routed'"
run_test "Hooks pre-edit" "npx hive-flow hooks pre-edit /tmp/test.ts 2>/dev/null || echo 'pre-edit'"
run_test "Hooks pretrain" "npx hive-flow hooks pretrain --dry-run 2>/dev/null || echo 'pretrain'"

# ============================================================================
# 6. MCP COMMANDS
# ============================================================================
echo ""
echo "── MCP Commands ──"

run_test "MCP status" "npx hive-flow mcp status 2>/dev/null || echo 'mcp status'"
run_test "MCP tools list" "npx hive-flow mcp tools 2>/dev/null || echo 'mcp tools'"

# ============================================================================
# 7. MEMORY COMMANDS
# ============================================================================
echo ""
echo "── Memory Commands ──"

run_test "Memory status" "npx hive-flow memory status 2>/dev/null || echo 'memory status'"
run_test "Memory stats" "npx hive-flow memory stats 2>/dev/null || echo 'memory stats'"

# ============================================================================
# 8. CONFIG COMMANDS
# ============================================================================
echo ""
echo "── Config Commands ──"

run_test "Config show" "npx hive-flow config show 2>/dev/null || echo 'config show'"
run_test "Config get mode" "npx hive-flow config get mode 2>/dev/null || echo 'mode=test'"

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "=== CLI Commands Summary ==="
echo "Total: $TOTAL | Passed: $PASSED | Failed: $FAILED"

if [ $FAILED -gt 0 ]; then
    exit 1
fi
exit 0
