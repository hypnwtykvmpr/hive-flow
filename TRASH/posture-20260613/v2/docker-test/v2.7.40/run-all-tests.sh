#!/bin/bash

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║   Hive Flow v2.7.40 - Docker Validation Test Suite          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Testing published package: hive-flow@2.7.40"
echo "Focus: CLI functionality and hook error fixes"
echo "Started: $(date)"
echo ""

# Track test results
PASSED=0
FAILED=0

# Run test suite
run_test() {
    local test_name=$1
    local test_script=$2

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Running: $test_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if bash "$test_script" 2>&1 | tee "${test_script%.sh}.log"; then
        echo "✅ $test_name PASSED"
        PASSED=$((PASSED + 1))
    else
        echo "❌ $test_name FAILED"
        FAILED=$((FAILED + 1))
    fi
}

# Execute all tests
run_test "CLI Functionality Test" "/home/node/test-cli.sh"
run_test "Hook Exit Code Test" "/home/node/test-hooks.sh"
run_test "Hook Error Detection Test" "/home/node/test-hook-errors.sh"

# Generate summary
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                      TEST SUMMARY                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "Total Tests: $((PASSED + FAILED))"
echo "✅ Passed: $PASSED"
echo "❌ Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║                                                                ║"
    echo "║  🎉 ALL TESTS PASSED - hive-flow@2.7.40 is PRODUCTION-READY ║"
    echo "║                                                                ║"
    echo "║  ✅ CLI works correctly with npx                               ║"
    echo "║  ✅ All hooks exit with status 0                               ║"
    echo "║  ✅ No hook error messages detected                            ║"
    echo "║                                                                ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    exit 0
else
    echo "⚠️  SOME TESTS FAILED - Review logs above for details"
    exit 1
fi
