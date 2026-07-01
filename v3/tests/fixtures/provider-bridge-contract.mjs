import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv[2] || 'all';
const repoRoot = resolve(process.argv[3] || process.cwd());
const bridgePath = join(repoRoot, 'cli', 'packages', 'providers', 'scripts', 'provider-agent-bridge.mjs');

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
  const statePath = join(root, '.hive-flow', 'enforcement', 'state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  }), 'utf8');
}

function decode(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

if (mode !== 'all') {
  throw new Error(`Unknown provider bridge contract fixture mode: ${mode}`);
}

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-provider-bridge-bats-')));
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

  const readPath = join(root, 'src', 'readable.txt');
  writeFileSync(readPath, 'bats bridge read\n', 'utf8');
  const bridge = await import(`${pathToFileURL(bridgePath).href}?bridge_bats=${Date.now()}-${Math.random()}`);

  const readFile = await bridge.executeBridgeFilesystemTool('read_file', { path: readPath });
  const runShellDenied = decode(await bridge.evaluateToolCall(
    'run_shell',
    { argv: ['node', '--version'] },
    { sandboxOptions: { backendOrder: [] } },
  ));
  const webDenied = decode(await bridge.evaluateToolCall(
    'web_fetch',
    { url: 'https://example.invalid/provider-bridge-bats' },
    { webOptions: { allowlist: ['https://fixture.test'] } },
  ));
  const webSearch = decode(await bridge.evaluateToolCall('web_search', { query: 'provider bridge bats' }));

  process.stdout.write(`${JSON.stringify({
    readFile,
    runShellDenied: runShellDenied.denyReason,
    webDenied: webDenied.denyReason,
    webSearch: webSearch.denyReason,
    publicNetwork: false,
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
