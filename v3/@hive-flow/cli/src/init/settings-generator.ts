/**
 * Settings.json Generator
 * Creates .claude/settings.json with V3-optimized hook configurations
 */

import type { InitOptions, HooksConfig } from './types.js';
import { buildRelocatedCommand } from '../install/enforcement-installer.js';

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

const GUARDED_TOOL_MATCHER = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'Read',
  'NotebookRead',
  'WebFetch',
  'NotebookEdit',
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file',
  'mcp__filesystem__rename_file',
  'mcp__filesystem__copy_file',
  'mcp__filesystem__create_directory',
  'mcp__filesystem__delete_file',
  'mcp__filesystem__read_file',
  'mcp__filesystem__read_text_file',
  'mcp__filesystem__read_media_file',
  'mcp__filesystem__read_multiple_files',
].join('|');

function helperCommand(helper: string, args = '', homeDir?: string): string {
  return buildRelocatedCommand(helper, { homeDir, args });
}

function commandHook(command: string, timeout: number): HookCommand {
  return { type: 'command', command, timeout };
}

function settingsReconcilerHook(homeDir?: string): HookCommand {
  return commandHook(helperCommand('settings-reconciler.cjs', '', homeDir), 5000);
}

export function generateEnforcementPreToolUseHooks(timeout: number, homeDir?: string): HookGroup[] {
  return [
    {
      matcher: 'Task',
      hooks: [
        commandHook(helperCommand('hive-composition-gate.cjs', '', homeDir), 5000),
      ],
    },
    {
      matcher: 'mcp__hive-flow__agent_spawn|mcp__hive-flow__queen_spawn_worker',
      hooks: [
        commandHook(helperCommand('role-enforcement.cjs', '', homeDir), 3000),
        commandHook(helperCommand('enforcement.cjs', '', homeDir), 5000),
      ],
    },
    {
      matcher: GUARDED_TOOL_MATCHER,
      hooks: [
        commandHook(helperCommand('role-enforcement.cjs', '', homeDir), 3000),
        commandHook(helperCommand('enforcement.cjs', '', homeDir), 5000),
        commandHook(helperCommand('hook-handler.cjs', 'permission-guard', homeDir), 15000),
        commandHook(helperCommand('hook-handler.cjs', 'enforce-plan', homeDir), 5000),
        commandHook(helperCommand('hook-handler.cjs', 'pre-bash', homeDir), timeout),
      ],
    },
  ];
}

function isGeneratedEnforcementPreToolUseGroup(group: HookGroup): boolean {
  return Boolean(group.hooks?.some((hook) =>
    hook.command.includes('hive-composition-gate.cjs') ||
    hook.command.includes('role-enforcement.cjs') ||
    hook.command.includes('enforcement.cjs') ||
    hook.command.includes('hook-handler.cjs permission-guard') ||
    hook.command.includes('hook-handler.cjs enforce-plan') ||
    hook.command.includes('hook-handler.cjs pre-bash')
  ));
}

export function ensureEnforcementPreToolUseHooks(hooks: Record<string, unknown[]>, timeout: number, homeDir?: string): void {
  const existing = (hooks.PreToolUse as HookGroup[] | undefined) || [];
  const preserved = existing.filter((group) => !isGeneratedEnforcementPreToolUseGroup(group));
  hooks.PreToolUse = [
    ...generateEnforcementPreToolUseHooks(timeout, homeDir),
    ...preserved,
  ];
}

function hasHookCommand(group: HookGroup, needle: string): boolean {
  return Boolean(group.hooks?.some((hook) => hook.command.includes(needle)));
}

function ensureCommandInFirstGroup(hooks: Record<string, unknown[]>, event: string, hook: HookCommand): void {
  const groups = (hooks[event] as HookGroup[] | undefined) || [];
  const alreadyPresent = groups.some((group) => hasHookCommand(group, hook.command));
  if (alreadyPresent) {
    hooks[event] = groups;
    return;
  }
  if (groups.length === 0) {
    hooks[event] = [{ hooks: [hook] }];
    return;
  }
  const [first, ...rest] = groups;
  first.hooks = [...(first.hooks || []), hook];
  hooks[event] = [first, ...rest];
}

