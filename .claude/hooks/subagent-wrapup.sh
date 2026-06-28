#!/bin/bash
#
# SubagentStop: Auto-capture learnings before subagent exits
#
# This hook runs when any subagent completes. It prompts the subagent
# to log key learnings to the knot before finishing.
#

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty')
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // empty')

# Only run for actual subagents (not the main agent)
[[ -z "$AGENT_ID" ]] && exit 0

# Check if there's a KNOT_ID in the agent's context
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.agent_transcript_path // empty')

if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  # Try to extract KNOT_ID from the transcript
  MAX_SCAN_BYTES="${HIVE_FLOW_SUBAGENT_WRAPUP_MAX_SCAN_BYTES:-1048576}"
  if [[ "$(wc -c < "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)" -gt "$MAX_SCAN_BYTES" ]]; then
    KNOT_ID=$(
      {
        head -c "$MAX_SCAN_BYTES" "$TRANSCRIPT_PATH" 2>/dev/null
        printf '\n'
        tail -c "$MAX_SCAN_BYTES" "$TRANSCRIPT_PATH" 2>/dev/null
      } | grep -m 1 -oE 'KNOT_ID: [A-Za-z0-9._-]+' 2>/dev/null | sed 's/KNOT_ID: //'
    )
  else
    KNOT_ID=$(grep -m 1 -oE 'KNOT_ID: [A-Za-z0-9._-]+' "$TRANSCRIPT_PATH" 2>/dev/null | sed 's/KNOT_ID: //')
  fi

  if [[ -n "$KNOT_ID" ]]; then
    # Subagent is working on a knot - prompt it to log learnings
    REASON="Before completing, please log what you learned to the knot using one or more of these formats:"
    REASON+=$'\n\n'"kno update $KNOT_ID --add-note \"LEARNED: [key technical insight you discovered]\""
    REASON+=$'\n'"kno update $KNOT_ID --add-note \"DECISION: [important choice you made and why]\""
    REASON+=$'\n'"kno update $KNOT_ID --add-note \"FACT: [constraint, gotcha, or important detail]\""
    REASON+=$'\n'"kno update $KNOT_ID --add-note \"PATTERN: [coding pattern or convention you followed]\""
    REASON+=$'\n'"kno update $KNOT_ID --add-note \"INVESTIGATION: [root cause or how something works]\""
    REASON+=$'\n\n'"After logging at least one insight, you may complete."
    jq -cn --arg reason "$REASON" '{decision:"block", reason:$reason}'
    exit 0
  fi
fi

# No KNOT_ID found or not working on a knot - allow completion
exit 0
