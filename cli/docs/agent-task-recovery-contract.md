# Agent Task Recovery Contract

This contract covers provider-backed tasks dispatched through `agent_task` and
observed through `agent_task_result`.

## State Files

Agent task state is project-local under the owning project:

- `.hive-flow/agents/store.json`: agent records and current busy/idle state.
- `.hive-flow/tasks/<taskId>.task`: original prompt file for the bridge child.
- `.hive-flow/tasks/<taskId>.json`: in-flight tracking metadata.
- `.hive-flow/tasks/<taskId>.result.json`: terminal result authority.

`<taskId>.result.json` is the sole terminal authority. Tracking files, rewake
notifications, sentinels, and future journal/event surfaces are observability or
delivery aids only. They must not become a second source of terminal truth.

## Dispatch

`agent_task` is non-blocking:

1. Validate the persisted agent, provider, provider key availability, and model.
2. Transition the agent from `idle` to `busy`.
3. Persist the busy state before spawning the provider bridge.
4. Spawn the detached provider bridge child.
5. Persist `currentTaskPid` on the agent and `pid` in the task tracking file
   when a child pid is available.
6. Return `{ success: true, status: "running", taskId, pid }`.

The bridge writes `<taskId>.result.json` on terminal success or failure.

## Result Polling

`agent_task_result` follows this precedence:

1. Tracking missing, result present:
   return completed with `alreadyConsumed: true`.
2. Tracking missing, result missing:
   return terminal `Task not found` so monitors stop polling.
3. Tracking present, result present:
   parse the result, return completed, reset agent/workers to idle, and remove
   the prompt and tracking files. Keep the result file.
4. Tracking present, result malformed:
   return failed with a truncated `rawOutput` diagnostic.
5. Tracking present, no result, pid live:
   return running.
6. Tracking present, no result, pid proven dead:
   mark failed, reset agent/workers to idle, and return failed.
7. Tracking present, no result, no pid:
   return the tracking status for backward compatibility.

## PID Liveness

PID checks use `process.kill(pid, 0)` as a read-only existence probe.

Only `ESRCH` proves the process is dead. `EPERM` and other non-`ESRCH` errors are
treated as possibly live and therefore return running. This prevents ambiguous
OS/runtime errors from falsely failing live work.

## Rewake

The rewake hook observes result-file presence and notification markers only. It
does not decide terminal status. On completion it asks the operator/agent to call
`agent_task_result`, which remains the authoritative consumer.

## Test Isolation

Tests and fixtures that write `.hive-flow` state must use an isolated project
root and, when global state is involved, an isolated `HIVE_FLOW_HOME`. They must
not write the operator's live project state.
