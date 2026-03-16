[ENFORCEMENT_RESET_NOW]

Reset the enforcement system to NORMAL level. This clears all violations, restricted tool groups, and enforcement state.

This command is human-only — agents cannot invoke it.

Steps:
1. Run: node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs --reset-check (with input containing /enforcement-reset)
2. Confirm reset was successful by reading .hive-flow/enforcement/state.json
3. Report the new enforcement state to the user
