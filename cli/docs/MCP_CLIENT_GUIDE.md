# MCP Client Guide for CLI Commands

## Overview

The MCP Client (`mcp-client.ts`) provides a thin wrapper for CLI commands to call MCP tools, implementing **ADR-005: MCP-First API Design** where CLI acts as a thin wrapper around MCP tools.

## Architecture

```
┌─────────────────┐
│  CLI Command    │  ← User interaction & display only
└────────┬────────┘
         │ callMCPTool()
         ▼
┌─────────────────┐
│  MCP Client     │  ← Tool registry & routing
└────────┬────────┘
         │ tool.handler()
         ▼
┌─────────────────┐
│  MCP Tool       │  ← Business logic lives here
│  Handler        │
└─────────────────┘
```

## Quick Start

### 1. Import the MCP Client

```typescript
import { callMCPTool, MCPClientError } from '../mcp-client.js';
```

### 2. Call an MCP Tool

```typescript
try {
  const result = await callMCPTool('agent_spawn', {
    agentType: 'implementer',
    provider: 'gemini-cli',
    task: 'Implement the feature'
  });

  // Handle success - display output
  output.printSuccess(`Agent ${result.agentId} spawned`);
  return { success: true, data: result };

} catch (error) {
  if (error instanceof MCPClientError) {
    output.printError(`Failed: ${error.message}`);
  }
  return { success: false, exitCode: 1 };
}
```

## Available MCP Tools

Tool implementations live at `v3/@hive-flow/cli/src/mcp-tools/`.

### Agent Tools

| Tool Name | Description | Input Parameters |
|-----------|-------------|------------------|
| `agent_spawn` | Spawn a new agent | `agentType` (req), `agentId?`, `config?`, `domain?`, `provider?`, `model?`, `task?` |
| `agent_list` | List agents | `status?`, `agentType?`, `domain?`, `includeTerminated?` |
| `agent_status` | Get agent status | `agentId` (req) |
| `agent_terminate` | Terminate an agent | `agentId` (req), `force?` |
| `agent_task` | Dispatch a task (non-blocking). Returns `taskId`. Poll with `agent_task_result`. | `agentId` (req), `task` (req), `timeout?` |
| `agent_task_result` | Poll for result of a dispatched task | `taskId` (req) |
| `agent_pool` | Manage agent pool | `action` (req: `status`\|`scale`\|`drain`\|`fill`), `targetSize?`, `agentType?` |
| `agent_health` | Check agent health | `agentId?`, `threshold?` |
| `agent_update` | Update agent status or config | `agentId` (req), `status?`, `health?`, `taskCount?`, `config?` |
| `agent_activity` | Query recent per-tool activity log | `agentId?`, `hiveId?`, `timeRange?`, `tool?`, `limit?` |

