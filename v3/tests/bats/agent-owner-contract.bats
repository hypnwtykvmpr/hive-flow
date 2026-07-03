#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "built agent_spawn aborts forged owner labels before persisting an agent" {
  script="$BATS_TEST_TMPDIR/agent-owner-contract.mjs"
  cat > "$script" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];
process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const spawn = mod.agentTools.find((tool) => tool.name === 'agent_spawn');
if (!spawn) throw new Error('agent_spawn tool missing');

const result = await spawn.handler({
  agentId: 'bats-forged-owner-agent',
  agentType: 'tester',
  provider: 'anthropic',
  session_id: 'attacker-picked-session',
  ownerClientKind: 'codex',
  client_kind: 'codex',
}, {});

const storePath = join(project, '.hive-flow', 'agents', 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { agents: {} };

if (result.success !== false || result.code !== 'missing-owner-client-kind') {
  throw new Error(`expected missing-owner-client-kind, got ${JSON.stringify(result)}`);
}
if (store.agents?.['bats-forged-owner-agent']) {
  throw new Error('forged owner agent persisted');
}
console.log(JSON.stringify({ ok: true, code: result.code }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-client-kind"'* ]]
}

@test "built agent_spawn aborts generated MCP transport ids before persisting an agent" {
  script="$BATS_TEST_TMPDIR/agent-owner-mcp-id.mjs"
  cat > "$script" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const spawn = mod.agentTools.find((tool) => tool.name === 'agent_spawn');
if (!spawn) throw new Error('agent_spawn tool missing');

const result = await spawn.handler({
  agentId: 'bats-generated-mcp-id-agent',
  agentType: 'tester',
  provider: 'anthropic',
}, { sessionId: 'mcp-1790000000000-deadbeef', clientKind: 'codex' });

const storePath = join(project, '.hive-flow', 'agents', 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { agents: {} };

if (result.success !== false || result.code !== 'missing-owner-session') {
  throw new Error(`expected missing-owner-session, got ${JSON.stringify(result)}`);
}
if (store.agents?.['bats-generated-mcp-id-agent']) {
  throw new Error('generated MCP id agent persisted');
}
console.log(JSON.stringify({ ok: true, code: result.code }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-session"'* ]]
}

@test "built agent_spawn persists only when a real parent session and kind are present" {
  script="$BATS_TEST_TMPDIR/agent-owner-valid.mjs"
  cat > "$script" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const spawn = mod.agentTools.find((tool) => tool.name === 'agent_spawn');
if (!spawn) throw new Error('agent_spawn tool missing');

const result = await spawn.handler({
  agentId: 'bats-real-parent-agent',
  agentType: 'tester',
  provider: 'anthropic',
  ownerClientKind: 'codex',
}, { sessionId: 'real-opencode-parent-session', clientKind: 'opencode' });

const storePath = join(project, '.hive-flow', 'agents', 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { agents: {} };
const agent = store.agents?.['bats-real-parent-agent'];

if (result.success !== true) {
  throw new Error(`expected success, got ${JSON.stringify(result)}`);
}
if (!agent) throw new Error('real parent agent was not persisted');
if (agent.ownerSessionId !== 'real-opencode-parent-session') {
  throw new Error(`wrong ownerSessionId ${agent.ownerSessionId}`);
}
if (agent.ownerClientKind !== 'opencode') {
  throw new Error(`wrong ownerClientKind ${agent.ownerClientKind}`);
}
console.log(JSON.stringify({ ok: true, ownerSessionId: agent.ownerSessionId, ownerClientKind: agent.ownerClientKind }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"ownerSessionId":"real-opencode-parent-session"'* ]]
  [[ "$output" == *'"ownerClientKind":"opencode"'* ]]
}

@test "built queen_mission_assign aborts forged owner labels before creating a hive" {
  script="$BATS_TEST_TMPDIR/queen-owner-forged.mjs"
  cat > "$script" <<'NODE'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];
process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

const agentDir = join(project, '.hive-flow', 'agents');
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, 'store.json'), JSON.stringify({
  version: '3.0.0',
  agents: {
    'queen-1': {
      agentId: 'queen-1',
      agentType: 'queen',
      status: 'idle',
      health: 100,
      taskCount: 0,
      config: {},
      createdAt: new Date(0).toISOString(),
      provider: 'anthropic',
      model: 'sonnet',
      ownerSessionId: 'real-queen-owner',
      ownerClientKind: 'opencode',
    },
  },
}, null, 2));

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/queen-tools.js')).href);
const assign = mod.queenTools.find((tool) => tool.name === 'queen_mission_assign');
if (!assign) throw new Error('queen_mission_assign tool missing');

const result = await assign.handler({
  queenId: 'queen-1',
  scope: 'forged owner hive',
  description: 'must not create hive',
  session_id: 'attacker-picked-session',
  ownerClientKind: 'codex',
  client_kind: 'codex',
});

const hivesDir = join(project, '.hive-flow', 'hives');
const hives = existsSync(hivesDir)
  ? readdirSync(hivesDir).filter((entry) => !entry.startsWith('.'))
  : [];

if (result.success !== false || result.code !== 'missing-owner-client-kind') {
  throw new Error(`expected missing-owner-client-kind, got ${JSON.stringify(result)}`);
}
if (result.hiveId) throw new Error(`unexpected hiveId ${result.hiveId}`);
if (hives.length !== 0) throw new Error(`partial hive persisted: ${hives.join(',')}`);
console.log(JSON.stringify({ ok: true, code: result.code, hives: hives.length }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-client-kind"'* ]]
  [[ "$output" == *'"hives":0'* ]]
}

@test "built queen_mission_assign persists hive owner kind only from a matching parent context" {
  script="$BATS_TEST_TMPDIR/queen-owner-valid.mjs"
  cat > "$script" <<'NODE'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];

const agentDir = join(project, '.hive-flow', 'agents');
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, 'store.json'), JSON.stringify({
  version: '3.0.0',
  agents: {
    'queen-1': {
      agentId: 'queen-1',
      agentType: 'queen',
      status: 'idle',
      health: 100,
      taskCount: 0,
      config: {},
      createdAt: new Date(0).toISOString(),
      provider: 'anthropic',
      model: 'sonnet',
      ownerSessionId: 'real-queen-owner',
      ownerClientKind: 'opencode',
    },
  },
}, null, 2));

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/queen-tools.js')).href);
const assign = mod.queenTools.find((tool) => tool.name === 'queen_mission_assign');
if (!assign) throw new Error('queen_mission_assign tool missing');

const result = await assign.handler({
  queenId: 'queen-1',
  scope: 'real parent hive',
  description: 'must persist stamped hive',
  session_id: 'real-parent-session',
  ownerClientKind: 'codex',
}, { sessionId: 'real-parent-session', clientKind: 'forgecode' });

const hivesDir = join(project, '.hive-flow', 'hives');
const hives = existsSync(hivesDir)
  ? readdirSync(hivesDir).filter((entry) => !entry.startsWith('.'))
  : [];
if (result.success !== true || !result.hiveId) {
  throw new Error(`expected success, got ${JSON.stringify(result)}`);
}
if (hives.length !== 1) throw new Error(`expected one hive, got ${hives.join(',')}`);
const hive = JSON.parse(readFileSync(join(hivesDir, result.hiveId, 'hive.json'), 'utf8'));
if (hive.ownerSessionId !== 'real-parent-session') throw new Error(`wrong ownerSessionId ${hive.ownerSessionId}`);
if (hive.ownerClientKind !== 'forgecode') throw new Error(`wrong ownerClientKind ${hive.ownerClientKind}`);
console.log(JSON.stringify({ ok: true, ownerSessionId: hive.ownerSessionId, ownerClientKind: hive.ownerClientKind }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"ownerSessionId":"real-parent-session"'* ]]
  [[ "$output" == *'"ownerClientKind":"forgecode"'* ]]
}

@test "built hive-mind_spawn aborts forged owner labels before persisting workers" {
  script="$BATS_TEST_TMPDIR/hivemind-owner-forged.mjs"
  cat > "$script" <<'NODE'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];
process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

const hiveMindDir = join(project, '.hive-flow', 'hive-mind');
mkdirSync(hiveMindDir, { recursive: true });
writeFileSync(join(hiveMindDir, 'state.json'), JSON.stringify({
  initialized: true,
  topology: 'mesh',
  queen: { agentId: 'queen-1', electedAt: new Date(0).toISOString(), term: 1 },
  workers: [],
  consensus: { pending: [], history: [] },
  sharedMemory: {},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}, null, 2));

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/hive-mind-tools.js')).href);
const spawn = mod.hiveMindTools.find((tool) => tool.name === 'hive-mind_spawn');
if (!spawn) throw new Error('hive-mind_spawn tool missing');

const result = await spawn.handler({
  count: 1,
  prefix: 'bats-hivemind-forged',
  agentType: 'tester',
  provider: 'anthropic',
  session_id: 'attacker-picked-session',
  ownerClientKind: 'codex',
});

const agentStorePath = join(project, '.hive-flow', 'agents', 'store.json');
const agentStore = existsSync(agentStorePath) ? JSON.parse(readFileSync(agentStorePath, 'utf8')) : { agents: {} };
const hiveState = JSON.parse(readFileSync(join(hiveMindDir, 'state.json'), 'utf8'));

if (result.success !== false || result.code !== 'missing-owner-client-kind') {
  throw new Error(`expected missing-owner-client-kind, got ${JSON.stringify(result)}`);
}
if (Object.keys(agentStore.agents || {}).length !== 0) throw new Error('forged hive-mind agent persisted');
if ((hiveState.workers || []).length !== 0) throw new Error('forged hive-mind worker persisted');
console.log(JSON.stringify({ ok: true, code: result.code, agents: 0, workers: 0 }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-client-kind"'* ]]
  [[ "$output" == *'"agents":0'* ]]
  [[ "$output" == *'"workers":0'* ]]
}

@test "built agent_pool scale aborts forged owner labels before persisting pool agents" {
  script="$BATS_TEST_TMPDIR/agent-pool-owner-forged.mjs"
  cat > "$script" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const ownerKeys = [
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_SESSION_ID',
  'GEMINI_THREAD_ID',
  'CURSOR_SESSION_ID',
  'CURSOR_THREAD_ID',
  'AGENT_SESSION_ID',
  'ANTIGRAVITY_SESSION_ID',
  'ANTIGRAVITY_THREAD_ID',
  'AGY_SESSION_ID',
  'AGY_THREAD_ID',
  'OPENCODE_SESSION_ID',
  'OPENCODE_THREAD_ID',
  'FORGECODE_SESSION_ID',
  'FORGECODE_THREAD_ID',
  'FORGE_CODE_SESSION_ID',
  'FORGE_SESSION_ID',
  'HIVE_FLOW_SESSION_ID',
  'HIVE_FLOW_CLIENT_KIND',
];
for (const key of ownerKeys) delete process.env[key];
process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const pool = mod.agentTools.find((tool) => tool.name === 'agent_pool');
if (!pool) throw new Error('agent_pool tool missing');

const result = await pool.handler({
  action: 'scale',
  targetSize: 2,
  agentType: 'tester',
  session_id: 'attacker-picked-session',
  ownerClientKind: 'codex',
});

const storePath = join(project, '.hive-flow', 'agents', 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { agents: {} };

if (result.success !== false || result.code !== 'missing-owner-client-kind') {
  throw new Error(`expected missing-owner-client-kind, got ${JSON.stringify(result)}`);
}
if (Object.keys(store.agents || {}).length !== 0) throw new Error('forged pool agents persisted');
console.log(JSON.stringify({ ok: true, code: result.code, agents: 0 }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-client-kind"'* ]]
  [[ "$output" == *'"agents":0'* ]]
}

@test "built agent_pool scale stamps grown agents from the real parent context" {
  script="$BATS_TEST_TMPDIR/agent-pool-owner-valid.mjs"
  cat > "$script" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const pool = mod.agentTools.find((tool) => tool.name === 'agent_pool');
if (!pool) throw new Error('agent_pool tool missing');

const result = await pool.handler({
  action: 'scale',
  targetSize: 2,
  agentType: 'tester',
}, { sessionId: 'pool-opencode-parent', clientKind: 'opencode' });

const storePath = join(project, '.hive-flow', 'agents', 'store.json');
const store = JSON.parse(readFileSync(storePath, 'utf8'));
const agents = Object.values(store.agents || {});

if (result.action !== 'scale' || !Array.isArray(result.added) || result.added.length !== 2) {
  throw new Error(`expected two pool agents, got ${JSON.stringify(result)}`);
}
if (agents.length !== 2) throw new Error(`expected two persisted agents, got ${agents.length}`);
for (const agent of agents) {
  if (agent.ownerSessionId !== 'pool-opencode-parent') throw new Error(`wrong ownerSessionId ${agent.ownerSessionId}`);
  if (agent.ownerClientKind !== 'opencode') throw new Error(`wrong ownerClientKind ${agent.ownerClientKind}`);
}
console.log(JSON.stringify({ ok: true, agents: agents.length, ownerClientKind: agents[0].ownerClientKind }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"agents":2'* ]]
  [[ "$output" == *'"ownerClientKind":"opencode"'* ]]
}

@test "built daa_agent_create aborts forged owner labels before persisting DAA agents" {
  script="$BATS_TEST_TMPDIR/daa-owner-forged.mjs"
  cat > "$script" <<'NODE'
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);
process.env.HIVE_FLOW_CLIENT_KIND = 'codex';

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/daa-tools.js')).href);
const create = mod.daaTools.find((tool) => tool.name === 'daa_agent_create');
if (!create) throw new Error('daa_agent_create tool missing');

const result = await create.handler({
  id: 'daa-forged-owner',
  session_id: 'attacker-picked-session',
  ownerClientKind: 'codex',
});

const storePath = join(project, '.hive-flow', 'daa', 'store.json');
const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : { agents: {} };

if (result.success !== false || result.code !== 'missing-owner-client-kind') {
  throw new Error(`expected missing-owner-client-kind, got ${JSON.stringify(result)}`);
}
if (Object.keys(store.agents || {}).length !== 0) throw new Error('forged DAA agent persisted');
console.log(JSON.stringify({ ok: true, code: result.code, agents: 0 }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"missing-owner-client-kind"'* ]]
  [[ "$output" == *'"agents":0'* ]]
}

@test "built hive-mind_join aborts phantom agent ids before persisting workers" {
  script="$BATS_TEST_TMPDIR/hivemind-join-phantom.mjs"
  cat > "$script" <<'NODE'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const hiveMindDir = join(project, '.hive-flow', 'hive-mind');
mkdirSync(hiveMindDir, { recursive: true });
writeFileSync(join(hiveMindDir, 'state.json'), JSON.stringify({
  initialized: true,
  topology: 'mesh',
  queen: { agentId: 'queen-1', electedAt: new Date(0).toISOString(), term: 1 },
  workers: [],
  consensus: { pending: [], history: [] },
  sharedMemory: {},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}, null, 2));

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/hive-mind-tools.js')).href);
const joinTool = mod.hiveMindTools.find((tool) => tool.name === 'hive-mind_join');
if (!joinTool) throw new Error('hive-mind_join tool missing');

const result = await joinTool.handler({ agentId: 'phantom-worker' }, { sessionId: 'owner-session', clientKind: 'opencode' });
const hiveState = JSON.parse(readFileSync(join(hiveMindDir, 'state.json'), 'utf8'));

if (result.success !== false || result.code !== 'agent-not-found') {
  throw new Error(`expected agent-not-found, got ${JSON.stringify(result)}`);
}
if ((hiveState.workers || []).length !== 0) throw new Error('phantom hive worker persisted');
console.log(JSON.stringify({ ok: true, code: result.code, workers: 0 }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"code":"agent-not-found"'* ]]
  [[ "$output" == *'"workers":0'* ]]
}

@test "built hive-mind_join preserves existing owned agent stamp on joined worker" {
  script="$BATS_TEST_TMPDIR/hivemind-join-owned.mjs"
  cat > "$script" <<'NODE'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const hiveMindDir = join(project, '.hive-flow', 'hive-mind');
mkdirSync(hiveMindDir, { recursive: true });
writeFileSync(join(hiveMindDir, 'state.json'), JSON.stringify({
  initialized: true,
  topology: 'mesh',
  queen: { agentId: 'queen-1', electedAt: new Date(0).toISOString(), term: 1 },
  workers: [],
  consensus: { pending: [], history: [] },
  sharedMemory: {},
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
}, null, 2));

const agentMod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const spawn = agentMod.agentTools.find((tool) => tool.name === 'agent_spawn');
if (!spawn) throw new Error('agent_spawn tool missing');
const spawnResult = await spawn.handler({
  agentId: 'join-owned-worker',
  agentType: 'tester',
  provider: 'anthropic',
}, { sessionId: 'join-opencode-parent', clientKind: 'opencode' });
if (spawnResult.success !== true) throw new Error(`spawn failed ${JSON.stringify(spawnResult)}`);

const hiveMod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/hive-mind-tools.js')).href);
const joinTool = hiveMod.hiveMindTools.find((tool) => tool.name === 'hive-mind_join');
if (!joinTool) throw new Error('hive-mind_join tool missing');

const result = await joinTool.handler({ agentId: 'join-owned-worker', role: 'specialist' }, { sessionId: 'join-opencode-parent', clientKind: 'opencode' });
const hiveState = JSON.parse(readFileSync(join(hiveMindDir, 'state.json'), 'utf8'));
const worker = hiveState.workers?.[0];

if (result.success !== true) throw new Error(`join failed ${JSON.stringify(result)}`);
if (!worker) throw new Error('owned worker was not persisted');
if (worker.ownerSessionId !== 'join-opencode-parent') throw new Error(`wrong ownerSessionId ${worker.ownerSessionId}`);
if (worker.ownerClientKind !== 'opencode') throw new Error(`wrong ownerClientKind ${worker.ownerClientKind}`);
console.log(JSON.stringify({ ok: true, workers: hiveState.workers.length, ownerClientKind: worker.ownerClientKind }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"workers":1'* ]]
  [[ "$output" == *'"ownerClientKind":"opencode"'* ]]
}

@test "built queen_spawn_worker stamps the persisted hive worker record" {
  script="$BATS_TEST_TMPDIR/queen-spawn-worker-owned.mjs"
  cat > "$script" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
process.chdir(project);

const agentMod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/agent-tools.js')).href);
const spawn = agentMod.agentTools.find((tool) => tool.name === 'agent_spawn');
if (!spawn) throw new Error('agent_spawn tool missing');
const context = { sessionId: 'queen-opencode-parent', clientKind: 'opencode' };
const queenSpawn = await spawn.handler({
  agentId: 'queen-owner-test',
  agentType: 'coordinator',
  provider: 'anthropic',
}, context);
if (queenSpawn.success !== true) throw new Error(`queen spawn failed ${JSON.stringify(queenSpawn)}`);

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-tools/queen-tools.js')).href);
const mission = mod.queenTools.find((tool) => tool.name === 'queen_mission_assign');
const spawnWorker = mod.queenTools.find((tool) => tool.name === 'queen_spawn_worker');
if (!mission || !spawnWorker) throw new Error('queen tools missing');

const missionResult = await mission.handler({
  queenId: 'queen-owner-test',
  scope: 'owner contract',
  description: 'verify worker stamp',
  maxWorkers: 6,
}, context);
if (missionResult.success !== true) throw new Error(`mission failed ${JSON.stringify(missionResult)}`);

const spawnResult = await spawnWorker.handler({
  hiveId: missionResult.hiveId,
  queenId: 'queen-owner-test',
  role: 'tester',
  provider: 'anthropic',
}, context);
if (spawnResult.success !== true) throw new Error(`spawn failed ${JSON.stringify(spawnResult)}`);

const hivePath = join(project, '.hive-flow', 'hives', missionResult.hiveId, 'hive.json');
const hive = JSON.parse(readFileSync(hivePath, 'utf8'));
const worker = hive.workers?.[0];
if (!worker) throw new Error('worker record missing');
if (worker.ownerSessionId !== 'queen-opencode-parent') throw new Error(`wrong ownerSessionId ${worker.ownerSessionId}`);
if (worker.ownerClientKind !== 'opencode') throw new Error(`wrong ownerClientKind ${worker.ownerClientKind}`);
console.log(JSON.stringify({ ok: true, workers: hive.workers.length, ownerClientKind: worker.ownerClientKind }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"workers":1'* ]]
  [[ "$output" == *'"ownerClientKind":"opencode"'* ]]
}
