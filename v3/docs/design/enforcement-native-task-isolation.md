# Enforcement Native Task Isolation

## Problem

The tiered enforcement engine isolates hive-flow-spawned agents because their child
processes receive `AGENTIC_FLOW_AGENT_ID`, `CLAUDE_AGENT_ID`, and
`HIVE_FLOW_AGENT_TOKEN`. Native Claude Code Task agents are spawned by Claude Code,
not by `agent_spawn`, so they may not inherit those environment variables. Treating
a missing agent identity as global makes one native worker violation halt the
coordinator and sibling workers.

## Decision

Use the hook payload as the source of truth for native Task agents:

- `PreToolUse` inside a native subagent carries `agent_id` in the hook input.
- `SubagentStart` also carries `agent_id`; `role-enforcement.cjs` records it as a
  signed `native-task` role metadata file.
- `CLAUDE_SESSION_ID` is no longer considered an agent identity by itself. A
  session-only/coordinator context resolves to project scope.
- Provider/hive-flow agents still use `AGENTIC_FLOW_AGENT_ID` first, then
  `CLAUDE_AGENT_ID`, with spawn-token verification when an agent store entry
  exists.

## Scope Rules

- Trusted native Task `agent_id` violation: write `agents/<agentId>/state.json`.
- No agent identity / coordinator violation: write `projects/<projectHash>/state.json`.
- Hive and project cascades remain threshold-based.
- Global scope remains reserved for integrity failures, protected enforcement-file
  attacks, and other systemic circumvention.

## Verification Plan

- Unit: role-enforcement persists `native-task` metadata from `SubagentStart`.
- Unit: enforcement uses hook `agent_id` and ignores bare `CLAUDE_SESSION_ID`.
- Unit: session-only coordinator violations land in project state, not agent/global.
- Existing gates: helper syntax checks, `test:enforcement`, focused role/enforcement
  suites, CLI typecheck/build.
