import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holderMocks = vi.hoisted(() => ({
  stop: vi.fn(async () => undefined),
  bootstrapProductionCredentialHolder: vi.fn(async () => ({
    socketPath: '/tmp/hive-flow-daemon-holder.sock',
    seededProviders: ['openrouter'],
    backendStatus: { available: true },
    stop: holderMocks.stop,
  })),
}));

vi.mock('../../credential-store/holder-runtime.js', () => ({
  bootstrapProductionCredentialHolder: holderMocks.bootstrapProductionCredentialHolder,
}));

import { WorkerDaemon } from '../worker-daemon.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hive-flow-daemon-holder-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkerDaemon credential holder bootstrap', () => {
  it('starts the production credential holder runtime and stops it with the daemon', async () => {
    const root = makeRoot();
    const daemon = new WorkerDaemon(root, { workers: [] });

    await daemon.start();

    expect(holderMocks.bootstrapProductionCredentialHolder).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: root,
    }));

    await daemon.stop();
    expect(holderMocks.stop).toHaveBeenCalledTimes(1);
  });
});
