import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ───────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { systemTools } from '../mcp-tools/system-tools.js';
import { configTools } from '../mcp-tools/config-tools.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface SystemMetrics {
  startTime: string;
  lastCheck: string;
  uptime: number;
  health: number;
  cpu: number;
  memory: { used: number; total: number };
  agents: { active: number; total: number };
  tasks: { pending: number; completed: number; failed: number };
  requests: { total: number; success: number; errors: number };
}

interface ConfigStore {
  values: Record<string, unknown>;
  scopes: Record<string, Record<string, unknown>>;
  version: string;
  updatedAt: string;
}

const statusTool = systemTools.find((t) => t.name === 'system_status')!;
const metricsTool = systemTools.find((t) => t.name === 'system_metrics')!;
const healthTool = systemTools.find((t) => t.name === 'system_health')!;
const infoTool = systemTools.find((t) => t.name === 'system_info')!;
const resetTool = systemTools.find((t) => t.name === 'system_reset')!;
const mcpStatusTool = systemTools.find((t) => t.name === 'mcp_status')!;
const taskSummaryTool = systemTools.find((t) => t.name === 'task_summary')!;

const configGetTool = configTools.find((t) => t.name === 'config_get')!;
const configSetTool = configTools.find((t) => t.name === 'config_set')!;
const configListTool = configTools.find((t) => t.name === 'config_list')!;
const configResetTool = configTools.find((t) => t.name === 'config_reset')!;
const configExportTool = configTools.find((t) => t.name === 'config_export')!;
const configImportTool = configTools.find((t) => t.name === 'config_import')!;

function defaultMetrics(): SystemMetrics {
  return {
    startTime: new Date(Date.now() - 3600000).toISOString(),
    lastCheck: new Date().toISOString(),
    uptime: 3600000,
    health: 1.0,
    cpu: 25,
    memory: { used: 256, total: 1024 },
    agents: { active: 2, total: 5 },
    tasks: { pending: 1, completed: 10, failed: 0 },
    requests: { total: 100, success: 95, errors: 5 },
  };
}

/**
 * Set up fs mocks that route reads/writes through a dynamic store.
 * Supports both system metrics (metrics.json) and config (config.json).
 */
function setupSystemMocks(metrics?: SystemMetrics) {
  let currentMetrics = JSON.parse(JSON.stringify(metrics || defaultMetrics()));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('metrics.json')) return true;
    if (typeof p === 'string' && p.endsWith('store.json')) return false;
    if (typeof p === 'string' && p.endsWith('package.json')) return false;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('metrics.json')) {
      return JSON.stringify(currentMetrics);
    }
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      try {
        currentMetrics = JSON.parse(data);
      } catch {
        // non-JSON
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedMetrics: () => currentMetrics as SystemMetrics,
  };
}

