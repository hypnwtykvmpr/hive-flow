---
name: provider-agents
description: Spawn and manage persistent agents backed by Gemini, Codex, or Cursor CLI providers
---

## Persistent Provider Agents

Provider agents are long-lived agents backed by external CLI providers (Gemini, Codex, Cursor). Unlike one-off completions (`provider_complete`), provider agents maintain conversation history across tasks, accumulate context, and appear in agent status/list.

### Default Models

| Provider | Default Model |
|----------|--------------|
| `gemini-cli` | `gemini-3.1-pro-preview` |
| `codex-cli` | `gpt-5.4` |
| `cursor-cli` | `auto` |

### Spawn a Provider Agent

Use the `agent_spawn` MCP tool with the `provider` parameter:

```
agent_spawn {
  "provider": "gemini-cli",
  "name": "my-gemini-researcher",
  "task": "Analyze the authentication module for security issues"
}
```

This creates a persistent `AgentRecord` with the provider and model fields set, executes the initial task, and stores the result and conversation history.

To create an idle agent (no initial task):

```
agent_spawn {
  "provider": "codex-cli",
  "name": "codex-analyst"
}
```

### Send Follow-Up Tasks

Use the `agent_task` MCP tool to send subsequent tasks. Conversation history is preserved, so the agent has context from prior exchanges:

```
agent_task {
  "agentId": "my-gemini-researcher",
  "task": "Now check if the JWT validation handles expired tokens correctly"
}
```

The agent receives the full conversation history plus the new task, enabling it to reference prior findings without re-explaining context.

### Check Agent Status

Use `agent_status` to see provider, model, last result summary, and history length:

```
agent_status { "agentId": "my-gemini-researcher" }
```

Returns: `provider`, `providerModel`, `lastResult.summary`, `lastTaskAt`, `historyLength`, plus standard agent fields.

### Context Accumulation

Provider agents accumulate conversation history across tasks:
- Each `agent_task` call appends the user message and assistant response
- History is trimmed to 50 entries maximum
- Total prompt size is capped at 180KB to stay within provider context limits
- Older entries are dropped when limits are reached

### Provider Agents vs Claude Agents

| Feature | Provider Agents | Claude Agents (Task tool) |
|---------|----------------|--------------------------|
| Tool access | Text-in/text-out only | Full tools (Read, Write, Bash, etc.) |
| Best for | Research, analysis, review | Implementation, file editing, testing |
| Context | Conversation history (50 entries) | Single task context |
| Models | Gemini, Codex, Cursor native models | Sonnet, Opus |
| Cost | Provider-dependent | Anthropic pricing |

Use provider agents for investigation and analysis tasks. Use Claude agents when the task needs file system access, code execution, or tool use.

### Troubleshooting

- **"binary not found"** -- The provider CLI is not installed. Install it:
  - Gemini: `npm i -g @google/gemini-cli`
  - Codex: `npm i -g @openai/codex`
  - Cursor: `curl https://cursor.com/install -fsSL | bash`
- **"not authenticated"** -- Run the provider's auth flow:
  - Gemini: `gemini auth`
  - Codex: Set `CODEX_API_KEY` env var or run `codex auth`
  - Cursor: Set `CURSOR_API_KEY` env var
- **Timeout** -- Long responses may time out. The system uses streaming internally to mitigate this. If timeouts persist, try breaking the task into smaller prompts.
- **Empty response** -- The provider returned no content. Check that the provider binary is healthy: `provider_status { "provider": "gemini-cli" }`
