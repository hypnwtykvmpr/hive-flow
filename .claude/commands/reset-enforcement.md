[ENFORCEMENT_RESET_NOW]

Reset the enforcement system to NORMAL level. This clears all violations, restricted tool groups, and enforcement state.

This command is human-only — agents cannot invoke it. The reset is authenticated via HMAC-signed IPC to prevent unauthorized resets.

Steps:
1. Do not run any Bash command. The slash-command hook auto-executes the HMAC-signed reset through `hook-handler.cjs enforcement-reset-check`.
2. Confirm reset was successful by reading `.hive-flow/enforcement/state.json` only.
3. Report the new enforcement state to the user.

Agents must not manually invoke `hook-handler.cjs enforcement-reset-check` or `enforcement.cjs --reset-check` from Bash. Manual reset execution is treated as an agent-initiated reset attempt; the only valid trigger is the human slash command.
