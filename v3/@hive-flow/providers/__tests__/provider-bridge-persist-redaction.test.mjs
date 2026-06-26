import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const previousEnv = {
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
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

let saveAgentState;
let redactBridgeString;
let tmpDir;

beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  const unhandledRejectionListeners = process.listeners('unhandledRejection');
  try {
    ({ saveAgentState, redactBridgeString } = await import(
      `${pathToFileURL(bridgePath).href}?persist-redaction=${Date.now()}`
    ));
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
    restoreProcessListeners('unhandledRejection', unhandledRejectionListeners);
  }
  tmpDir = mkdtempSync(join(tmpdir(), 'bridge-persist-'));
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---- HF-18: redaction-on-persist (store.json) ----

describe('HF-18 saveAgentState redacts secret-bearing persisted content', () => {
  const GH_TOKEN = 'ghp_' + 'A'.repeat(36);
  const SK_KEY = 'sk-' + 'B'.repeat(45);
  const JWT = [
    'eyJhbGciOiJIUzI1NiJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  ].join('.');

  function buildStore() {
    return {
      version: '3.0.0',
      agents: {
        'agent-keep-1234567890': {
          id: 'agent-keep-1234567890',
          provider: 'codex-cli',
          status: 'idle',
          currentTaskId: 'task-abc-987',
          owner: 'queen-xyz',
          taskCount: 2,
          lastTaskAt: '2026-06-25T00:00:00.000Z',
          conversationHistory: [
            { role: 'user', content: 'normal question about the build', timestamp: '2026-06-25T00:00:00.000Z' },
            {
              role: 'assistant',
              content: `here is your token ${GH_TOKEN} use it`,
              timestamp: '2026-06-25T00:00:01.000Z',
              toolCalls: [
                {
                  id: 'call_abc123',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: `{"command":"curl -H \\"Authorization: Bearer ${SK_KEY}\\" https://api.x"}`,
                  },
                },
                {
                  id: 'call_def456',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"src/x.ts"}' },
                },
              ],
            },
            {
              role: 'tool',
              content: { stdout: `export KEY=${SK_KEY}`, ok: true },
              reasoningContent: `internally I noted the jwt ${JWT}`,
              timestamp: '2026-06-25T00:00:02.000Z',
            },
          ],
          lastResult: {
            content: `final answer with ${GH_TOKEN}`,
            summary: `summary leaking ${SK_KEY}`,
            model: 'gpt-5.5',
            usage: { totalTokens: 42 },
            cost: 0.01,
            completedAt: '2026-06-25T00:00:03.000Z',
          },
        },
      },
    };
  }

  it('redacts secrets in conversationHistory content, object content, and reasoningContent', () => {
    const storePath = join(tmpDir, 'store-1.json');
    saveAgentState(storePath, buildStore());
    const raw = readFileSync(storePath, 'utf8');

    expect(raw).not.toContain(GH_TOKEN);
    expect(raw).not.toContain(SK_KEY);
    expect(raw).not.toContain(JWT);
    expect(raw).toContain('[REDACTED]');
  });

  it('redacts secrets in lastResult.content and lastResult.summary', () => {
    const storePath = join(tmpDir, 'store-2.json');
    saveAgentState(storePath, buildStore());
    const persisted = JSON.parse(readFileSync(storePath, 'utf8'));
    const last = persisted.agents['agent-keep-1234567890'].lastResult;

    expect(last.content).not.toContain(GH_TOKEN);
    expect(last.summary).not.toContain(SK_KEY);
    expect(last.content).toContain('[REDACTED]');
    expect(last.summary).toContain('[REDACTED]');
  });

  it('preserves structural fields and normal (non-secret) content', () => {
    const storePath = join(tmpDir, 'store-3.json');
    saveAgentState(storePath, buildStore());
    const persisted = JSON.parse(readFileSync(storePath, 'utf8'));
    const agent = persisted.agents['agent-keep-1234567890'];

    // Structural fields survive intact.
    expect(persisted.version).toBe('3.0.0');
    expect(agent.id).toBe('agent-keep-1234567890');
    expect(agent.status).toBe('idle');
    expect(agent.currentTaskId).toBe('task-abc-987');
    expect(agent.owner).toBe('queen-xyz');
    expect(agent.taskCount).toBe(2);
    expect(agent.lastResult.model).toBe('gpt-5.5');
    expect(agent.lastResult.usage.totalTokens).toBe(42);
    expect(agent.lastResult.cost).toBe(0.01);
    expect(agent.lastResult.completedAt).toBe('2026-06-25T00:00:03.000Z');

    // Negative control: normal prose content round-trips unchanged.
    expect(agent.conversationHistory[0].content).toBe('normal question about the build');
    // Object content keeps its structure (only the secret value is redacted).
    expect(agent.conversationHistory[2].content.ok).toBe(true);
  });

  it('does not mutate the caller live in-memory store (in-process replay safety)', () => {
    const storePath = join(tmpDir, 'store-4.json');
    const live = buildStore();
    saveAgentState(storePath, live);
    // Live object still holds the raw secret for the running process.
    expect(live.agents['agent-keep-1234567890'].lastResult.content).toContain(GH_TOKEN);
    expect(live.agents['agent-keep-1234567890'].conversationHistory[1].content).toContain(GH_TOKEN);
  });

  it('persisted-then-reloaded record loads without corruption', () => {
    const storePath = join(tmpDir, 'store-5.json');
    saveAgentState(storePath, buildStore());
    const reloaded = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(reloaded.agents['agent-keep-1234567890'].conversationHistory).toHaveLength(3);
    expect(reloaded.agents['agent-keep-1234567890'].conversationHistory[2].content.ok).toBe(true);
  });

  it('redacts secrets in toolCalls[].function.arguments while preserving structure and benign args', () => {
    const storePath = join(tmpDir, 'store-6.json');
    const live = buildStore();
    saveAgentState(storePath, live);
    const raw = readFileSync(storePath, 'utf8');
    const persisted = JSON.parse(raw);
    const calls = persisted.agents['agent-keep-1234567890'].conversationHistory[1].toolCalls;

    // Secret-bearing arg is redacted on disk.
    expect(raw).not.toContain(SK_KEY);
    expect(calls[0].function.arguments).toContain('[REDACTED]');
    expect(calls[0].function.arguments).not.toContain(SK_KEY);

    // Structural toolCall fields survive.
    expect(calls[0].id).toBe('call_abc123');
    expect(calls[0].type).toBe('function');
    expect(calls[0].function.name).toBe('run_command');
    expect(calls[1].function.name).toBe('read_file');

    // Negative control: benign arg round-trips byte-identical.
    expect(calls[1].function.arguments).toBe('{"path":"src/x.ts"}');

    // Replay safety: live in-memory toolCalls still hold the raw secret.
    expect(live.agents['agent-keep-1234567890'].conversationHistory[1].toolCalls[0].function.arguments).toContain(SK_KEY);
  });

  it('also redacts legacy/snake-case tool_calls arguments', () => {
    const storePath = join(tmpDir, 'store-7.json');
    const live = buildStore();
    live.agents['agent-keep-1234567890'].conversationHistory.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_legacy',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: `{"Authorization":"Bearer ${SK_KEY}","safe":true}`,
          },
        },
      ],
    });

    saveAgentState(storePath, live);
    const persisted = JSON.parse(readFileSync(storePath, 'utf8'));
    const legacyCall = persisted.agents['agent-keep-1234567890'].conversationHistory[3].tool_calls[0];

    expect(legacyCall.id).toBe('call_legacy');
    expect(legacyCall.function.name).toBe('run_command');
    expect(legacyCall.function.arguments).not.toContain(SK_KEY);
    expect(legacyCall.function.arguments).toContain('[REDACTED]');
    expect(live.agents['agent-keep-1234567890'].conversationHistory[3].tool_calls[0].function.arguments).toContain(SK_KEY);
  });
});

