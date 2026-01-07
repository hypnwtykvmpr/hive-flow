/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import type { InitOptions, HooksConfig } from './types.js';

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Add hooks if enabled
  if (options.components.settings) {
    settings.hooks = generateHooksConfig(options.hooks);
  }

  // Add permissions
  settings.permissions = {
    // Auto-allow claude-flow MCP tools
    allow: [
      'Bash(npx claude-flow*)',
      'Bash(npx @claude-flow/*)',
      'mcp__claude-flow__*',
    ],
    // Auto-deny dangerous operations
    deny: [],
  };

  // Add model preferences for V3
  settings.model = {
    default: 'claude-sonnet-4-20250514',
    // Use Haiku for quick routing decisions
    routing: 'claude-haiku',
  };

  // Add V3-specific settings
  settings.claudeFlow = {
    version: '3.0.0',
    enabled: true,
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
  };

  return settings;
}

/**
 * Generate hooks configuration
 */
function generateHooksConfig(config: HooksConfig): object {
  const hooks: Record<string, unknown[]> = {};

  // PreToolUse hooks
  if (config.preToolUse) {
    hooks.PreToolUse = [
      // File edit hooks
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks pre-edit --file "$TOOL_INPUT_file_path" --intelligence',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Bash command hooks
      {
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks pre-command --command "$TOOL_INPUT_command"',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Task/Agent hooks
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks pre-task --task-id "task-$(date +%s)" --description "$TOOL_INPUT_prompt"',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Search hooks
      {
        matcher: '^(Grep|Glob|Read)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks pre-search --pattern "$TOOL_INPUT_pattern"',
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // PostToolUse hooks
  if (config.postToolUse) {
    hooks.PostToolUse = [
      // File edit hooks with learning
      {
        matcher: '^(Write|Edit|MultiEdit)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks post-edit --file "$TOOL_INPUT_file_path" --success "$TOOL_SUCCESS" --train-patterns',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Bash command hooks with metrics
      {
        matcher: '^Bash$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks post-command --command "$TOOL_INPUT_command" --success "$TOOL_SUCCESS" --exit-code "$TOOL_EXIT_CODE"',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Task completion hooks
      {
        matcher: '^Task$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks post-task --agent-id "$TOOL_RESULT_agent_id" --success "$TOOL_SUCCESS" --analyze',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
      // Search caching
      {
        matcher: '^(Grep|Glob)$',
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks post-search --cache-results',
            timeout: 2000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // UserPromptSubmit for intelligent routing
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks route --task "$PROMPT" --intelligence --include-explanation',
            timeout: config.timeout,
            continueOnError: config.continueOnError,
          },
        ],
      },
    ];
  }

  // SessionStart for context loading
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks session-start --session-id "$SESSION_ID" --load-context',
            timeout: 10000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // Stop hooks for task evaluation
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: 'prompt',
            prompt: `Evaluate task completion. Consider:
1. Were all requested changes made?
2. Did builds/tests pass?
3. Is follow-up work needed?

Respond with {"decision": "stop"} if complete, or {"decision": "continue", "reason": "..."} if more work is needed.`,
          },
        ],
      },
    ];
  }

  // Notification hooks
  if (config.notification) {
    hooks.Notification = [
      {
        hooks: [
          {
            type: 'command',
            command: 'npx @claude-flow/cli hooks notify --message "$NOTIFICATION_MESSAGE" --swarm-status',
            timeout: 3000,
            continueOnError: true,
          },
        ],
      },
    ];
  }

  // PermissionRequest for auto-allowing claude-flow tools
  if (config.permissionRequest) {
    hooks.PermissionRequest = [
      {
        matcher: '^mcp__claude-flow__.*$',
        hooks: [
          {
            type: 'command',
            command: 'echo \'{"decision": "allow", "reason": "claude-flow MCP tool auto-approved"}\'',
            timeout: 1000,
          },
        ],
      },
      {
        matcher: '^Bash\\(npx @?claude-flow.*\\)$',
        hooks: [
          {
            type: 'command',
            command: 'echo \'{"decision": "allow", "reason": "claude-flow CLI auto-approved"}\'',
            timeout: 1000,
          },
        ],
      },
    ];
  }

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
