---
name: providers
description: Manage and use LLM CLI providers (Gemini, Codex, Cursor) — check status, send completions, view models
---

## CLI Provider Management

Three CLI providers wrap external AI binaries as subprocess providers:

| Provider | Binary | Auth | Install |
|----------|--------|------|---------|
| `gemini-cli` | `gemini` | Google OAuth (`gemini auth`) | `npm i -g @google/gemini-cli` |
| `codex-cli` | `codex` | `CODEX_API_KEY` env var or ChatGPT OAuth | `npm i -g @openai/codex` |
| `cursor-cli` | `cursor` | `CURSOR_API_KEY` env var | `curl https://cursor.com/install -fsSL \| bash` |

### Check Provider Status

Use the `provider_status` MCP tool to check if CLI binaries are installed and healthy:

```
provider_status {}                           # Check all providers
provider_status { "provider": "gemini-cli" } # Check specific provider
```

Returns: binary path, version, health status, latency.

### Send a Completion

Use the `provider_complete` MCP tool to send prompts to any CLI provider:

```
provider_complete {
  "provider": "gemini-cli",
  "prompt": "Explain this error: TypeError: Cannot read property...",
  "model": "sonnet"
}
```

### Model Alias Mapping

Claude aliases map to provider-native models:

| Alias | Gemini CLI | Codex CLI | Cursor CLI |
|-------|-----------|-----------|------------|
| `opus` | gemini-3.1-pro-preview | gpt-5.3-codex | auto |
| `sonnet` | gemini-2.5-pro | gpt-5.2-codex | auto |
| `haiku` | gemini-2.5-flash | gpt-5-codex-mini | auto |
| `inherit` | gemini-2.5-flash | (config.toml default) | auto |

### View Models

Use the `provider_models` MCP tool:

```
provider_models {}                           # All providers
provider_models { "provider": "codex-cli" }  # Specific provider
```

### CLI Commands

```bash
hive-flow providers list       # Show provider availability
hive-flow providers test       # Run health checks
hive-flow providers models     # List models and aliases
hive-flow providers configure  # Setup instructions
```

### Persistent Provider Agents

Beyond one-off completions, providers can back persistent agents with conversation history:

**Spawn a persistent agent:**
```
agent_spawn { "provider": "gemini-cli", "name": "my-gemini", "task": "Analyze the auth module" }
```

**Send follow-up tasks (context preserved):**
```
agent_task { "agentId": "my-gemini", "task": "Now check the JWT validation" }
```

**Check status:**
```
agent_status { "agentId": "my-gemini" }
```

Provider agents accumulate conversation history across tasks (up to 50 entries, 180KB prompt limit). They are text-in/text-out research agents -- use Claude agents (Task tool) for tasks that need file access or tool use.

Default models: gemini-cli uses `gemini-3.1-pro-preview`, codex-cli uses `gpt-5.3-codex`, cursor-cli uses `auto`.

See the `/provider-agents` skill for full documentation.

### Troubleshooting

- **Gemini: "not authenticated"** -- Run `gemini auth` in a terminal
- **Codex: "binary not found"** -- Run `npm i -g @openai/codex`
- **Cursor: "binary not found"** -- Install from https://cursor.com
- **Model resolution warning** -- Ensure model name matches provider (use aliases for portability)
