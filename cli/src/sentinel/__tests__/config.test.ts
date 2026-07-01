import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadSentinelConfig,
  resolveSentinelConfigPath,
  SentinelConfigError,
} from '../config.js';

describe('sentinel config parsing and path resolution', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hive-flow-sentinel-config-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('resolves the default project config path from cwd', () => {
    expect(resolveSentinelConfigPath(cwd)).toBe(join(cwd, '.hive-flow', 'config.yaml'));
  });

  it('resolves relative explicit config paths against cwd', () => {
    expect(resolveSentinelConfigPath(cwd, 'config/hive-flow.yaml')).toBe(
      resolve(cwd, 'config/hive-flow.yaml'),
    );
  });

  it('loads valid nested YAML config values', () => {
    const configPath = join(cwd, 'valid.yaml');
    writeFileSync(
      configPath,
      [
        'swarm:',
        '  topology: mesh',
        '  maxAgents: 4',
        '  autoScale: false',
        'mcp:',
        '  autoStart: false',
        '  serverPort: 3010',
        '  transportType: "stdio"',
      ].join('\n'),
    );

    expect(loadSentinelConfig(cwd, configPath)).toEqual({
      config: {
        swarm: {
          topology: 'mesh',
          maxAgents: 4,
          autoScale: false,
        },
        mcp: {
          autoStart: false,
          serverPort: 3010,
          transportType: 'stdio',
        },
      },
      path: configPath,
    });
  });

  it('throws an actionable error for a missing config', () => {
    const missingPath = join(cwd, 'missing.yaml');

    expect(() => loadSentinelConfig(cwd, missingPath)).toThrow(SentinelConfigError);
    expect(() => loadSentinelConfig(cwd, missingPath)).toThrow(
      `Hive Flow config not found: ${missingPath}`,
    );
  });

  it('throws an actionable error for corrupt config syntax', () => {
    const configPath = join(cwd, 'corrupt.yaml');
    writeFileSync(configPath, 'swarm:\n  topology: "mesh\n');

    expect(() => loadSentinelConfig(cwd, configPath)).toThrow(SentinelConfigError);
    expect(() => loadSentinelConfig(cwd, configPath)).toThrow(
      /Invalid Hive Flow config .*unterminated quoted string/,
    );
  });

  it('throws an actionable error when the config root is not an object', () => {
    const configPath = join(cwd, 'scalar.yaml');
    writeFileSync(configPath, '"mesh"');

    expect(() => loadSentinelConfig(cwd, configPath)).toThrow(
      /Invalid Hive Flow config .*expected a YAML object/,
    );
  });
});