#### `agent_spawn` parameter details

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentType` | string (enum) | yes | Canonical agent type (e.g. `implementer`, `verifier`, `tester`) |
| `agentId` | string | no | Optional custom agent ID |
| `config` | object | no | Agent configuration |
| `domain` | string | no | Agent domain |
| `provider` | string | no | LLM provider: `anthropic`, `anthropic-cli`, `gemini-cli`, `codex-cli`, `cursor-cli`, `deepseek`, `openrouter` (default: `anthropic`) |
| `model` | string | no | Model alias (`opus`/`sonnet`/`mini`/`inherit`) or provider-native model string |
| `task` | string | no | Task description for intelligent model routing (ADR-026) |

#### `agent_task` Non-Blocking Contract

`agent_task` is non-blocking. It spawns a detached provider bridge and returns immediately with `{ taskId, agentId, status: 'running', pid }`. The `anthropic` provider is **not** supported — use `anthropic-cli` for Claude subprocess workers.

Poll with `agent_task_result`:
- `status: 'running'` — bridge PID is alive, no result yet
- `status: 'completed'` — result file written; returns `{ result }` object
- `status: 'failed'` — bridge exited without writing result
- `terminal: true` — task ID unknown (never existed or already fully consumed)

State files: `.hive-flow/tasks/<taskId>.task`, `.hive-flow/tasks/<taskId>.json`, `.hive-flow/tasks/<taskId>.result.json`. See `agent-task-recovery-contract.md` for the full recovery contract.

### Swarm Tools

| Tool Name | Description | Input Parameters |
|-----------|-------------|------------------|
| `swarm_init` | Initialize a swarm | `topology?`, `maxAgents?`, `config?` |
| `swarm_status` | Get swarm status | `swarmId?` |
| `swarm_shutdown` | Shutdown a swarm | `swarmId?`, `graceful?` |
| `swarm_health` | Check swarm health | `swarmId?` |

`topology` defaults to `hierarchical-mesh` when omitted. It is **not** required.

### Memory Tools

| Tool Name | Description | Input Parameters |
|-----------|-------------|------------------|
| `memory_store` | Store a value (sql.js + HNSW backend) | `key` (req), `value` (req), `namespace?`, `tags?`, `ttl?`, `upsert?` |
| `memory_retrieve` | Retrieve a value by key | `key` (req), `namespace?` |
| `memory_search` | Semantic vector search (HNSW) | `query` (req), `namespace?`, `limit?`, `threshold?` |
| `memory_list` | List memory entries | `namespace?`, `limit?`, `offset?` |
| `memory_delete` | Delete a memory entry | `key` (req), `namespace?` |
| `memory_stats` | Storage statistics and HNSW index status | _(no parameters)_ |
| `memory_migrate` | Trigger migration from legacy JSON store to sql.js | `force?` |

#### `memory_store` parameter details

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | yes | Memory key (unique within namespace) |
| `value` | any | yes | Value to store (string or object) |
| `namespace` | string | no | Namespace for organization (default: `"default"`) |
| `tags` | string[] | no | Optional tags |
| `ttl` | number | no | Time-to-live in seconds |
| `upsert` | boolean | no | Update existing key instead of failing (default: `false`) |

#### `memory_search` parameter details

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (semantic similarity via HNSW) |
| `namespace` | string | no | Namespace to search (default: `"default"`) |
| `limit` | number | no | Maximum results (default: 10) |
| `threshold` | number | no | Minimum similarity 0–1 (default: 0.3) |

### Config Tools

| Tool Name | Description | Input Parameters |
|-----------|-------------|------------------|
| `config_get` | Get a configuration value | `key` (req), `scope?` |
| `config_set` | Set a configuration value | `key` (req), `value` (req), `scope?` |
| `config_list` | List configuration values | `scope?`, `prefix?`, `includeDefaults?` |
| `config_reset` | Reset config to defaults | `scope?`, `key?` |
| `config_export` | Export configuration to JSON | `scope?`, `includeDefaults?` |
| `config_import` | Import configuration from JSON | `config` (req), `scope?`, `merge?` |

`config_get` and `config_set` use dot-notation keys (e.g. `swarm.topology`). The `scope` field accepts `project`, `user`, or `system`.

## MCP Client API

### Core Functions

#### `callMCPTool<T>(toolName, input, context?): Promise<T>`

Call an MCP tool by name and return typed result.

**Parameters:**
- `toolName`: MCP tool name (e.g., `'agent_spawn'`)
- `input`: Tool input parameters (validated by tool's schema)
- `context?`: Optional context object

**Returns:** Promise resolving to tool result

**Throws:** `MCPClientError` if tool not found or execution fails

**Example:**
```typescript
const result = await callMCPTool<{ agentId: string }>('agent_spawn', {
  agentType: 'implementer',
  provider: 'codex-cli',
  task: 'Implement the auth module'
});
console.log(`Spawned agent: ${result.agentId}`);
```

#### `getToolMetadata(toolName): ToolMetadata | undefined`

Get tool metadata without executing it.

**Example:**
```typescript
const metadata = getToolMetadata('agent_spawn');
if (metadata) {
  console.log(`Description: ${metadata.description}`);
  console.log(`Category: ${metadata.category}`);
  console.log(`Schema:`, metadata.inputSchema);
}
```

#### `listMCPTools(category?): ToolMetadata[]`

List all available MCP tools, optionally filtered by category.

**Example:**
```typescript
// List all tools
const allTools = listMCPTools();

