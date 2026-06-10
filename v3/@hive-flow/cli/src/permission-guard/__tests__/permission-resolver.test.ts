import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  loadLayeredPermissionConfig,
  mergePermissionConfigLayers,
  resetPermissionResolverCache,
  resolvePermissionLayerPaths,
} from '../permission-resolver.js';
import type { PermissionConfig } from '../types.js';

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'permission-resolver-'));
}

describe('layered permission resolver', () => {
  it('loads defaults < global config < learned view < project permissions < session grants', () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });

    const env = { HIVE_FLOW_HOME: join(home, '.hive-flow') };
    const sessionInput = { session_id: 'session-123', client_kind: 'claude-code' };
    const paths = resolvePermissionLayerPaths({ env, cwd: project, sessionInput });

    writeJson(paths.globalConfigPath, {
      mcp_default_policy: 'deny',
      always_allow_tools: ['GlobalTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/global-grant'],
      notifications: { enabled: true },
    });
    mkdirSync(join(paths.learnedRulesPath, '..'), { recursive: true });
    writeFileSync(paths.learnedRulesPath, [
      JSON.stringify({ config: { always_allow_tools: ['LearnedTool'] } }),
      JSON.stringify({ always_allow_bash_patterns: ['^learned-safe$'] }),
    ].join('\n'));
    writeJson(paths.projectConfigPath, {
      mcp_default_policy: 'escalate',
      always_allow_tools: ['ProjectTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/project-grant'],
      notifications: { on_deny: true },
    });
    writeJson(paths.sessionGrantsPath, {
      mcp_default_policy: 'allow',
      always_allow_tools: ['SessionTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/session-grant'],
      log_file: '${HOME}/permission-log.jsonl',
      notifications: { on_escalation: true },
    });

    resetPermissionResolverCache();
    const config = loadLayeredPermissionConfig({ env, cwd: project, sessionInput });

    expect(config.mcp_default_policy).toBe('allow');
    expect(config.log_file).toBe('${HOME}/permission-log.jsonl');
    expect(config.notifications).toEqual({
      enabled: true,
      on_deny: true,
      on_escalation: true,
    });
    expect(config.always_allow_tools).toEqual(
      expect.arrayContaining(['Read', 'GlobalTool', 'LearnedTool', 'ProjectTool', 'SessionTool']),
    );
    expect(config.always_allow_bash_patterns).toEqual(expect.arrayContaining(['^learned-safe$']));
    expect(config.allowed_write_paths).toEqual(expect.arrayContaining([
      '${PROJECT_ROOT}/global-grant',
      '${PROJECT_ROOT}/project-grant',
      '${PROJECT_ROOT}/session-grant',
    ]));
  });

  it('keeps default hard-floor deny patterns when later layers try to clear deny arrays', () => {
    const config = mergePermissionConfigLayers([
      { always_deny_bash_patterns: [] },
      { always_deny_bash_patterns: [] },
    ]);

    expect(config.always_deny_bash_patterns.some((entry) => {
      return typeof entry === 'object' && 'pattern' in entry && entry.pattern.includes('git\\s+reset\\s+--hard');
    })).toBe(true);
    expect(config.always_deny_bash_patterns.some((entry) => {
      return typeof entry === 'object' && 'pattern' in entry && entry.pattern.includes('rm\\s+.*');
    })).toBe(true);
  });

  it('ignores malformed layer files instead of failing closed or overblocking', () => {
    const root = tempRoot();
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(project, { recursive: true });

    const env = { HIVE_FLOW_HOME: join(home, '.hive-flow') };
    const paths = resolvePermissionLayerPaths({ env, cwd: project, sessionInput: 'malformed-session' });
    mkdirSync(join(paths.globalConfigPath, '..'), { recursive: true });
    writeFileSync(paths.globalConfigPath, '{ not json');
    mkdirSync(join(paths.projectConfigPath, '..'), { recursive: true });
    writeFileSync(paths.projectConfigPath, '{ also not json');

    resetPermissionResolverCache();
    const config = loadLayeredPermissionConfig({ env, cwd: project, sessionInput: 'malformed-session' });

    expect(config.always_allow_tools).toContain('Read');
    expect(config.mcp_default_policy).toBe('allow');
  });

  it('property-checks additive allow-tool layers preserve every grant without duplicates', () => {
    const token = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,12}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(token, { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(token, { minLength: 1, maxLength: 5 }),
        fc.uniqueArray(token, { minLength: 1, maxLength: 5 }),
        (globalTools, projectTools, sessionTools) => {
          const config = mergePermissionConfigLayers([
            { always_allow_tools: globalTools },
            { always_allow_tools: projectTools },
            { always_allow_tools: sessionTools },
          ]);
          const expected = new Set(['Read', ...globalTools, ...projectTools, ...sessionTools]);
          for (const tool of expected) {
            expect(config.always_allow_tools).toContain(tool);
          }
          expect(new Set(config.always_allow_tools).size).toBe(config.always_allow_tools.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('permission layer path resolution', () => {
  it('uses the accepted Hive home resolver and project-namespaced session grant path', () => {
    const root = tempRoot();
    const hiveHome = join(root, 'hf-home');
    const project = join(root, 'project');
    const paths = resolvePermissionLayerPaths({
      env: { HIVE_FLOW_HOME: hiveHome },
      cwd: project,
      sessionInput: { session_id: 'abc', client_kind: 'codex' },
    });

    expect(paths.hiveHome).toBe(hiveHome);
    expect(paths.globalConfigPath).toBe(join(hiveHome, 'permission-guard', 'config.json'));
    expect(paths.learnedRulesPath).toBe(join(hiveHome, 'permission-guard', 'learned-rules.jsonl'));
    expect(paths.projectConfigPath).toBe(join(project, '.hive-flow', 'permissions.json'));
    expect(paths.sessionGrantsPath).toMatch(
      new RegExp(`^${join(hiveHome, 'permission-guard', 'sessions').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/s_[a-f0-9]{32}/grants\\.json$`),
    );
  });
});
