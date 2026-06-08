import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import fc from 'fast-check';
import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const providersRoot = resolve(here, '..');
const bridgePath = resolve(providersRoot, 'scripts/provider-agent-bridge.mjs');
const policyPath = resolve(here, '../../cli/dist/src/permission-guard/protected-paths.js');
const propertyRuns = Number.parseInt(process.env.HF_BRIDGE_PARITY_RUNS || '120', 10);

const OP_CLASSES = [
  'fs_read',
  'fs_write',
  'fs_edit',
  'fs_search',
  'shell',
  'web_fetch',
  'unknown_or_mcp',
];

const previousEnv = {
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  AGENTIC_FLOW_AGENT_ID: process.env.AGENTIC_FLOW_AGENT_ID,
  CLAUDE_AGENT_ID: process.env.CLAUDE_AGENT_ID,
  HIVE_FLOW_HIVE_ID: process.env.HIVE_FLOW_HIVE_ID,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makeProjectRoot(prefix = 'hf-bridge-parity-') {
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
  try { chmodSync(keyPath, 0o600); } catch { /* best-effort in tmp fixtures */ }
  return key;
}

function signState(key, state) {
  return {
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  };
}

function writeEnvelope(root, key, statePath, state, options = {}) {
  mkdirSync(dirname(statePath), { recursive: true });
  const envelope = signState(options.signingKey || key, state);
  if (options.tamperHmac) {
    envelope.hmac = `${envelope.hmac.slice(0, -1)}${envelope.hmac.endsWith('0') ? '1' : '0'}`;
  }
  writeFileSync(statePath, JSON.stringify(envelope, null, 2), 'utf8');
}

function cleanEnforcement(root) {
  rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
}

function normalizedGroups(groups) {
  return [...new Set((Array.isArray(groups) ? groups : []).filter((group) => typeof group === 'string'))];
}

function baseState(level, restrictedGroups = []) {
  return {
    level,
    ts: '2026-06-08T00:00:00.000Z',
    violations: 0,
    restrictedGroups: normalizedGroups(restrictedGroups),
    history: [],
    integrityCompromised: false,
  };
}

function statePath(root, scope) {
  if (scope === 'global') return join(root, '.hive-flow', 'enforcement', 'state.json');
  if (scope === 'agent') return join(root, '.hive-flow', 'enforcement', 'agents', 'parity-agent', 'state.json');
  if (scope === 'hive') return join(root, '.hive-flow', 'enforcement', 'hives', 'parity-hive', 'state.json');
  throw new Error(`Unknown scope: ${scope}`);
}

function stateSnapshot(level, groups) {
  const restrictedGroups = normalizedGroups(groups);
  if (level >= 2 && restrictedGroups.length === 0) {
    return { level, restrictedGroups: ['exec', 'write'] };
  }
  return { level, restrictedGroups };
}

function failClosedSnapshot() {
  return { level: 2, restrictedGroups: ['exec', 'write'] };
}

function missingSnapshot(missingLevel) {
  return stateSnapshot(missingLevel, []);
}

function combineSnapshots(snapshots) {
  const level = Math.max(...snapshots.map((snapshot) => snapshot.level));
  const restrictedGroups = [...new Set(snapshots.flatMap((snapshot) => snapshot.restrictedGroups))];
  return { level, restrictedGroups };
}

function applyEnvelopeCase(root, envelopeCase) {
  cleanEnforcement(root);
  const key = writeKey(root);
  process.env.CLAUDE_PROJECT_DIR = root;
  process.env.AGENTIC_FLOW_AGENT_ID = envelopeCase.agent.present ? 'parity-agent' : '';
  process.env.CLAUDE_AGENT_ID = envelopeCase.agent.present ? 'parity-agent' : '';
  process.env.HIVE_FLOW_HIVE_ID = envelopeCase.hive.present ? 'parity-hive' : '';

  const globalState = baseState(envelopeCase.global.level, envelopeCase.global.restrictedGroups);
  let globalSnapshot;
  switch (envelopeCase.global.kind) {
    case 'valid':
      writeEnvelope(root, key, statePath(root, 'global'), globalState);
      globalSnapshot = stateSnapshot(envelopeCase.global.level, envelopeCase.global.restrictedGroups);
      break;
    case 'missing-global':
      globalSnapshot = missingSnapshot(2);
      break;
    case 'missing-key':
      writeEnvelope(root, key, statePath(root, 'global'), globalState);
      rmSync(join(root, '.hive-flow', 'enforcement', '.hmac-key'), { force: true });
      globalSnapshot = failClosedSnapshot();
      break;
    case 'invalid-envelope':
      writeFileSync(statePath(root, 'global'), JSON.stringify({ bad: true }), 'utf8');
      globalSnapshot = failClosedSnapshot();
      break;
    case 'tampered':
      writeEnvelope(root, key, statePath(root, 'global'), globalState, { tamperHmac: true });
      globalSnapshot = failClosedSnapshot();
      break;
    default:
      throw new Error(`Unknown global state kind: ${envelopeCase.global.kind}`);
  }

  const snapshots = [globalSnapshot];
  if (envelopeCase.agent.present) {
    const state = baseState(envelopeCase.agent.level, envelopeCase.agent.restrictedGroups);
    writeEnvelope(root, key, statePath(root, 'agent'), state);
    snapshots.push(stateSnapshot(envelopeCase.agent.level, envelopeCase.agent.restrictedGroups));
  }
  if (envelopeCase.hive.present) {
    const state = baseState(envelopeCase.hive.level, envelopeCase.hive.restrictedGroups);
    writeEnvelope(root, key, statePath(root, 'hive'), state);
    snapshots.push(stateSnapshot(envelopeCase.hive.level, envelopeCase.hive.restrictedGroups));
  }

  return combineSnapshots(snapshots);
}

function makeCasePaths(root, id) {
  const publicFile = join(root, 'src', `case-${id}.txt`);
  const editFile = join(root, 'src', `edit-${id}.txt`);
  const publicDir = join(root, 'src');
  const protectedRead = join(root, '.env');
  const protectedWrite = join(root, '.claude', 'settings.json');
  const outsideRoot = join(tmpdir(), `hf-bridge-parity-outside-${id}.txt`);

  writeFileSync(publicFile, `needle-${id}\n`, 'utf8');
  writeFileSync(editFile, `before-${id}\n`, 'utf8');
  writeFileSync(protectedRead, `secret-${id}\n`, 'utf8');
  writeFileSync(protectedWrite, '{"hooks":[]}\n', 'utf8');
  writeFileSync(outsideRoot, `outside-${id}\n`, 'utf8');

  return { publicFile, editFile, publicDir, protectedRead, protectedWrite, outsideRoot };
}

function pathForKind(paths, pathKind, opClass) {
  if (pathKind === 'outside') return paths.outsideRoot;
  if (pathKind === 'protected-read') return paths.protectedRead;
  if (pathKind === 'protected-write') return paths.protectedWrite;
  if (opClass === 'fs_edit') return paths.editFile;
  if (opClass === 'fs_search') return paths.publicDir;
  return paths.publicFile;
}

function toolForCase(opClass, pathKind, paths, id) {
  const path = pathForKind(paths, pathKind, opClass);
  switch (opClass) {
    case 'fs_read':
      return { toolName: 'read_file', args: { path } };
    case 'fs_write':
      return { toolName: 'write_file', args: { path, content: `written-${id}\n` } };
    case 'fs_edit':
      return { toolName: 'edit_file', args: { path, old_string: `before-${id}`, new_string: `after-${id}` } };
    case 'fs_search':
      return { toolName: 'find_file', args: { path, pattern: `case-${id}.txt` } };
    case 'shell':
      return { toolName: 'run_shell', args: { argv: ['node', '--version'] } };
    case 'web_fetch':
      return { toolName: 'web_fetch', args: { url: 'https://example.invalid/parity' } };
    case 'unknown_or_mcp':
      return pathKind === 'protected-read'
        ? { toolName: 'mcp__filesystem__read_file', args: { path } }
        : { toolName: `unknown_tool_${id}`, args: { path } };
    default:
      throw new Error(`Unknown opClass: ${opClass}`);
  }
}

function protectedReadDenied(policy, root, path) {
  return policy.isProtectedReadPath(path, root);
}

function protectedWriteDenied(policy, root, path) {
  return policy.isProtectedWritePath(path, root);
}

function outsideRootDenied(root, path) {
  const resolved = resolve(path);
  return resolved !== root && !resolved.startsWith(`${root}/`);
}

function oracleDenies({ opClass, toolArgs, effectiveState, policy, root }) {
  if (opClass === 'unknown_or_mcp' || opClass === 'web_fetch') {
    return true;
  }

  if (opClass === 'shell') {
    return effectiveState.level >= 2
      || effectiveState.restrictedGroups.includes('exec')
      || effectiveState.restrictedGroups.includes('write')
      || toolArgs.command?.includes(';')
      || toolArgs.command?.includes('|')
      || toolArgs.command?.includes('>')
      || toolArgs.command?.includes('<');
  }

  const targetPath = toolArgs.path;
  if (outsideRootDenied(root, targetPath)) return true;

  if (opClass === 'fs_read' || opClass === 'fs_search') {
    return protectedReadDenied(policy, root, targetPath);
  }

  if (opClass === 'fs_write' || opClass === 'fs_edit') {
    return protectedWriteDenied(policy, root, targetPath)
      || effectiveState.level >= 2
      || effectiveState.restrictedGroups.includes('write');
  }

  throw new Error(`Unhandled oracle opClass: ${opClass}`);
}

function providerAllowed(result) {
  if (result && typeof result === 'object') {
    return result.status !== 'denied' && result.status !== 'error';
  }
  if (typeof result !== 'string') return true;

  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.status === 'string') {
        return parsed.status !== 'denied' && parsed.status !== 'error';
      }
    } catch {
      // Fall through to legacy string classification below.
    }
  }
  return !trimmed.startsWith('Error:');
}