// List only agent tools
const agentTools = listMCPTools('agent');
```

#### `hasTool(toolName): boolean`

Check if an MCP tool exists.

**Example:**
```typescript
if (hasTool('agent_spawn')) {
  console.log('Agent spawn tool is available');
}
```

#### `validateToolInput(toolName, input): { valid: boolean; errors?: string[] }`

Validate input against tool schema before calling.

**Example:**
```typescript
const validation = validateToolInput('agent_spawn', {
  agentType: 'implementer'
});

if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}
```

#### `getToolCategories(): string[]`

Get all unique tool categories (sorted alphabetically).

**Example:**
```typescript
const categories = getToolCategories();
console.log('Available categories:', categories);
// Example output (truncated): ['advocate', 'agent', 'analyze', 'browser', 'bug-hunter', 'claims',
//          'config', 'coordination', 'daa', 'embeddings', 'github', 'hive-mind',
//          'memory', 'neural', 'performance', 'permission-guard', 'planning',
//          'provider', 'queen', 'security', 'session', 'swarm', 'system',
//          'task', 'terminal', 'transfer', 'verification', 'workflow', ...]
```

### Error Handling

#### `MCPClientError`

Custom error class for MCP tool failures.

**Properties:**
- `message`: Error message
- `toolName`: Name of the tool that failed
- `cause?`: Original error if available

**Example:**
```typescript
try {
  await callMCPTool('agent_spawn', { ... });
} catch (error) {
  if (error instanceof MCPClientError) {
    console.error(`Tool '${error.toolName}' failed: ${error.message}`);
    if (error.cause) {
      console.error('Caused by:', error.cause);
    }
  }
}
```

## CLI Command Pattern

### Standard Pattern

All CLI commands should follow this pattern:

```typescript
import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { select, confirm, input } from '../prompt.js';
import { callMCPTool, MCPClientError } from '../mcp-client.js';

