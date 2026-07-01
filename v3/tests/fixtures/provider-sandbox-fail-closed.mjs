import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  sandboxExec,
} from '../../../cli/packages/providers/scripts/sandbox-runner.mjs';

const root = mkdtempSync(join(tmpdir(), 'hf-provider-sandbox-bats-'));
mkdirSync(join(root, '.claude'), { recursive: true });
mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });

try {
  const result = await sandboxExec([process.execPath, '--version'], {
    projectRoot: root,
    backendOrder: [],
    timeoutMs: 1000,
  });
  process.stdout.write(`${JSON.stringify({
    ok: result.ok,
    status: result.status,
    denyReason: result.denyReason,
    reason: result.diagnostics?.reason,
    verifiedBackend: result.diagnostics?.verifiedBackend ?? null,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
