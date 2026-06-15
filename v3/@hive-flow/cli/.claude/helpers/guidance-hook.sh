#!/bin/bash
# Capture hook guidance for Claude visibility
GUIDANCE_FILE=".hive-flow/last-guidance.txt"
mkdir -p .hive-flow

# Resolve the hive-flow CLI portably (global install on PATH, else npx).
hf_cli() {
  if command -v hive-flow &>/dev/null; then
    hive-flow "$@"
  else
    npx -y "hive-flow" "$@"
  fi
}

case "$1" in
  "route")
    hf_cli hooks route "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
  "pre-edit")
    hf_cli hooks pre-edit "$2" 2>&1 | tee "$GUIDANCE_FILE"
    ;;
esac
