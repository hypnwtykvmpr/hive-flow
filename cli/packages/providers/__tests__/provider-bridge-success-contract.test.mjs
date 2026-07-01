// Phase 3 Slice A — "success contract" tests for provider-agent-bridge.mjs.
//
// Failed/non-success tool results must NOT count as grounded success, and
// malformed provider tool-calls must not hard-abort. Findings:
//  HF-8  : edit_file failure returns must be structured + non-grounding.
//  HF-11 : web_fetch non-2xx must not count as grounded success (JS half).
//  HF-16 : malformed response.toolCalls[] entries must be rejected/normalized
//          to a structured failure WITHOUT TypeError / hard-abort.
//  + run_command / run_shell exit-code sibling: nonzero exit / timeout must
//    not classify as grounded success.
//
// isSuccessfulBridgeToolResult is the shared grounding chokepoint: making it
// status-specific + evidence-specific fixes criteria 1-4 in one place.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { createHmac, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const bridgeSource = (await import('node:fs')).readFileSync(bridgePath, 'utf8');

// HTTPS fixture cert/key reused from provider-bridge-web.test.mjs (self-signed,
// CN=fixture.test). Only used by the non-2xx web_fetch test.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDVN65XxaWRydAf
L3jOxbaf6sF3+8PQSwwgitxqrjoYiv+7rxkBXjB5j1Foldgc0oNBXxT+rlQMCIaU
sU93uBYuzQdYt8uNbEbqPP/UdZom4yMaYe7OgXdCTTT0Pwe5fGrw6ijjYgDQ5dSR
SVXzO6sphuE3qeYm8jOiRm5lldq59Jyd+gyTGA5IwTguGAG+awxQ0K652hgCiVW6
aWtt4CSSRgpvTAfSJd/6FaZBe5La6am3T9KbgQJ6VwUMcdyj7Dz0snhr4E+5gKkK
nmv3M3LBon00TL9g55y6+54ZuRPOxh8Jv7cyq62zULvQ6HSJLS94fARtwTmFzxZb
dfqqBgfHAgMBAAECggEACAyEDlgtueUucB7wpo2cKUlJaGgeqjxLBud3DqfpFYgZ
w1IG1aBioBQi9JnDgMMJpWwbdMnL7nBb9D0FTPWsELQ4tMarbnlJ7AnFdpXB7fnh
F1vfEfidMemMODQw7HWf69xLEtpeQYSLk7h7ACWefoDS+7D0OUAnZtbV0AvqJ97c
Z2+92HUz2ZZxDyU80MNkvv8mN2aT++rfMBj/Tw2j3OJUP2ooDVrsld4fLsYl9TKN
0eGVXEJSeq2+lIr1nCUKfZoIhQ52vLPL2rp9GwFsTMTEEOh3UIWT1Ja8hne22NFB
pZR4VSk2u+Q4lX3wHwYnl8UIMer6B8gESqpBTVFJMQKBgQD3lg2kJM8i7BMlqEi8
oMvKau+Qzs8QDALJw+rGExiP++yffQ5/GSYY25J+hc3eEh8j5JKNe5VnAB3APjVt
wwuEn111WrLbxvfrstIuk0ZbAi2MPZxsMqbFaSAn1w4hlVk8sc6G+IHPoH6emUsa
OceavVtKPwkScbEzQecexu8mvQKBgQDcdqC82MG/aAg8k6UORfTHjHyeledKwd8C
CEYAnYbqoA5iR+B18MZ1SoUdtOsYZWaqnZ1FWRJwHu9Bq+37feMjQtvurEo9mvAo
fW15C4C4vKf43I7Gjs7GICFL6uUrs7kzltfzAetg9b+la+tp8GCM3+aTzEu3Cfig
zfbAnRQi0wKBgQCVACArhd+G485OHm3P33Fl219bpaqlvKS86oRTOlDQ7kskXK2p
vefYk+Qg8sPHft5wynGMZjCusTo2ZPngmb5HzWUAaFo1vBOeLJsjXoy73p6sxLNr
xjvpmG+6qkkd2vS+ez+QqOPuoWcyaYzyNo2yyXy0PSVnjTaYY3QFaLGqfQKBgQC5
gVQlM1pr3XS4zB9hkDm0wyCFLGuPOuyUQDPvBp3kxML1rbdQZkYHoam64mXDhGdL
/w27sYRTNaRqpOm96SJ7pCF9hhl+FuYnm8rGxIgOaigIvkWhC78vdQ+vWrp0+GhI
4Y9aGe5eCsq0vcc7wBjt0OSqzoeTP9+mJ0iOsF2mIwKBgQCxF+XZ2pWhpxpVUvx3
e3CTOZ4bzZmbdn5exOvi53uFlgBH3whw7UlBxH72n/zyh1FwKJe/Ze9r8gAQLXGW
d41GYLJT5t0STNPIhqJqqwZd2cV5yvJsjZpDR4Vz08dtHkxb7I0yCB8SZfWw3R6X
QJAiFDKi5JT6XNLeMCkYGlODVA==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUUQrQAkLdTHTw+Z4c/R8GfWjwA7UwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMZml4dHVyZS50ZXN0MB4XDTI2MDYwODA0NDMyMVoXDTI2
MDYwOTA0NDMyMVowFzEVMBMGA1UEAwwMZml4dHVyZS50ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1TeuV8WlkcnQHy94zsW2n+rBd/vD0EsMIIrc
aq46GIr/u68ZAV4weY9RaJXYHNKDQV8U/q5UDAiGlLFPd7gWLs0HWLfLjWxG6jz/
1HWaJuMjGmHuzoF3Qk009D8HuXxq8Ooo42IA0OXUkUlV8zurKYbhN6nmJvIzokZu
ZZXaufScnfoMkxgOSME4LhgBvmsMUNCuudoYAolVumlrbeAkkkYKb0wH0iXf+hWm
QXuS2umpt0/Sm4ECelcFDHHco+w89LJ4a+BPuYCpCp5r9zNywaJ9NEy/YOecuvue
GbkTzsYfCb+3Mquts1C70Oh0iS0veHwEbcE5hc8WW3X6qgYHxwIDAQABo1MwUTAd
BgNVHQ4EFgQUILqepvTnMBPhNOML5kMoOpRynrswHwYDVR0jBBgwFoAUILqepvTn
MBPhNOML5kMoOpRynrswDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAIF8VXKEWaW17XrDvTEJyl8ykQLO7g1ZZuhtQo4gWZ1HeO2pNVA6ULxMFXqQd
FG8fJpgac++DX4wGpFOK5poNR45IpfCK4XlZy7rxtDvx14QTwUJUheIBPAkEtpcV
YyY/ufJ7X6qyrN68Woqm1lcYdQVTBEKUOexq+Rhz+4fOs00+KdCtOs6Jq69Wv0UK
lIYrNL51lI64xhD8OQAdjsWeN3S6pr2j9NsC7rn8AMj87GU/bMOIcTMFpeQbkbmS
ryhWG6u0bMB5aJBy9Uymu1eDDgG80NXxEzfJfFeb4dv4VPVJl6RP2W/vqDZBGDcg
ZYSgT8UURlLqP06Iq5eAxcQoDw==
-----END CERTIFICATE-----`;

const previousEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  HIVE_FLOW_AGENT_ID: process.env.HIVE_FLOW_AGENT_ID,
  CLAUDE_AGENT_ID: process.env.CLAUDE_AGENT_ID,
  HIVE_FLOW_HIVE_ID: process.env.HIVE_FLOW_HIVE_ID,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

function makeProjectRoot(prefix = 'hf-success-contract-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  return realpathSync.native(root);
}

function writeKey(root, key = randomBytes(32).toString('hex')) {
  const keyPath = join(root, '.hive-flow', 'enforcement', '.hmac-key');
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
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
  writeFileSync(statePath, JSON.stringify(envelope, null, 2), 'utf8');
}

async function importBridgeForRoot(root) {
  const previousCwd = process.cwd();
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  process.chdir(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.HIVE_FLOW_AGENT_ID = '';
  process.env.CLAUDE_AGENT_ID = '';
  process.env.HIVE_FLOW_HIVE_ID = '';
  try {
    return await import(`${pathToFileURL(bridgePath).href}?success-contract=${Date.now()}-${Math.random()}`);
  } finally {
    process.chdir(previousCwd);
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
}

async function makeBridge(level = 0, restrictedGroups = []) {
  const root = makeProjectRoot();
  const key = writeKey(root);
  writeEnvelope(root, key, level, restrictedGroups);
  const bridge = await importBridgeForRoot(root);
  return { root, bridge };
}

function decodeToolResult(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

async function startHttpsFixture() {
  const server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello fixture');
      return;
    }
    if (req.url === '/boom') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error body');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    }),
  };
}

function fixtureWebOptions(fixture, extra = {}) {
  return {
    allowlist: [`https://fixture.test:${fixture.port}`],
    allowInsecureTls: true,
    allowPrivateFixtureIPs: true,
    maxBytes: 64,
    resolveHost: async (hostname) =>
      hostname === 'fixture.test' ? [{ address: '127.0.0.1', family: 4 }] : [],
    ...extra,
  };
}

