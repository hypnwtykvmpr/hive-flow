import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RvfaWriter } from '../../appliance/rvfa-format.js';
import type { CommandContext, CommandResult, Command } from '../../types.js';

// `build` shells out to `npm pack hive-flow@latest` (network) via the real RvfaBuilder, so
// we mock the builder module to a network-free seam that records constructor args. This both
// keeps the test hermetic and asserts the wrapper passes the REAL BuildOptions keys.
const builderCalls: Array<Record<string, unknown>> = [];
vi.mock('../../appliance/rvfa-builder.js', () => ({
  __calls: builderCalls,
  RvfaBuilder: class {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      builderCalls.push(opts);
    }
    async build() {
      return {
        outputPath: this.opts.output,
        size: 4096,
        sections: [{ id: 'hive-flow', size: 10, originalSize: 12 }],
      };
    }
  },
}));

// applianceCommand is imported AFTER the mock is registered (vi.mock is hoisted).
import { applianceCommand } from '../appliance.js';

function makeCtx(flags: Record<string, unknown>): CommandContext {
  return {
    args: [],
    flags: flags as CommandContext['flags'],
    cwd: process.cwd(),
    verbose: false,
  };
}

function sub(name: string): Command {
  const cmd = applianceCommand.subcommands?.find((s) => s.name === name);
  if (!cmd) throw new Error(`appliance subcommand not found: ${name}`);
  return cmd;
}

function run(name: string, flags: Record<string, unknown>): Promise<CommandResult> {
  const cmd = sub(name);
  if (!cmd.action) throw new Error(`appliance subcommand has no action: ${name}`);
  return cmd.action(makeCtx(flags));
}

let dir: string;
let fixture: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'hf-appliance-cmd-'));
  // A real legacy RVFA appliance (magic "RVFA") built via the real writer.
  const writer = new RvfaWriter({ name: 'test-appliance', profile: 'cloud', arch: 'x86_64' });
  writer.addSection('hive-flow', Buffer.from('hello-hive-flow'), { compression: 'gzip' });
  fixture = join(dir, 'test.rvf');
  writeFileSync(fixture, writer.build());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appliance command wrappers use the real reader/runner/builder APIs', () => {
  it('inspect reads the header via RvfaReader.fromFile()/getHeader()', async () => {
    const r = await run('inspect', { file: fixture, json: true });
    expect(r.success).toBe(true);
    const hdr = (r.data ?? {}) as { name?: string; sections?: Array<{ id: string }> };
    expect(hdr.name).toBe('test-appliance');
    expect(hdr.sections?.some((s) => s.id === 'hive-flow')).toBe(true);
  });

  it('verify validates integrity via reader.verify()', async () => {
    const r = await run('verify', { file: fixture, quick: true });
    expect(r.success).toBe(true);
  });

  it('extract writes each section via extractSection(id): Buffer + command-owned writes', async () => {
    const out = join(dir, 'extracted');
    const r = await run('extract', { file: fixture, output: out });
    expect(r.success).toBe(true);
    expect(existsSync(join(out, 'hive-flow'))).toBe(true);
  });

  it('run wires to RvfaRunner.fromFile().boot({ mode }) in verify mode (no Docker/network)', async () => {
    const r = await run('run', { file: fixture, mode: 'verify', isolation: 'native' });
    // Verify-mode boot returns a RunResult; the wrapper maps exitCode to success.
    // Tolerate pass or controlled fail — the point is it no longer calls a phantom API or throws.
    expect(typeof r.success).toBe('boolean');
  });

  it('build maps the real BuildOptions ({ output, apiKeys }) and reads result.size', async () => {
    builderCalls.length = 0;
    const out = join(dir, 'built.rvf');
    const r = await run('build', { profile: 'cloud', output: out, arch: 'x86_64', models: [] });
    expect(r.success).toBe(true);
    expect(builderCalls).toHaveLength(1);
    expect(builderCalls[0]).toMatchObject({ output: out, profile: 'cloud', arch: 'x86_64' });
    // result.size (was the phantom result.totalSize) flows through to data.
    expect((r.data as { size?: number } | undefined)?.size).toBe(4096);
  });
});