async function bridgeDecision(bridge, opClass, toolName, args) {
  if (process.env.HF_BRIDGE_PARITY_MUTANT === 'allow-unknown' && opClass === 'unknown_or_mcp') {
    return 'MUTANT_ALLOWED_UNKNOWN';
  }
  if (process.env.HF_BRIDGE_PARITY_MUTANT === 'allow-write-restricted' && opClass === 'fs_write') {
    return `MUTANT_ALLOWED_WRITE:${args.path}`;
  }
  if (process.env.HF_BRIDGE_PARITY_MUTANT === 'allow-shell-restricted' && opClass === 'shell') {
    return 'MUTANT_ALLOWED_SHELL';
  }
  return bridge.evaluateToolCall(toolName, args, {
    source: 'parity-property',
    ...(opClass === 'shell' ? { sandboxOptions: { backendOrder: [] } } : {}),
  });
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) {
      process.off(event, listener);
    }
  }
}

const restrictedGroupsArb = fc.uniqueArray(
  fc.constantFrom('write', 'exec', 'network', 'read'),
  { maxLength: 3 },
);

const scopedStateArb = fc.record({
  present: fc.boolean(),
  level: fc.integer({ min: 0, max: 3 }),
  restrictedGroups: restrictedGroupsArb,
});

const envelopeCaseArb = fc.record({
  global: fc.record({
    kind: fc.constantFrom('valid', 'missing-global', 'missing-key', 'invalid-envelope', 'tampered'),
    level: fc.integer({ min: 0, max: 3 }),
    restrictedGroups: restrictedGroupsArb,
  }),
  agent: scopedStateArb,
  hive: scopedStateArb,
});