let pureBridge;
beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  try {
    pureBridge = await import(`${pathToFileURL(bridgePath).href}?sc-pure=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
});

afterEach(() => {
  restoreEnv();
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 4 — isSuccessfulBridgeToolResult is status-specific + evidence-specific
// ───────────────────────────────────────────────────────────────────────────
describe('isSuccessfulBridgeToolResult: status-specific + evidence-specific (criterion 4)', () => {
  it('does NOT treat an arbitrary non-denied/non-error object as success', () => {
    // The old contract returned true for ANY object whose status was not
    // denied/error. A bespoke status the bridge never emits must not ground.
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'whatever', foo: 1 })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ foo: 'bar' })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'pending' })).toBe(false);
  });

  it('does NOT treat a stringified arbitrary-status object as success', () => {
    const arbitrary = JSON.stringify({ status: 'queued', detail: 'later' });
    expect(pureBridge.isSuccessfulBridgeToolResult(arbitrary)).toBe(false);
  });

  it('treats genuine-success statuses (executed/fetched/searched) WITH evidence as success', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: 0, timedOut: false })).toBe(true);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'fetched', httpStatus: 200 })).toBe(true);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'searched', httpStatus: 200, results: [] })).toBe(true);
  });

  // ── run_command / run_shell exit-code sibling (criterion 3) ──
  it('does NOT count an executed result with a nonzero exit code', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: 1, timedOut: false })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: 127, timedOut: false })).toBe(false);
  });

  it('does NOT count an executed result that timed out', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: 0, timedOut: true })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: null, timedOut: true })).toBe(false);
  });

  it('does NOT count an executed result with a null exit code (execution failure)', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'executed', exitCode: null, timedOut: false })).toBe(false);
  });

  // ── web_fetch non-2xx (criterion 2, HF-11) ──
  it('does NOT count a fetched result with a non-2xx httpStatus', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'fetched', httpStatus: 404 })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'fetched', httpStatus: 500 })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'fetched', httpStatus: 301 })).toBe(false);
  });

  it('preserves existing positives: plain string + {status:"ok"}', () => {
    // Filesystem tools return bare success strings; the synthetic {status:"ok"}
    // positive from the grounding suite must keep working.
    expect(pureBridge.isSuccessfulBridgeToolResult('file contents here')).toBe(true);
    expect(pureBridge.isSuccessfulBridgeToolResult(JSON.stringify({ status: 'ok', contents: 'needle\n' }))).toBe(true);
  });

  it('keeps denied/error/null as non-success', () => {
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'denied' })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult({ status: 'error', error: 'x' })).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult(null)).toBe(false);
    expect(pureBridge.isSuccessfulBridgeToolResult(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 1 — edit_file structured failure (HF-8)
// ───────────────────────────────────────────────────────────────────────────
describe('edit_file failure returns are structured + non-grounding (criterion 1, HF-8)', () => {
  it('empty old_string returns a structured error that does NOT ground', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const target = join(root, 'src', 'edit-target.txt');
      writeFileSync(target, 'alpha beta gamma\n', 'utf8');
      const result = decodeToolResult(await bridge.evaluateToolCall('edit_file', {
        path: target, old_string: '', new_string: 'x',
      }));
      expect(result).toMatchObject({ status: 'error', tool: 'edit_file' });
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(false);
      // Original file is untouched by a failed edit.
      expect((await import('node:fs')).readFileSync(target, 'utf8')).toBe('alpha beta gamma\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('not-found old_string returns a structured error that does NOT ground', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const target = join(root, 'src', 'edit-target2.txt');
      writeFileSync(target, 'alpha beta gamma\n', 'utf8');
      const result = decodeToolResult(await bridge.evaluateToolCall('edit_file', {
        path: target, old_string: 'NOT_PRESENT_ANYWHERE', new_string: 'x',
      }));
      expect(result).toMatchObject({ status: 'error', tool: 'edit_file' });
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── positive control (criterion 6) ──
  it('a real successful edit_file still grounds', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const target = join(root, 'src', 'edit-ok.txt');
      writeFileSync(target, 'alpha beta gamma\n', 'utf8');
      const result = await bridge.evaluateToolCall('edit_file', {
        path: target, old_string: 'beta', new_string: 'DELTA',
      });
      expect(typeof result).toBe('string');
      expect(result).toMatch(/File edited:/);
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 3 — run_command / run_shell exit-code via the live tools
// ───────────────────────────────────────────────────────────────────────────
describe('run_command exit-code grounding (criterion 3 + positive control)', () => {
  it('run_command exit 0 grounds (positive control)', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const readable = join(root, 'src', 'readme.txt');
      writeFileSync(readable, 'body\n', 'utf8');
      const result = decodeToolResult(await bridge.evaluateToolCall('run_command', { argv: ['cat', readable] }));
      expect(result).toMatchObject({ status: 'executed', exitCode: 0 });
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('run_command nonzero exit does NOT ground', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      // `cat` on a nonexistent file exits nonzero but still status:'executed'.
      const result = decodeToolResult(await bridge.evaluateToolCall('run_command', {
        argv: ['cat', join(root, 'src', 'does-not-exist.txt')],
      }));
      expect(result.status).toBe('executed');
      expect(result.exitCode).not.toBe(0);
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 2 — web_fetch non-2xx via the live tool (HF-11)
// ───────────────────────────────────────────────────────────────────────────
describe('web_fetch non-2xx grounding (criterion 2 + positive control, HF-11)', () => {
  let fixture;
  beforeAll(async () => { fixture = await startHttpsFixture(); });

  it('web_fetch 2xx grounds (positive control)', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/ok`,
      }, { webOptions: fixtureWebOptions(fixture) }));
      expect(result.httpStatus).toBe(200);
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('web_fetch 404 does NOT ground', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/missing`,
      }, { webOptions: fixtureWebOptions(fixture) }));
      expect(result.httpStatus).toBe(404);
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('web_fetch 500 does NOT ground', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/boom`,
      }, { webOptions: fixtureWebOptions(fixture) }));
      expect(result.httpStatus).toBe(500);
      expect(bridge.isSuccessfulBridgeToolResult(result)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Criterion 5 — malformed toolCalls[] entries rejected/normalized (HF-16)
// ───────────────────────────────────────────────────────────────────────────
describe('malformed toolCalls[] normalization (criterion 5, HF-16)', () => {
  it('exports a normalizer for provider tool-call arrays', () => {
    expect(typeof pureBridge.normalizeProviderToolCalls).toBe('function');
  });

  it('drops un-deref-able entries and coerces non-string arguments without throwing', () => {
    const norm = pureBridge.normalizeProviderToolCalls;
    const calls = [
      { id: '1' },                                   // missing function → dropped
      { id: '2', function: {} },                     // missing function.name → dropped
      { id: '3', function: { name: '   ' } },        // blank name → dropped
      { id: '4', function: { name: 'read_file', arguments: 42 } }, // non-string scalar → dropped
      { id: '5', function: { name: 'read_file', arguments: { path: 'x' } } }, // object args → coerced
      { id: '6', function: { name: 'read_file', arguments: '{"path":"y"}' } }, // valid string args
      { id: '7', function: { name: 'grep' } },       // missing args → defaulted to '{}'
      null,                                          // not an object → dropped
      'oops',                                        // not an object → dropped
    ];
    let out;
    expect(() => { out = norm(calls); }).not.toThrow();
    // Every survivor is safely dereferenceable: string name + string arguments.
    for (const c of out) {
      expect(typeof c.function.name).toBe('string');
      expect(typeof c.function.arguments).toBe('string');
    }
    expect(out.map((c) => c.function.name)).toEqual(['read_file', 'read_file', 'grep']);
    expect(JSON.parse(out[0].function.arguments)).toEqual({ path: 'x' }); // coerced object
    expect(out[2].function.arguments).toBe('{}'); // missing args defaulted
  });

  it('returns [] (not a throw) when ALL entries are malformed', () => {
    const norm = pureBridge.normalizeProviderToolCalls;
    expect(() => norm([{ id: 'a' }, null, { function: {} }])).not.toThrow();
    expect(norm([{ id: 'a' }, null, { function: {} }])).toEqual([]);
    expect(norm(undefined)).toEqual([]);
    expect(norm('not-an-array')).toEqual([]);
  });

  it('the response loop builds calls via normalizeProviderToolCalls (no raw deref of response.toolCalls)', () => {
    // Source-level guard: the per-element deref of .function.name / .arguments in
    // the exec loop and exact-args gate must consume the normalized array, so a
    // malformed entry can never reach a bare .function deref.
    expect(bridgeSource).toMatch(/normalizeProviderToolCalls\(response\.toolCalls\)/);
  });
});
