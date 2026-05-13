#!/bin/bash
#
# Master Test Runner for Hive Poll & Notification Tests
# Runs all 5 phases: Syntax, Dry-Run, Result Files, E2E, and Supplementary
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_WARNED=0

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          Hive Poll & Notification Test Suite               ║"
echo "║          Complete 5-Phase Integration Tests               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Parse arguments
RUN_PHASE="${1:-all}"
VERBOSE="${2:-false}"

show_phase() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
}

run_phase() {
  local phase=$1
  local desc=$2
  
  show_phase "PHASE $phase: $desc"
  
  local exit_code=0
  local output
  
  case $phase in
    1)
      output=$(bash "$SCRIPT_DIR/hive-poll-test-runner.sh" 2>&1) || exit_code=$?
      ;;
    2)
      output=$(bash "$SCRIPT_DIR/hive-poll-test-runner.sh" 2>&1) || exit_code=$?
      ;;
    3)
      output=$(bash "$SCRIPT_DIR/hive-poll-test-runner.sh" 2>&1) || exit_code=$?
      ;;
    4|5)
      if command -v node &> /dev/null; then
        output=$(node "$SCRIPT_DIR/hive-e2e-test-runner.js" 2>&1) || exit_code=$?
      else
        echo -e "${YELLOW}[SKIP]${NC} Node.js not available for phases 4-5"
        return 0
      fi
      ;;
    all)
      # Run phases 1-3 with bash
      output=$(bash "$SCRIPT_DIR/hive-poll-test-runner.sh" 2>&1) || exit_code=$?
      ;;
  esac
  
  if [ "$VERBOSE" = "true" ]; then
    echo "$output"
  else
    # Show just summary lines
    echo "$output" | grep -E "^\[|^  |===|PASS|FAIL|Summary" | tail -20
  fi
  
  # Extract pass/fail counts
  if echo "$output" | grep -q "Passed:"; then
    local passed=$(echo "$output" | grep "Passed:" | grep -oE '[0-9]+' | head -1)
    local failed=$(echo "$output" | grep "Failed:" | grep -oE '[0-9]+' | head -1)
    TOTAL_PASSED=$((TOTAL_PASSED + passed))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
  fi
  
  return $exit_code
}

# Run selected phases
case $RUN_PHASE in
  1)
    run_phase 1 "Syntax & Static Checks"
    ;;
  2)
    run_phase 2 "Dry-Run Poll Script"
    ;;
  3)
    run_phase 3 "Manual Result Files"
    ;;
  4)
    run_phase 4 "End-to-End Flow"
    ;;
  5)
    run_phase 5 "Supplementary Verification"
    ;;
  "1-3"|"1,3"|"1to3")
    run_phase 1 "Syntax & Static Checks"
    run_phase 2 "Dry-Run Poll Script"
    run_phase 3 "Manual Result Files"
    ;;
  all|"1-5"|"1,5"|"all-phases")
    run_phase 1 "Syntax & Static Checks"
    run_phase 2 "Dry-Run Poll Script"
    run_phase 3 "Manual Result Files"
    run_phase 4 "End-to-End Flow"
    run_phase 5 "Supplementary Verification"
    ;;
  *)
    echo "Usage: $0 [1|2|3|4|5|all|1-3|1-5]"
    echo ""
    echo "Phases:"
    echo "  1     - Syntax & Static Checks"
    echo "  2     - Dry-Run Poll Script"
    echo "  3     - Manual Result Files"
    echo "  4     - End-to-End Flow"
    echo "  5     - Supplementary Verification"
    echo "  1-3   - Bash script tests (1,2,3)"
    echo "  all   - All phases (default)"
    echo ""
    echo "Options:"
    echo "  verbose - Show full output"
    exit 1
    ;;
esac

# Final summary
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    FINAL TEST SUMMARY                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}Total Passed:  $TOTAL_PASSED${NC}"
echo -e "  ${RED}Total Failed:  $TOTAL_FAILED${NC}"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}✗ Some tests failed.${NC}"
  exit 1
fi
