import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
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

function makeProjectRoot(prefix = 'hf-web-fetch-') {
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
    return await import(`${pathToFileURL(bridgePath).href}?web=${Date.now()}-${Math.random()}`);
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
  const hits = [];
  const server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    hits.push({ url: req.url, host: req.headers.host, remoteAddress: req.socket.remoteAddress });
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('hello fixture');
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(128));
      return;
    }
    if (req.url === '/redirect-safe') {
      res.writeHead(302, { location: `https://fixture.test:${server.address().port}/ok` });
      res.end();
      return;
    }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: `https://127.0.0.1:${server.address().port}/ok` });
      res.end();
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
    hits,
    close: () => new Promise((resolvePromise, reject) => {
      server.close((err) => (err ? reject(err) : resolvePromise()));
    }),
  };
}

function fixtureWebOptions(fixture, extra = {}) {
  const origin = `https://fixture.test:${fixture.port}`;
  return {
    allowlist: [origin],
    allowInsecureTls: true,
    allowPrivateFixtureIPs: true,
    maxBytes: 64,
    resolveHost: async (hostname) => {
      if (hostname === 'fixture.test') return [{ address: '127.0.0.1', family: 4 }];
      return [];
    },
    ...extra,
  };
}

function expectFetchedContract(result) {
  expect(Object.keys(result).sort()).toEqual([
    'bytes',
    'contentType',
    'finalUrl',
    'httpStatus',
    'redirectCount',
    'status',
    'truncated',
  ]);
}

function expectDeniedContract(result) {
  expect(Object.keys(result).sort()).toEqual([
    'bytes',
    'contentType',
    'denyReason',
    'finalUrl',
    'httpStatus',
    'redirectCount',
    'status',
    'truncated',
  ]);
}

describe('provider bridge web_fetch contract and SSRF guard', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startHttpsFixture();
  });

  afterEach(() => {
    restoreEnv();
  });

  afterAll(async () => {
    restoreEnv();
    if (fixture) await fixture.close();
  });

  it('fetches an allowlisted HTTPS fixture through the bridge-owned result contract', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/ok`,
      }, {
        webOptions: fixtureWebOptions(fixture),
      }));

      expectFetchedContract(result);
      expect(result).toMatchObject({
        status: 'fetched',
        finalUrl: `https://fixture.test:${fixture.port}/ok`,
        httpStatus: 200,
        contentType: 'text/plain; charset=utf-8',
        bytes: Buffer.byteLength('hello fixture'),
        truncated: false,
        redirectCount: 0,
      });
      expect(fixture.hits.at(-1)).toMatchObject({
        url: '/ok',
        host: `fixture.test:${fixture.port}`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('manually validates redirects per hop and preserves redirect counts', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/redirect-safe`,
      }, {
        webOptions: fixtureWebOptions(fixture),
      }));

      expectFetchedContract(result);
      expect(result).toMatchObject({
        status: 'fetched',
        finalUrl: `https://fixture.test:${fixture.port}/ok`,
        httpStatus: 200,
        redirectCount: 1,
      });

      const denied = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/redirect-private`,
      }, {
        webOptions: fixtureWebOptions(fixture),
      }));

      expectDeniedContract(denied);
      expect(denied.status).toBe('denied');
      expect(denied.redirectCount).toBe(1);
      expect(denied.denyReason).toMatch(/blocked-ip|localhost|allowlist|unsafe-url/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('truncates response reads at the configured byte cap', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/large`,
      }, {
        webOptions: fixtureWebOptions(fixture, { maxBytes: 10 }),
      }));

      expectFetchedContract(result);
      expect(result).toMatchObject({
        status: 'fetched',
        bytes: 10,
        truncated: true,
        httpStatus: 200,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies when fetch or exec is restricted before dispatcher work', async () => {
    for (const restrictedGroups of [['fetch'], ['exec']]) {
      const { root, bridge } = await makeBridge(0, restrictedGroups);
      try {
        const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
          url: `https://fixture.test:${fixture.port}/ok`,
        }, {
          webOptions: fixtureWebOptions(fixture),
        }));

        expectDeniedContract(result);
        expect(result).toMatchObject({
          status: 'denied',
          finalUrl: null,
          httpStatus: null,
          bytes: 0,
          truncated: false,
          redirectCount: 0,
          denyReason: 'restricted-fetch-or-exec',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('denies at RESTRICTED/HALTED effective levels', async () => {
    for (const level of [2, 3]) {
      const { root, bridge } = await makeBridge(level);
      try {
        const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
          url: `https://fixture.test:${fixture.port}/ok`,
        }, {
          webOptions: fixtureWebOptions(fixture),
        }));

        expectDeniedContract(result);
        expect(result.status).toBe('denied');
        expect(result.denyReason).toBe('restricted-fetch-or-exec');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('fails closed if the undici dispatcher cannot be loaded', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: `https://fixture.test:${fixture.port}/ok`,
      }, {
        webOptions: fixtureWebOptions(fixture, { forceDispatcherUnavailable: true }),
      }));

      expectDeniedContract(result);
      expect(result).toMatchObject({
        status: 'denied',
        denyReason: 'dispatcher-unavailable',
        finalUrl: null,
        httpStatus: null,
        bytes: 0,
        truncated: false,
        redirectCount: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies SSRF URL corpus before public network access', async () => {
    const attacks = [
      [`http://fixture.test:${fixture.port}/ok`, /https-only/],
      [`https://user:pass@fixture.test:${fixture.port}/ok`, /embedded-credentials/],
      [`https://127.0.0.1:${fixture.port}/ok`, /blocked-ip|localhost/],
      [`https://localhost:${fixture.port}/ok`, /localhost/],
      ['https://169.254.169.254/latest/meta-data', /blocked-ip|metadata/],
      ['https://[::1]/', /blocked-ip/],
      ['https://[fd00::1]/', /blocked-ip/],
      ['https://[fe80::1]/', /blocked-ip/],
      ['https://2130706433/', /ipv4-odd-encoding|blocked-ip/],
      ['https://0177.0.0.1/', /ipv4-odd-encoding|blocked-ip/],
      ['https://0x7f000001/', /ipv4-odd-encoding|blocked-ip/],
    ];

    const { root, bridge } = await makeBridge(0);
    try {
      for (const [url, denyPattern] of attacks) {
        const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', { url }, {
          webOptions: fixtureWebOptions(fixture),
        }));

        expectDeniedContract(result);
        expect(result.status, url).toBe('denied');
        expect(result.denyReason, url).toMatch(denyPattern);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies DNS-rebinding simulations when a hop resolves to private IP space', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_fetch', {
        url: 'https://rebind.test/ok',
      }, {
        webOptions: {
          allowlist: ['https://rebind.test'],
          resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
        },
      }));

      expectDeniedContract(result);
      expect(result.status).toBe('denied');
      expect(result.denyReason).toMatch(/blocked-ip|dns/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps web_search as an explicit unsupported deny stub, not open search', async () => {
    const { root, bridge } = await makeBridge(0);
    try {
      const result = decodeToolResult(await bridge.evaluateToolCall('web_search', {
        query: 'provider bridge ssrf',
      }));

      expectDeniedContract(result);
      expect(result).toMatchObject({
        status: 'denied',
        denyReason: 'web-search-unsupported',
        finalUrl: null,
        httpStatus: null,
        bytes: 0,
        truncated: false,
        redirectCount: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
