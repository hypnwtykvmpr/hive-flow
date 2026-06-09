[ENFORCEMENT_RESET_NOW]

Reset the enforcement system to NORMAL level. This clears all violations, restricted tool groups, and enforcement state.

This command is human-only — agents cannot invoke it. The reset is authenticated via HMAC-signed IPC to prevent unauthorized resets.

Steps:
1. Do not run any Bash command. The slash-command hook auto-executes the HMAC-signed reset through `hook-handler.cjs enforcement-reset-check`.
2. Confirm reset was successful from the hook output: `[ENFORCEMENT] Reset complete ... Enforcement level: NORMAL.`
3. Do not read `.hive-flow/enforcement/state.json`; it is protected enforcement state and reading it can re-trigger enforcement.
4. Report the hook-confirmed NORMAL state to the user.

Agents must not manually invoke `hook-handler.cjs enforcement-reset-check` or `enforcement.cjs --reset-check` from Bash. Manual reset execution is treated as an agent-initiated reset attempt; the only valid trigger is the human slash command.