function setupConfigMocks(initialStore?: ConfigStore) {
  let currentStore = JSON.parse(JSON.stringify(initialStore || {
    values: { 'swarm.topology': 'mesh', 'swarm.maxAgents': 10 },
    scopes: {},
    version: '3.0.0',
    updatedAt: new Date().toISOString(),
  }));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('config.json')) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('config.json')) {
      return JSON.stringify(currentStore);
    }
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      try {
        currentStore = JSON.parse(data);
      } catch {
        // non-JSON
      }
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (renameSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as ConfigStore,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('system-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // Tool registration
  // ========================================================================

  describe('tool registration', () => {
    it('exports all expected system tools', () => {
      const names = systemTools.map((t) => t.name);
      expect(names).toContain('system_status');
      expect(names).toContain('system_metrics');
      expect(names).toContain('system_health');
      expect(names).toContain('system_info');
      expect(names).toContain('system_reset');
      expect(names).toContain('mcp_status');
      expect(names).toContain('task_summary');
    });
  });

  // ========================================================================
  // system_status
  // ========================================================================

  describe('system_status', () => {
    it('returns healthy status when health >= 0.8', async () => {
      setupSystemMocks();

      const result = (await statusTool.handler({})) as Record<string, unknown>;

      expect(result.status).toBe('healthy');
      expect(result.version).toBeDefined();
      expect(result.uptime).toBeGreaterThan(0);
      expect(result.components).toBeDefined();
    });

    it('returns degraded status when health is between 0.5 and 0.8', async () => {
      setupSystemMocks({ ...defaultMetrics(), health: 0.6 });

      const result = (await statusTool.handler({})) as Record<string, unknown>;

      expect(result.status).toBe('degraded');
    });

    it('returns unhealthy status when health < 0.5', async () => {
      setupSystemMocks({ ...defaultMetrics(), health: 0.3 });

      const result = (await statusTool.handler({})) as Record<string, unknown>;

      expect(result.status).toBe('unhealthy');
    });

    it('includes metrics when verbose=true', async () => {
      setupSystemMocks();

      const result = (await statusTool.handler({ verbose: true })) as Record<string, unknown>;

      expect(result.metrics).toBeDefined();
      const metrics = result.metrics as Record<string, unknown>;
      expect(metrics).toHaveProperty('cpu');
      expect(metrics).toHaveProperty('memory');
      expect(metrics).toHaveProperty('agents');
      expect(metrics).toHaveProperty('tasks');
    });
  });

  // ========================================================================
  // system_metrics
  // ========================================================================

  describe('system_metrics', () => {
    it('returns all metrics with real system data', async () => {
      setupSystemMocks();

      const result = (await metricsTool.handler({ category: 'all' })) as Record<string, unknown>;

      expect(result._real).toBe(true);
      expect(result.heap).toBeDefined();
      expect(result.loadAverage).toBeDefined();
      expect(result.cpuCores).toBeGreaterThan(0);
    });

    it('returns specific category metrics', async () => {
      setupSystemMocks();

      const result = (await metricsTool.handler({ category: 'cpu' })) as Record<string, unknown>;

      expect(result._real).toBe(true);
      expect(result.cores).toBeGreaterThan(0);
    });

    it('returns memory metrics', async () => {
      setupSystemMocks();

      const result = (await metricsTool.handler({ category: 'memory' })) as Record<string, unknown>;

      expect(result._real).toBe(true);
      expect(result.heap).toBeDefined();
    });

    it('defaults category to all', async () => {
      setupSystemMocks();

      const result = (await metricsTool.handler({})) as Record<string, unknown>;

      expect(result._real).toBe(true);
      expect(result.heap).toBeDefined();
    });
  });

  // ========================================================================
  // system_health
  // ========================================================================

  describe('system_health', () => {
    it('returns basic health check', async () => {
      setupSystemMocks();

      const result = (await healthTool.handler({})) as Record<string, unknown>;

      expect(result.overall).toBe('healthy');
      expect(result.score).toBe(100);
      expect(Array.isArray(result.checks)).toBe(true);
      expect(result.healthy).toBe(result.total);
    });

    it('returns more checks when deep=true', async () => {
      setupSystemMocks();

      const shallow = (await healthTool.handler({})) as Record<string, unknown>;
      const deep = (await healthTool.handler({ deep: true })) as Record<string, unknown>;

      expect((deep.total as number)).toBeGreaterThan(shallow.total as number);
    });

    it('reports issues for degraded components', async () => {
      setupSystemMocks({ ...defaultMetrics(), health: 0.5 });

      const result = (await healthTool.handler({})) as Record<string, unknown>;

      // Neural component uses metrics.health threshold
      expect(result.issues).toBeDefined();
    });
  });

  // ========================================================================
  // system_info
  // ========================================================================

  describe('system_info', () => {
    it('returns system information', async () => {
      const result = (await infoTool.handler({})) as Record<string, unknown>;

      expect(result.version).toBeDefined();
      expect(result.nodeVersion).toBe(process.version);
      expect(result.platform).toBe(process.platform);
      expect(result.arch).toBe(process.arch);
      expect(result.pid).toBe(process.pid);
      expect(result.features).toBeDefined();
      expect(result.limits).toBeDefined();
    });
  });

  // ========================================================================
  // system_reset
  // ========================================================================

  describe('system_reset', () => {
    it('returns error when confirm is false', async () => {
      setupSystemMocks();

      const result = (await resetTool.handler({ confirm: false })) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/confirmation/i);
    });

    it('resets metrics when confirmed', async () => {
      const { getPersistedMetrics } = setupSystemMocks();

      const result = (await resetTool.handler({ confirm: true })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.resetAt).toBeDefined();

      const metrics = getPersistedMetrics();
      expect(metrics.health).toBe(1.0);
      expect(metrics.agents.active).toBe(0);
    });

    it('uses specified component', async () => {
      setupSystemMocks();

      const result = (await resetTool.handler({ confirm: true, component: 'agents' })) as Record<string, unknown>;

      expect(result.component).toBe('agents');
    });
  });

  // ========================================================================
  // mcp_status
  // ========================================================================

  describe('mcp_status', () => {
    it('returns MCP server status', async () => {
      const result = (await mcpStatusTool.handler({})) as Record<string, unknown>;

      expect(result).toHaveProperty('running');
      expect(result).toHaveProperty('transport');
      expect(result.pid).toBe(process.pid);
    });
  });

  // ========================================================================
  // task_summary
  // ========================================================================

  describe('task_summary', () => {
    it('returns empty summary when no store exists', async () => {
      setupSystemMocks();

      const result = (await taskSummaryTool.handler({})) as Record<string, unknown>;

      expect(result.total).toBe(0);
      expect(result.pending).toBe(0);
      expect(result.completed).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// config-tools
// ══════════════════════════════════════════════════════════════════════════════

describe('config-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // Tool registration
  // ========================================================================

  describe('tool registration', () => {
    it('exports all expected config tools', () => {
      const names = configTools.map((t) => t.name);
      expect(names).toContain('config_get');
      expect(names).toContain('config_set');
      expect(names).toContain('config_list');
      expect(names).toContain('config_reset');
      expect(names).toContain('config_export');
      expect(names).toContain('config_import');
    });

    it('all tools have category "config"', () => {
      for (const tool of configTools) {
        expect(tool.category).toBe('config');
      }
    });
  });

  // ========================================================================
  // config_get
  // ========================================================================

  describe('config_get', () => {
    it('returns stored value', async () => {
      setupConfigMocks();

      const result = (await configGetTool.handler({ key: 'swarm.topology' })) as Record<string, unknown>;

      expect(result.key).toBe('swarm.topology');
      expect(result.value).toBe('mesh');
      expect(result.exists).toBe(true);
    });

    it('returns default value when key not in store', async () => {
      setupConfigMocks({
        values: {},
        scopes: {},
        version: '3.0.0',
        updatedAt: new Date().toISOString(),
      });

      const result = (await configGetTool.handler({ key: 'logging.level' })) as Record<string, unknown>;

      expect(result.value).toBe('info');
      expect(result.exists).toBe(true);
      expect(result.source).toBe('default');
    });

    it('returns undefined for nonexistent key', async () => {
      setupConfigMocks({
        values: {},
        scopes: {},
        version: '3.0.0',
        updatedAt: new Date().toISOString(),
      });

      const result = (await configGetTool.handler({ key: 'nonexistent.key' })) as Record<string, unknown>;

      expect(result.exists).toBe(false);
    });

    it('checks scope-specific values first', async () => {
      setupConfigMocks({
        values: { 'key': 'default-val' },
        scopes: { 'project': { 'key': 'scoped-val' } },
        version: '3.0.0',
        updatedAt: new Date().toISOString(),
      });

      const result = (await configGetTool.handler({ key: 'key', scope: 'project' })) as Record<string, unknown>;

      expect(result.value).toBe('scoped-val');
    });
  });

  // ========================================================================
  // config_set
  // ========================================================================

  describe('config_set', () => {
    it('sets a configuration value', async () => {
      const { getPersistedStore } = setupConfigMocks();

      const result = (await configSetTool.handler({
        key: 'swarm.topology',
        value: 'hierarchical',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.key).toBe('swarm.topology');
      expect(result.value).toBe('hierarchical');
      expect(result.previousValue).toBe('mesh');

      const store = getPersistedStore();
      expect(store.values['swarm.topology']).toBe('hierarchical');
    });

    it('sets a scoped configuration value', async () => {
      const { getPersistedStore } = setupConfigMocks();

      const result = (await configSetTool.handler({
        key: 'custom.key',
        value: 42,
        scope: 'project',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.scope).toBe('project');

      const store = getPersistedStore();
      expect(store.scopes['project']['custom.key']).toBe(42);
    });
  });

  // ========================================================================
  // config_list
  // ========================================================================

  describe('config_list', () => {
    it('lists all configs including defaults', async () => {
      setupConfigMocks();

      const result = (await configListTool.handler({})) as Record<string, unknown>;

      expect(result.total).toBeGreaterThan(0);
      expect(Array.isArray(result.configs)).toBe(true);
    });

    it('filters by prefix', async () => {
      setupConfigMocks();

      const result = (await configListTool.handler({ prefix: 'swarm.' })) as Record<string, unknown>;

      const configs = result.configs as Array<{ key: string }>;
      for (const c of configs) {
        expect(c.key.startsWith('swarm.')).toBe(true);
      }
    });
  });

  // ========================================================================
  // config_reset
  // ========================================================================

  describe('config_reset', () => {
    it('resets a specific key', async () => {
      const { getPersistedStore } = setupConfigMocks();

      const result = (await configResetTool.handler({ key: 'swarm.topology' })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
    });

    it('resets all keys in default scope', async () => {
      setupConfigMocks();

      const result = (await configResetTool.handler({})) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.reset).toBe('all');
      expect((result.count as number)).toBeGreaterThan(0);
    });
  });

  // ========================================================================
  // config_export
  // ========================================================================

  describe('config_export', () => {
    it('exports configuration with defaults', async () => {
      setupConfigMocks();

      const result = (await configExportTool.handler({})) as Record<string, unknown>;

      expect(result.config).toBeDefined();
      expect(result.exportedAt).toBeDefined();
      expect(result.count).toBeGreaterThan(0);
    });

    it('exports without defaults when includeDefaults=false', async () => {
      setupConfigMocks();

      const result = (await configExportTool.handler({ includeDefaults: false })) as Record<string, unknown>;

      // Should only contain stored values, not merged defaults
      expect(result.config).toBeDefined();
    });
  });

  // ========================================================================
  // config_import
  // ========================================================================

  describe('config_import', () => {
    it('imports configuration (merge mode)', async () => {
      const { getPersistedStore } = setupConfigMocks();

      const result = (await configImportTool.handler({
        config: { 'new.key': 'new-value', 'swarm.topology': 'ring' },
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.merge).toBe(true);

      const store = getPersistedStore();
      expect(store.values['new.key']).toBe('new-value');
      expect(store.values['swarm.topology']).toBe('ring');
      // Original key preserved (merge)
      expect(store.values['swarm.maxAgents']).toBe(10);
    });

    it('imports to a specific scope', async () => {
      const { getPersistedStore } = setupConfigMocks();

      const result = (await configImportTool.handler({
        config: { 'custom.setting': true },
        scope: 'user',
      })) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(result.scope).toBe('user');

      const store = getPersistedStore();
      expect(store.scopes['user']['custom.setting']).toBe(true);
    });
  });
});
