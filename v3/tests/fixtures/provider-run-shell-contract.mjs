import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2] || 'fail-closed';
const repoRoot = resolve(process.argv[3] || process.cwd());
const bridgePath = join(repoRoot, 'v3', '@hive-flow', 'providers', 'scripts', 'provider-agent-bridge.mjs');

function writeKey(root, key = randomBytes(32).toString('hex')) {
  const keyPath = join(root, '.hive-flow', 'enforcement', '.hmac-key');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
  return key;
}

function writeEnvelope(root, key, level, restrictedGroups = []) {
  const state = {
    level,
    ts: '2026-06-08T00:00:00.000Z',
    violations: 0,
    restrictedGroups,
    history: [],
    integrityCompromised: false,
  };
  const envelope = {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
  const statePath = join(root, '.hive-flow', 'enforcement', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(envelope), 'utf8');
}

function decode(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

const root = mkdtempSync(join(tmpdir(), 'hf-run-shell-bats-'));
mkdirSync(join(root, '.claude'), { recursive: true });
mkdirSync(join(root, 'src'), { recursive: true });
const key = writeKey(root);
writeEnvelope(root, key, 0);

try {
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.HIVE_FLOW_AGENT_ID = '';
  process.env.CLAUDE_AGENT_ID = '';
  process.env.HIVE_FLOW_HIVE_ID = '';
  delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
  delete process.env.HIVE_FLOW_DEV_OVERRIDE;

  const bridge = await import(`${pathToFileURL(bridgePath).href}?bats=${Date.now()}-${Math.random()}`);
  let result;
  if (mode === 'attack') {
    result = await bridge.evaluateToolCall('run_shell', { command: 'node -e "console.log(1)"' });
  } else if (mode === 'restricted') {
    writeEnvelope(root, key, 0, ['write']);
    result = await bridge.evaluateToolCall('run_shell', { argv: ['node', '--version'] });
  } else {
    result = await bridge.evaluateToolCall(
      'run_shell',
      { argv: ['node', '--version'] },
      { sandboxOptions: { backendOrder: [] } },
    );
  }

  process.stdout.write(`${JSON.stringify(decode(result))}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