export function ensureSettingsReconcilerHooks(hooks: Record<string, unknown[]>, homeDir?: string): void {
  const hook = settingsReconcilerHook(homeDir);
  const postGroups = (hooks.PostToolUse as HookGroup[] | undefined) || [];
  const postMatcher = 'Write|Edit|MultiEdit|mcp__filesystem__write_file|mcp__filesystem__edit_file';
  if (!postGroups.some((group) => hasHookCommand(group, hook.command))) {
    hooks.PostToolUse = [
      {
        matcher: postMatcher,
        hooks: [hook],
      },
      ...postGroups,
    ];
  } else {
    hooks.PostToolUse = postGroups;
  }

  ensureCommandInFirstGroup(hooks, 'SessionStart', hook);
  ensureCommandInFirstGroup(hooks, 'Stop', hook);
}

/**
 * Generate the complete settings.json content
 */
export function generateSettings(options: InitOptions): object {
  const settings: Record<string, unknown> = {};

  // Add hooks if enabled
  if (options.components.settings) {
    settings.hooks = generateHooksConfig(options.hooks, options.enforcementHomeDir);
  }

  // Add statusLine configuration if enabled
  if (options.statusline.enabled) {
    settings.statusLine = generateStatusLineConfig(options);
  }

  // Add permissions
  settings.permissions = {
    allow: [
      'Bash(npx @hive-flow*)',
      'Bash(hive-flow*)',
      'Bash(node .claude/*)',
      'mcp__hive-flow__:*',
    ],
    deny: [
      'Read(./.env)',
      'Read(./.env.*)',
    ],
  };

  // Add hive-flow attribution for git commits and PRs
  settings.attribution = {
    commit: 'Co-Authored-By: hive-flow <noreply@hive-flow.invalid>',
    pr: '🤖 Generated with [hive-flow]()',
  };

  // Note: Claude Code expects 'model' to be a string, not an object
  // Model preferences are stored in hiveFlow settings instead
  // settings.model = 'claude-sonnet-4-6'; // Uncomment if you want to set a default model

  // Add Agent Teams configuration (experimental feature)
  settings.env = {
    // Enable Claude Code Agent Teams for multi-agent coordination
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // Hive Flow specific environment
    HIVE_FLOW_V3_ENABLED: 'true',
    HIVE_FLOW_HOOKS_ENABLED: 'true',
  };

  // Add V3-specific settings
  settings.hiveFlow = {
    version: '3.0.0',
    enabled: true,
    modelPreferences: {
      default: 'claude-opus-4-8',
      routing: 'claude-sonnet-4-6',
    },
    agentTeams: {
      enabled: true,
      teammateMode: 'auto', // 'auto' | 'in-process'
      taskListEnabled: true,
      mailboxEnabled: true,
      coordination: {
        autoAssignOnIdle: true,       // Auto-assign pending tasks when teammate is idle
        trainPatternsOnComplete: true, // Train neural patterns when tasks complete
        notifyLeadOnComplete: true,   // Notify team lead when tasks complete
        sharedMemoryNamespace: 'agent-teams', // Memory namespace for team coordination
      },
      hooks: {
        teammateIdle: {
          enabled: true,
          autoAssign: true,
          checkTaskList: true,
        },
        taskCompleted: {
          enabled: true,
          trainPatterns: true,
          notifyLead: true,
        },
      },
    },
    swarm: {
      topology: options.runtime.topology,
      maxAgents: options.runtime.maxAgents,
    },
    memory: {
      backend: options.runtime.memoryBackend,
      enableHNSW: options.runtime.enableHNSW,
      learningBridge: { enabled: options.runtime.enableLearningBridge ?? true },
      memoryGraph: { enabled: options.runtime.enableMemoryGraph ?? true },
      agentScopes: { enabled: options.runtime.enableAgentScopes ?? true },
    },
    neural: {
      enabled: options.runtime.enableNeural,
    },
    daemon: {
      autoStart: true,
      workers: [
        'map',           // Codebase mapping
        'audit',         // Security auditing (critical priority)
        'optimize',      // Performance optimization (high priority)
        'consolidate',   // Memory consolidation
        'testgaps',      // Test coverage gaps
        'ultralearn',    // Deep knowledge acquisition
        'deepdive',      // Deep code analysis
        'document',      // Auto-documentation for ADRs
        'refactor',      // Refactoring suggestions (DDD alignment)
        'benchmark',     // Performance benchmarking
      ],
      schedules: {
        audit: { interval: '1h', priority: 'critical' },
        optimize: { interval: '30m', priority: 'high' },
        consolidate: { interval: '2h', priority: 'low' },
        document: { interval: '1h', priority: 'normal', triggers: ['adr-update', 'api-change'] },
        deepdive: { interval: '4h', priority: 'normal', triggers: ['complex-change'] },
        ultralearn: { interval: '1h', priority: 'normal' },
      },
    },
    learning: {
      enabled: true,
      autoTrain: true,
      patterns: ['coordination', 'optimization', 'prediction'],
      retention: {
        shortTerm: '24h',
        longTerm: '30d',
      },
    },
    adr: {
      autoGenerate: true,
      directory: '/docs/adr',
      template: 'madr',
    },
    ddd: {
      trackDomains: true,
      validateBoundedContexts: true,
      directory: '/docs/ddd',
    },
    security: {
      autoScan: true,
      scanOnEdit: true,
      cveCheck: true,
      threatModel: true,
    },
  };

  return settings;
}

