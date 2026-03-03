---
name: ask-provider
description: Send prompts to alternative LLM providers (Gemini, Codex, Cursor) via CLI
---

## Quick Provider Prompting

Send prompts to Gemini, Codex, or Cursor CLI providers using the `provider_complete` MCP tool.

### Examples

**Gemini (Google's model):**
```
provider_complete { "provider": "gemini-cli", "prompt": "Review this function for security issues:\n\nfunction login(user, pass) { ... }" }
```

**Codex (OpenAI's code model):**
```
provider_complete { "provider": "codex-cli", "prompt": "Generate a TypeScript interface for a user profile with validation", "model": "opus" }
```

**Cursor:**
```
provider_complete { "provider": "cursor-cli", "prompt": "Refactor this class to use dependency injection" }
```

### Model Selection

Use Claude aliases for portable model selection:
- `haiku` -- fastest, cheapest
- `sonnet` -- balanced
- `opus` -- most capable

Or use provider-native names directly (e.g., `gemini-2.5-pro`, `gpt-5.3-codex`).

### With System Prompt

```
provider_complete {
  "provider": "gemini-cli",
  "prompt": "What are the edge cases?",
  "systemPrompt": "You are a senior QA engineer reviewing code for a banking application.",
  "model": "sonnet"
}
```

### Persistent Agent Workflow

For multi-turn investigation, spawn a persistent provider agent instead of one-off completions:

**Spawn:**
```
agent_spawn { "provider": "gemini-cli", "name": "gemini-investigator", "task": "Review the error handling in src/api/routes.ts" }
```

**Follow up (conversation context preserved):**
```
agent_task { "agentId": "gemini-investigator", "task": "Are there any unhandled promise rejections in those routes?" }
```

**Check results:**
```
agent_status { "agentId": "gemini-investigator" }
```

Provider agents maintain conversation history across tasks. Default models: gemini-cli uses `gemini-3.1-pro-preview`, codex-cli uses `gpt-5.3-codex`, cursor-cli uses `auto`. See `/provider-agents` for full documentation.

### Prerequisites

Check that providers are available first:
```
provider_status {}
```