const myCommand: Command = {
  name: 'my-command',
  description: 'Command description',
  options: [ /* command options */ ],

  action: async (ctx: CommandContext): Promise<CommandResult> => {
    // STEP 1: Gather input (interactive prompts if needed)
    let param = ctx.flags.param as string;
    if (!param && ctx.interactive) {
      param = await input({
        message: 'Enter parameter:',
        validate: (v) => v.length > 0 || 'Required'
      });
    }

    // STEP 2: Validate required inputs
    if (!param) {
      output.printError('Parameter is required');
      return { success: false, exitCode: 1 };
    }

    // STEP 3: Call MCP tool (business logic)
    try {
      const result = await callMCPTool<ResultType>('tool_name', {
        param,
        // ... other inputs
      });

      // STEP 4: Format and display output
      if (ctx.flags.format === 'json') {
        output.printJson(result);
      } else {
        output.printTable({
          columns: [ /* ... */ ],
          data: [ /* format result for display */ ]
        });
      }

      output.printSuccess('Operation successful');
      return { success: true, data: result };

    } catch (error) {
      // STEP 5: Handle errors
      if (error instanceof MCPClientError) {
        output.printError(`Failed: ${error.message}`);
      } else {
        output.printError(`Unexpected error: ${String(error)}`);
      }
      return { success: false, exitCode: 1 };
    }
  }
};
```

### Key Principles

1. **CLI is thin**: Only handles UI/UX, no business logic
2. **MCP tool has logic**: All business logic in MCP tool handlers
3. **Type safety**: Use TypeScript generics for tool results
4. **Error handling**: Always catch and handle MCPClientError
5. **Display formatting**: CLI adds visual enhancements only

### What Belongs in CLI vs MCP Tool

#### CLI Command Responsibilities (Display Layer)

✅ Interactive prompts (select, confirm, input)
✅ Flag/argument parsing
✅ Input validation (basic checks)
✅ Output formatting (tables, boxes, colors)
✅ Progress indicators
✅ Success/error messages
✅ JSON output formatting

#### MCP Tool Responsibilities (Business Logic)

✅ Data validation (schema validation)
✅ Business rules enforcement
✅ Resource management (agents, swarms, memory)
✅ State changes
✅ Database operations
✅ External API calls
✅ Calculations and transformations

## Examples

### Example 1: Spawn an Agent

```typescript
const spawnCommand: Command = {
  name: 'spawn',
  action: async (ctx: CommandContext) => {
    const agentType = ctx.flags.type as string;
    const provider = (ctx.flags.provider as string) || 'gemini-cli';

    try {
      const result = await callMCPTool('agent_spawn', {
        agentType,
        provider,
        task: ctx.flags.task as string
      });

      output.printSuccess(`Spawned agent: ${result.agentId}`);
      return { success: true, data: result };

    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(error.message);
      }
      return { success: false, exitCode: 1 };
    }
  }
};
```

### Example 2: List Agents with Filtering

```typescript
const listCommand: Command = {
  name: 'list',
  action: async (ctx: CommandContext) => {
    try {
      const result = await callMCPTool<{
        agents: Agent[];
        total: number;
      }>('agent_list', {
        status: ctx.flags.status || undefined,
        agentType: ctx.flags.type,
        domain: ctx.flags.domain,
        includeTerminated: ctx.flags.all as boolean
      });

      // Display results
      output.printTable({
        columns: [
          { key: 'id', header: 'ID', width: 20 },
          { key: 'type', header: 'Type', width: 15 },
          { key: 'status', header: 'Status', width: 10 }
        ],
        data: result.agents
      });

      output.printInfo(`Total: ${result.total} agents`);
      return { success: true, data: result };

    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(error.message);
      }
      return { success: false, exitCode: 1 };
    }
  }
};
```

### Example 3: Store Memory

```typescript
const storeCommand: Command = {
  name: 'store',
  action: async (ctx: CommandContext) => {
    // Get input interactively if not provided
    let key = ctx.flags.key as string;
    if (!key && ctx.interactive) {
      key = await input({
        message: 'Enter memory key:',
        validate: (v) => v.length > 0 || 'Key required'
      });
    }

    let value = ctx.flags.value as string;
    if (!value && ctx.interactive) {
      value = await input({
        message: 'Enter value to store:',
        validate: (v) => v.length > 0 || 'Value required'
      });
    }

    if (!key || !value) {
      output.printError('Key and value are required');
      return { success: false, exitCode: 1 };
    }

    try {
      const result = await callMCPTool('memory_store', {
        key,
        value,
        namespace: ctx.flags.namespace || 'default',
        tags: (ctx.flags.tags as string)?.split(',') || [],
        upsert: ctx.flags.upsert as boolean
      });

      output.printSuccess(`Stored memory: ${result.key}`);
      return { success: true, data: result };

    } catch (error) {
      if (error instanceof MCPClientError) {
        output.printError(error.message);
      }
      return { success: false, exitCode: 1 };
    }
  }
};
```

### Example 4: Dispatch and Poll an Async Agent Task

```typescript
// Dispatch — returns immediately
const dispatch = await callMCPTool<{ taskId: string; status: string }>('agent_task', {
  agentId: 'agent-abc123',
  task: 'Refactor the auth module',
  timeout: 120000
});

// Poll until terminal
let done = false;
while (!done) {
  const poll = await callMCPTool<{ status: string; result?: unknown; terminal?: boolean }>(
    'agent_task_result',
    { taskId: dispatch.taskId }
  );

  if (poll.status === 'completed') {
    output.printSuccess('Task completed');
    output.printJson(poll.result);
    done = true;
  } else if (poll.status === 'failed' || poll.terminal) {
    output.printError('Task failed or not found');
    done = true;
  } else {
    // still running — wait before next poll
    await new Promise(r => setTimeout(r, 2000));
  }
}
```

## Testing

### Unit Testing MCP Client

```typescript
import { callMCPTool, MCPClientError, hasTool } from '../mcp-client.js';

describe('MCP Client', () => {
  it('should call agent_spawn tool', async () => {
    const result = await callMCPTool('agent_spawn', {
      agentType: 'implementer'
    });

    expect(result).toHaveProperty('agentId');
    expect(result).toHaveProperty('agentType', 'implementer');
  });

  it('should throw MCPClientError for unknown tool', async () => {
    await expect(
      callMCPTool('unknown_tool', {})
    ).rejects.toThrow(MCPClientError);
  });

  it('should check if tool exists', () => {
    expect(hasTool('agent_spawn')).toBe(true);
    expect(hasTool('unknown_tool')).toBe(false);
  });
});
```

### Integration Testing CLI Commands

```typescript
import { execute } from '../cli.js';

