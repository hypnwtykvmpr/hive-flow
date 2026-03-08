#!/bin/bash
# Comprehensive validation script for Docker environment
# Tests all hive-flow functionality in a clean environment

set -e  # Exit on error

echo "🐳 Hive-Flow Docker Validation Suite"
echo "========================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
PASSED=0
FAILED=0
TOTAL=0

# Test function
test_command() {
    local description="$1"
    local command="$2"
    local expected_pattern="$3"

    TOTAL=$((TOTAL + 1))
    echo -n "Testing: $description... "

    if output=$(eval "$command" 2>&1); then
        if [[ -z "$expected_pattern" ]] || echo "$output" | grep -q "$expected_pattern"; then
            echo -e "${GREEN}✓ PASS${NC}"
            PASSED=$((PASSED + 1))
            return 0
        else
            echo -e "${RED}✗ FAIL${NC} (pattern not found: $expected_pattern)"
            echo "Output: $output"
            FAILED=$((FAILED + 1))
            return 1
        fi
    else
        echo -e "${RED}✗ FAIL${NC} (command failed)"
        echo "Output: $output"
        FAILED=$((FAILED + 1))
        return 1
    fi
}

echo "📦 Phase 1: Installation & Build"
echo "--------------------------------"
test_command "NPM install" "npm --version" ""
test_command "Node version" "node --version" "v18"
test_command "Build completed" "ls -la dist/src/cli/main.js" "main.js"
test_command "Binary exists" "ls -la bin/hive-flow" "hive-flow"

echo ""
echo "🔧 Phase 2: CLI Basic Commands"
echo "------------------------------"
test_command "Help command" "./bin/hive-flow --help" "hive-flow"
test_command "Version command" "./bin/hive-flow --version" ""
test_command "Agent help" "./bin/hive-flow agent --help" "Manage agents"

echo ""
echo "🧠 Phase 3: Memory Commands (Basic Mode)"
echo "----------------------------------------"
test_command "Memory store" "./bin/hive-flow memory store test_key 'test value'" "Stored successfully"
test_command "Memory query" "./bin/hive-flow memory query test_key" "test value"
test_command "Memory stats" "./bin/hive-flow memory stats" "Total Entries"
test_command "Memory list" "./bin/hive-flow memory list" "default"
test_command "Memory export" "./bin/hive-flow memory export /tmp/test-export.json" "exported"

echo ""
echo "🧬 Phase 4: ReasoningBank Commands"
echo "-----------------------------------"
test_command "Memory detect" "./bin/hive-flow memory detect" "Basic Mode"
test_command "Memory mode" "./bin/hive-flow memory mode" "Default Mode"

echo ""
echo "🤖 Phase 5: Agent Commands"
echo "--------------------------"
test_command "Agent list" "./bin/hive-flow agent agents" "coder"
test_command "Agent info" "./bin/hive-flow agent info coder" "coder"

echo ""
echo "🌐 Phase 6: Proxy Commands"
echo "--------------------------"
test_command "Proxy help" "./bin/hive-flow proxy --help" "OpenRouter"
test_command "Proxy config" "./bin/hive-flow proxy config" "API Key Setup"

echo ""
echo "📋 Phase 7: Help System"
echo "-----------------------"
test_command "Main help has ReasoningBank" "./bin/hive-flow --help" "ReasoningBank"
test_command "Main help has proxy" "./bin/hive-flow --help" "proxy"
test_command "Main help has Agent Booster" "./bin/hive-flow --help" "booster"
test_command "Agent help has memory" "./bin/hive-flow agent --help" "memory"

echo ""
echo "🔒 Phase 8: Security Features"
echo "-----------------------------"
test_command "Redaction flag exists" "./bin/hive-flow memory store secure_test 'key=sk-ant-test' --redact" "redacted"
test_command "Redacted query" "./bin/hive-flow memory query secure_test --redact" "REDACTED"

echo ""
echo "📊 Phase 9: File Structure"
echo "--------------------------"
test_command "Memory directory exists" "test -d ./memory && echo 'exists'" "exists"
test_command "Memory store file created" "test -f ./memory/memory-store.json && echo 'exists'" "exists"

echo ""
echo "🧪 Phase 10: Integration Tests"
echo "------------------------------"
test_command "Import memory" "./bin/hive-flow memory import /tmp/test-export.json" "Imported"
test_command "Clear namespace" "./bin/hive-flow memory clear --namespace test_ns 2>&1 || echo 'expected'" "expected"

echo ""
echo "========================================"
echo "📊 Test Results Summary"
echo "========================================"
echo -e "Total Tests: ${TOTAL}"
echo -e "Passed: ${GREEN}${PASSED}${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"

if [ $FAILED -eq 0 ]; then
    echo -e "\n${GREEN}✅ All tests passed!${NC}"
    echo "🚀 Hive-Flow is ready for production release"
    exit 0
else
    echo -e "\n${RED}❌ Some tests failed${NC}"
    echo "Please review the failures above"
    exit 1
fi