const opCaseArb = fc.record({
  opClass: fc.constantFrom(...OP_CLASSES),
  pathKind: fc.constantFrom('inside', 'outside', 'protected-read', 'protected-write'),
});

describe('provider bridge enforcement parity property', () => {
  let root;
  let bridge;
  let policy;
  let caseCounter = 0;

  beforeAll(async () => {
    root = makeProjectRoot();
    const previousCwd = process.cwd();
    const sigtermListeners = process.listeners('SIGTERM');
    const uncaughtExceptionListeners = process.listeners('uncaughtException');
    process.chdir(root);
    try {
      bridge = await import(`${pathToFileURL(bridgePath).href}?parity=${Date.now()}`);
    } finally {
      process.chdir(previousCwd);
      restoreProcessListeners('SIGTERM', sigtermListeners);
      restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
    }
    policy = await import(pathToFileURL(policyPath).href);
  });

  afterEach(() => {
    restoreEnv();
  });

  afterAll(() => {
    restoreEnv();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('never allows provider tool calls when the oracle denies them', async () => {
    let droveEvaluateToolCall = 0;

    await fc.assert(
      fc.asyncProperty(envelopeCaseArb, opCaseArb, async (envelopeCase, opCase) => {
        const id = ++caseCounter;
        const effectiveState = applyEnvelopeCase(root, envelopeCase);
        const paths = makeCasePaths(root, id);
        const { toolName, args } = toolForCase(opCase.opClass, opCase.pathKind, paths, id);
        const oracleSaysDeny = oracleDenies({
          opClass: opCase.opClass,
          toolArgs: args,
          effectiveState,
          policy,
          root,
        });

        const result = await bridgeDecision(bridge, opCase.opClass, toolName, args);
        droveEvaluateToolCall++;

        if (oracleSaysDeny && providerAllowed(result)) {
          throw new Error(JSON.stringify({
            message: 'provider allowed an oracle-denied operation',
            opCase,
            envelopeCase,
            effectiveState,
            toolName,
            args,
            result,
          }, null, 2));
        }
      }),
      { numRuns: propertyRuns, seed: 260608 },
    );

    expect(droveEvaluateToolCall).toBeGreaterThan(0);
  });

  it('denies a concrete write when the signed state restricts the write group', async () => {
    const effectiveState = applyEnvelopeCase(root, {
      global: { kind: 'valid', level: 0, restrictedGroups: ['write'] },
      agent: { present: false, level: 0, restrictedGroups: [] },
      hive: { present: false, level: 0, restrictedGroups: [] },
    });
    const id = ++caseCounter;
    const paths = makeCasePaths(root, id);
    const { toolName, args } = toolForCase('fs_write', 'inside', paths, id);

    expect(oracleDenies({
      opClass: 'fs_write',
      toolArgs: args,
      effectiveState,
      policy,
      root,
    })).toBe(true);

    const result = await bridgeDecision(bridge, 'fs_write', toolName, args);
    expect(providerAllowed(result)).toBe(false);
  });

  it('keeps fs decisions unchanged after shell/web classes are evaluated', async () => {
    await fc.assert(
      fc.asyncProperty(
        envelopeCaseArb,
        fc.constantFrom('fs_read', 'fs_write', 'fs_search'),
        fc.constantFrom('inside', 'protected-read', 'protected-write', 'outside'),
        fc.constantFrom('shell', 'web_fetch'),
        async (envelopeCase, fsOpClass, pathKind, placeholderOpClass) => {
          const id = ++caseCounter;
          applyEnvelopeCase(root, envelopeCase);
          const paths = makeCasePaths(root, id);
          const fsTool = toolForCase(fsOpClass, pathKind, paths, id);
          const placeholderTool = toolForCase(placeholderOpClass, 'inside', paths, id);

          const before = await bridgeDecision(bridge, fsOpClass, fsTool.toolName, fsTool.args);
          await bridgeDecision(bridge, placeholderOpClass, placeholderTool.toolName, placeholderTool.args);
          const after = await bridgeDecision(bridge, fsOpClass, fsTool.toolName, fsTool.args);

          expect({
            allowed: providerAllowed(after),
            status: typeof after === 'object' ? after.status : 'string',
          }).toEqual({
            allowed: providerAllowed(before),
            status: typeof before === 'object' ? before.status : 'string',
          });
        },
      ),
      { numRuns: Math.max(40, Math.floor(propertyRuns / 2)), seed: 260609 },
    );
  });

  it('drives every planned operation class with concrete witnesses', async () => {
    const seen = new Set();
    for (const opClass of OP_CLASSES) {
      const id = ++caseCounter;
      const effectiveState = applyEnvelopeCase(root, {
        global: { kind: 'valid', level: 0, restrictedGroups: [] },
        agent: { present: false, level: 0, restrictedGroups: [] },
        hive: { present: false, level: 0, restrictedGroups: [] },
      });
      const paths = makeCasePaths(root, id);
      const { toolName, args } = toolForCase(opClass, 'inside', paths, id);
      const result = await bridgeDecision(bridge, opClass, toolName, args);
      const oracleSaysDeny = oracleDenies({ opClass, toolArgs: args, effectiveState, policy, root });
      if (oracleSaysDeny) {
        expect(providerAllowed(result), `${opClass} should deny`).toBe(false);
      }
      seen.add(opClass);
    }

    expect(seen).toEqual(new Set(OP_CLASSES));
  });
});
