[ENFORCEMENT_RESET_NOW]

Reset the enforcement system to NORMAL level. This clears all violations, restricted tool groups, and enforcement state.

This command is human-only — agents cannot invoke it. The reset is authenticated via HMAC-signed IPC to prevent unauthorized resets.

Steps:
1. Run: echo '{"user_prompt":"/enforcement-reset"}' | node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs enforcement-reset-check
   (The hook handler generates an HMAC signature and forwards the signed request to enforcement.cjs. Direct invocation of enforcement.cjs --reset-check without a valid signature will be rejected.)
2. Confirm reset was successful by reading .hive-flow/enforcement/state.json
3. Report the new enforcement state to the user