describe('Agent spawn command', () => {
  it('should spawn agent via MCP tool', async () => {
    const result = await execute(['agent', 'spawn', '--type', 'implementer']);

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('agentId');
  });
});
```

## Best Practices

### 1. Type Safety

Always provide type parameters to `callMCPTool`:

```typescript
// ✅ Good: Type-safe
const result = await callMCPTool<{ agentId: string }>('agent_spawn', { ... });
console.log(result.agentId); // TypeScript knows this exists

// ❌ Bad: No type safety
const result = await callMCPTool('agent_spawn', { ... });
console.log(result.agentId); // No type checking
```

### 2. Error Handling

Always handle `MCPClientError`:

```typescript
// ✅ Good: Specific error handling
try {
  const result = await callMCPTool(...);
} catch (error) {
  if (error instanceof MCPClientError) {
    output.printError(`Tool failed: ${error.message}`);
  } else {
    output.printError(`Unexpected error: ${String(error)}`);
  }
  return { success: false, exitCode: 1 };
}

// ❌ Bad: Generic error handling
try {
  const result = await callMCPTool(...);
} catch (error) {
  console.error(error); // User sees raw error
}
```

### 3. Input Validation

Validate inputs before calling tools:

```typescript
// ✅ Good: Validate first
if (!agentId) {
  output.printError('Agent ID is required');
  return { success: false, exitCode: 1 };
}

const result = await callMCPTool('agent_status', { agentId });

// ❌ Bad: Let tool fail
const result = await callMCPTool('agent_status', { agentId }); // Might be undefined
```

### 4. Output Formatting

Keep display logic in CLI, not in tool results:

```typescript
// ✅ Good: CLI formats output
const result = await callMCPTool('agent_list', { ... });
const displayData = result.agents.map(agent => ({
  id: agent.id,
  type: agent.agentType,
  created: new Date(agent.createdAt).toLocaleString() // Format in CLI
}));
output.printTable({ data: displayData });

// ❌ Bad: Expect pre-formatted data from tool
const result = await callMCPTool('agent_list', { ... });
output.printTable({ data: result.formattedAgents }); // Tool shouldn't format
```

### 5. Progressive Enhancement

Use feature detection for optional capabilities:

```typescript
// Check if tool supports a feature before using it
const metadata = getToolMetadata('agent_spawn');
const supportsTask = metadata?.inputSchema.properties?.task;

const result = await callMCPTool('agent_spawn', {
  agentType,
  task: supportsTask ? taskDescription : undefined
});
```

## Troubleshooting

### Tool Not Found

**Problem:** `MCPClientError: MCP tool not found: xyz_abc`

**Solutions:**
1. Check tool name spelling — all names use underscores, not slashes (e.g. `agent_spawn` not `agent/spawn`)
2. Verify tool is registered in `mcp-client.ts`
3. Import tool from the correct file under `v3/@hive-flow/cli/src/mcp-tools/`

### Type Errors

**Problem:** TypeScript errors when calling `callMCPTool`

**Solutions:**
1. Provide correct type parameter: `callMCPTool<ResultType>(...)`
2. Match input schema from tool definition
3. Check tool's TypeScript interfaces

### Validation Errors

**Problem:** Tool execution fails with validation error

**Solutions:**
1. Use `validateToolInput()` before calling
2. Check tool's input schema requirements
3. Provide all required parameters

## Contributing

When adding new CLI commands:

1. Import `callMCPTool` and `MCPClientError`
2. Follow the standard CLI command pattern
3. Keep business logic in MCP tools
4. Add error handling for `MCPClientError`
5. Format output in CLI, not in tool
6. Add TypeScript types for tool results
7. Update this guide with new examples

## Related Documentation

- [MCP Tool Implementations](../src/mcp-tools/) - Tool source code
- [Agent Task Recovery Contract](./agent-task-recovery-contract.md) - Async task dispatch and recovery protocol

## Summary

The MCP Client provides a clean, type-safe way for CLI commands to call MCP tools while maintaining proper separation of concerns:

- **CLI**: User interaction & display
- **MCP Client**: Tool routing & error handling
- **MCP Tools**: Business logic & data management

This architecture ensures maintainability, testability, and consistency across all interfaces to the hive-flow system.