// ---- HF-19: pattern coverage ----

describe('HF-19 redactBridgeString token coverage', () => {
  it('redacts new sub-floor token shapes', () => {
    const slackBotPrefix = ['xo', 'xb'].join('') + '-';
    const slackUserPrefix = ['xo', 'xp'].join('') + '-';
    const cases = {
      githubPat: 'ghp_' + 'a'.repeat(36),
      githubServer: 'ghs_' + 'b'.repeat(36),
      slackBot: slackBotPrefix + '123456789012-1234567890123-abcdEFGHijklMNOPqrstUVwx',
      slackUser: slackUserPrefix + '123456789012-1234567890123-abcdEFGHijklMNOPqrstUVwx',
      gitlabPat: 'glpat-' + 'C'.repeat(20),
      jwt: [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      ].join('.'),
    };
    for (const [label, token] of Object.entries(cases)) {
      const out = redactBridgeString(`prefix ${token} suffix`);
      expect(out, label).not.toContain(token);
      expect(out, label).toContain('[REDACTED]');
    }
  });

  it('still redacts pre-existing covered tokens', () => {
    const openrouter = 'or-' + 'd'.repeat(20);
    const skAnt = 'sk-ant-' + 'e'.repeat(30);
    const google = 'AIza' + 'F'.repeat(35);
    const longB64 = 'G'.repeat(48);
    for (const token of [openrouter, skAnt, google, longB64]) {
      const out = redactBridgeString(`x ${token} y`);
      expect(out).not.toContain(token);
      expect(out).toContain('[REDACTED]');
    }
  });

  it('does not over-redact normal prose, short hex, or commit SHAs (negative control)', () => {
    const benign = [
      'The quick brown fox jumps over the lazy dog.',
      'commit a1b2c3d is on branch main',                 // short hex SHA stays
      'see file src/index.ts line 42 for the handler',
      'status: idle, owner: queen-1, task task-abc-987',
      'PR #123 merged at 2026-06-25T00:00:00Z',
    ];
    for (const text of benign) {
      expect(redactBridgeString(text)).toBe(text);
    }
  });
});