/**
 * Generate statusLine configuration for Claude Code
 * Uses local helper script for cross-platform compatibility (no npx cold-start)
 */
function generateStatusLineConfig(_options: InitOptions): object {
  // Claude Code pipes JSON session data to the script via stdin.
  // Valid fields: type, command, padding (optional).
  // The script runs after each assistant message (debounced 300ms).
  return {
    type: 'command',
    command: 'node .claude/helpers/statusline.cjs',
  };
}

/**
 * Generate hooks configuration
 * Uses local hook-handler.cjs for cross-platform compatibility.
 * All hooks delegate to `node .claude/helpers/hook-handler.cjs <command>`
 * which works identically on Windows, macOS, and Linux without
 * shell-specific syntax (no bash 2>/dev/null, no PowerShell 2>$null).
 */
function generateHooksConfig(config: HooksConfig, homeDir?: string): object {
  const hooks: Record<string, unknown[]> = {};

  // Node.js scripts handle errors internally via try/catch.
  // No shell-level error suppression needed (2>/dev/null || true breaks Windows).

  // PreToolUse — validate commands before execution
  if (config.preToolUse) {
    hooks.PreToolUse = generateEnforcementPreToolUseHooks(config.timeout, homeDir);
  }

  // PostToolUse — record edits for session metrics / learning
  if (config.postToolUse) {
    hooks.PostToolUse = [
      {
        matcher: 'Write|Edit|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs post-edit',
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // UserPromptSubmit — intelligent task routing
  if (config.userPromptSubmit) {
    hooks.UserPromptSubmit = [
      {
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs route',
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // SessionStart — restore session state + import auto memory
  if (config.sessionStart) {
    hooks.SessionStart = [
      {
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs session-restore',
            timeout: 15000,
          },
          {
            type: 'command',
            command: 'node .claude/helpers/auto-memory-hook.mjs import',
            timeout: 8000,
          },
        ],
      },
    ];
  }

  // SessionEnd — persist session state
  if (config.sessionStart) {
    hooks.SessionEnd = [
      {
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs session-end',
            timeout: 10000,
          },
        ],
      },
    ];
  }

  // Stop — sync auto memory on exit
  if (config.stop) {
    hooks.Stop = [
      {
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/auto-memory-hook.mjs sync',
            timeout: 10000,
          },
        ],
      },
    ];
  }

  ensureSettingsReconcilerHooks(hooks, homeDir);

  // PreCompact — preserve context before compaction
  if (config.preCompact) {
    hooks.PreCompact = [
      {
        matcher: 'manual',
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs compact-manual',
          },
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs session-end',
            timeout: 5000,
          },
        ],
      },
      {
        matcher: 'auto',
        hooks: [
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs compact-auto',
          },
          {
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs session-end',
            timeout: 6000,
          },
        ],
      },
    ];
  }

  // SubagentStart — status update
  hooks.SubagentStart = [
    {
      hooks: [
        {
          type: 'command',
          command: 'node .claude/helpers/hook-handler.cjs status',
          timeout: 3000,
        },
      ],
    },
  ];

  // NOTE: TeammateIdle and TaskCompleted are NOT valid Claude Code hook events.
  // Their configuration lives in hiveFlow.agentTeams.hooks instead (see generateSettings).

  return hooks;
}

/**
 * Generate settings.json as formatted string
 */
export function generateSettingsJson(options: InitOptions): string {
  const settings = generateSettings(options);
  return JSON.stringify(settings, null, 2);
}
