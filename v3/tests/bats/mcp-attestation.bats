#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "built MCP attestation validates spawned and in-process entrypoints for the same owner" {
  script="$BATS_TEST_TMPDIR/mcp-attestation-entrypoints.mjs"
  cat > "$script" <<'NODE'
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
mkdirSync(project, { recursive: true });
process.chdir(project);

const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-server/attestation.js')).href);
const env = {
  HIVE_FLOW_PROJECT_ROOT: project,
  HIVE_FLOW_CLIENT_KIND: 'codex',
  CODEX_SESSION_ID: 'bats-codex-owner',
};
const entrypointPath = join(root, 'cli', 'bin', 'mcp-server.js');

const spawned = mod.mintMCPAttestation({
  env,
  cwd: project,
  entrypoint: 'bin/mcp-server.js',
  pidMode: 'spawned-child',
  launcherPid: 1234,
  entrypointPath,
});
if (!spawned.success) throw new Error(`spawned mint failed: ${JSON.stringify(spawned)}`);

const inProcess = mod.mintInProcessMCPAttestation({
  env,
  cwd: project,
  mcpPid: 5678,
});
if (!inProcess.success) throw new Error(`in-process mint failed: ${JSON.stringify(inProcess)}`);

const spawnedValidation = mod.validateMCPAttestation({
  env: { ...env, ...spawned.envPatch },
  cwd: project,
  ppid: 1234,
  entrypointPath,
});
const inProcessValidation = mod.validateMCPAttestation({
  env,
  cwd: project,
  pid: 5678,
});

if (!spawnedValidation.success) throw new Error(`spawned validation failed: ${JSON.stringify(spawnedValidation)}`);
if (!inProcessValidation.success) throw new Error(`in-process validation failed: ${JSON.stringify(inProcessValidation)}`);
if (spawnedValidation.context.sessionId !== 'bats-codex-owner') throw new Error('spawned owner session mismatch');
if (inProcessValidation.context.attestationEntryPoint !== 'cli/mcp-stdio-inprocess') throw new Error('in-process entrypoint mismatch');

console.log(JSON.stringify({
  ok: true,
  spawnedEntryPoint: spawnedValidation.context.attestationEntryPoint,
  inProcessEntryPoint: inProcessValidation.context.attestationEntryPoint,
}));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"spawnedEntryPoint":"bin/mcp-server.js"'* ]]
  [[ "$output" == *'"inProcessEntryPoint":"cli/mcp-stdio-inprocess"'* ]]
}

@test "built MCP attestation owner-sensitive registry includes hive and DAA owner tools" {
  script="$BATS_TEST_TMPDIR/mcp-attestation-sensitive-tools.mjs"
  cat > "$script" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-server/attestation.js')).href);
for (const toolName of ['agent_spawn', 'hive-mind_spawn', 'hive-mind_join', 'daa_agent_create', 'hive_poll_workers']) {
  if (!mod.isOwnerSensitiveMCPTool(toolName)) throw new Error(`missing owner-sensitive tool ${toolName}`);
}
if (mod.isOwnerSensitiveMCPTool('agent_message_escalate')) {
  throw new Error('router mediation tool should not be stdio-owner-sensitive');
}
console.log(JSON.stringify({ ok: true, count: mod.OWNER_SENSITIVE_MCP_TOOLS.length }));
NODE

  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
}

@test "CJS launcher helper mints records accepted by the built reader" {
  script="$BATS_TEST_TMPDIR/mcp-attestation-cjs-helper.mjs"
  cat > "$script" <<'NODE'
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, project] = process.argv.slice(2);
mkdirSync(project, { recursive: true });
process.chdir(project);

const requireFromRoot = createRequire(join(root, '.claude', 'helpers', 'hive-flow-mcp-launcher.cjs'));
const cjs = requireFromRoot(join(root, '.claude', 'helpers', 'mcp-attestation.cjs'));
const reader = await import(pathToFileURL(join(root, 'cli/dist/src/mcp-server/attestation.js')).href);
const env = {
  HIVE_FLOW_PROJECT_ROOT: project,
  HIVE_FLOW_CLIENT_KIND: 'codex',
  CODEX_SESSION_ID: 'bats-cjs-codex-owner',
};
const entrypointPath = join(root, 'cli', 'bin', 'mcp-server.js');

const minted = cjs.mintMCPAttestation({
  env,
  cwd: project,
  helperDir: join(root, '.claude', 'helpers'),
  entrypoint: 'bin/mcp-server.js',
  pidMode: 'spawned-child',
  launcherPid: 2468,
  entrypointPath,
});
if (!minted.success) throw new Error(`CJS mint failed: ${JSON.stringify(minted)}`);

const validation = reader.validateMCPAttestation({
  env: { ...env, ...minted.envPatch },
  cwd: project,
  ppid: 2468,
  entrypointPath,
});
if (!validation.success) throw new Error(`reader validation failed: ${JSON.stringify(validation)}`);
if (validation.context.sessionId !== 'bats-cjs-codex-owner') throw new Error('owner session mismatch');

console.log(JSON.stringify({ ok: true, entrypoint: validation.context.attestationEntryPoint }));
NODE

  mkdir -p "$BATS_TEST_TMPDIR/project" "$BATS_TEST_TMPDIR/home"
  run env -i PATH="$PATH" HOME="$BATS_TEST_TMPDIR/home" node "$script" "$REPO_ROOT" "$BATS_TEST_TMPDIR/project"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
  [[ "$output" == *'"entrypoint":"bin/mcp-server.js"'* ]]
}
