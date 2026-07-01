#!/usr/bin/env tsx
/**
 * Provider Agent Setup Script
 *
 * Registers provider-backed agent types, creates hook entries,
 * and validates provider binaries. Idempotent — safe to run multiple times.
 *
 * Usage: tsx v3/@hive-flow/providers/scripts/setup-provider-agents.ts
 *
 * @module @hive-flow/providers/scripts/setup-provider-agents
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ===== Constants =====

const PROVIDER_AGENT_TYPES = [
  {
    name: 'gemini-researcher',
    description: 'Research agent powered by Google Gemini CLI',
    provider: 'gemini-cli',
    defaultModel: 'gemini-3.5-flash',
    capabilities: ['code-analysis', 'architecture-review', 'documentation', 'research'],
  },
  {
    name: 'codex-researcher',
    description: 'Research agent powered by OpenAI Codex CLI',
    provider: 'codex-cli',
    defaultModel: 'gpt-5.5',
    capabilities: ['code-analysis', 'architecture-review', 'documentation', 'research'],
  },
  {
    name: 'cursor-researcher',
    description: 'Research agent powered by Cursor CLI',
    provider: 'cursor-cli',
    defaultModel: 'auto',
    capabilities: ['code-analysis', 'architecture-review', 'documentation', 'research'],
  },
] as const;

interface ProviderBinaryInfo {
  name: string;
  binary: string;
  version: string | null;
  found: boolean;
}

const PROVIDER_BINARIES: Array<{ name: string; binary: string; fallback?: string }> = [
  // DO-NOT-REVERT (2026-06): `gemini-cli` is backed by Google's ANTIGRAVITY CLI
  // (`agy`), NOT the dead `@google/gemini-cli` (`gemini`). The legacy `gemini`
  // binary 404s (ModelNotFoundError) for current models; a stale copy may linger
  // on PATH. Reverting `binary` to `gemini` reintroduces the 404 regression.
  { name: 'gemini-cli', binary: 'agy' },
  { name: 'codex-cli', binary: 'codex' },
  { name: 'cursor-cli', binary: 'cursor-agent', fallback: 'cursor' },
];

// ===== Binary Detection =====

function checkBinary(binary: string): { found: boolean; version: string | null } {
  try {
    execFileSync('which', [binary], { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { found: false, version: null };
  }

  try {
    const version = execFileSync(binary, ['--version'], {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();
    // Extract first line, trim to reasonable length
    const firstLine = version.split('\n')[0].slice(0, 100);
    return { found: true, version: firstLine };
  } catch {
    // Binary exists but --version failed (some CLIs don't support it)
    return { found: true, version: 'unknown' };
  }
}

function validateProviderBinaries(): ProviderBinaryInfo[] {
  return PROVIDER_BINARIES.map(({ name, binary, fallback }) => {
    let result = checkBinary(binary);
    if (!result.found && fallback) {
      result = checkBinary(fallback);
      if (result.found) {
        return { name, binary: fallback, version: result.version, found: true };
      }
    }
    return { name, binary, version: result.version, found: result.found };
  });
}

// ===== Agent Store Config =====

function getAgentStoreDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.hive-flow', 'agents');
}

function registerAgentTypes(): { registered: string[]; skipped: string[] } {
  const storeDir = getAgentStoreDir();
  const configPath = path.join(storeDir, 'agent-types.json');

  // Ensure directory exists
  fs.mkdirSync(storeDir, { recursive: true });

  // Load existing config
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      config = {};
    }
  }

  const types = (config.types as Record<string, unknown>) || {};
  const registered: string[] = [];
  const skipped: string[] = [];

  for (const agentType of PROVIDER_AGENT_TYPES) {
    if (types[agentType.name]) {
      skipped.push(agentType.name);
      continue;
    }
    types[agentType.name] = {
      description: agentType.description,
      provider: agentType.provider,
      defaultModel: agentType.defaultModel,
      capabilities: agentType.capabilities,
      registeredAt: new Date().toISOString(),
    };
    registered.push(agentType.name);
  }

  config.types = types;

  // Atomic write: write to tmp then rename
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  fs.renameSync(tmpPath, configPath);

  return { registered, skipped };
}

// ===== Hook Registration =====

interface SettingsHookEntry {
  type: string;
  command: string;
}

interface SettingsHookMatcher {
  matcher: string;
  hooks: SettingsHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, SettingsHookMatcher[]>;
  [key: string]: unknown;
}

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// ===== Shared Hook Registration =====

interface HookRegistrationResult {
  added: string[];
  skipped: string[];
}

function writeHookEntries(
  hookConfigPath: string,
  routeHookCommand: string,
  statusHookCommand: string,
  label: string
): HookRegistrationResult {
  const dir = path.dirname(hookConfigPath);
  const added: string[] = [];
  const skipped: string[] = [];

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  let settings: ClaudeSettings = {};
  if (fs.existsSync(hookConfigPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(hookConfigPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Provider route hook — UserPromptSubmit
  const promptHooks = settings.hooks.UserPromptSubmit || [];
  const hasRouteHook = promptHooks.some((entry) =>
    entry.hooks?.some((h) => h.command === routeHookCommand)
  );

  if (!hasRouteHook) {
    promptHooks.push({
      matcher: '',
      hooks: [{ type: 'command', command: routeHookCommand }],
    });
    settings.hooks.UserPromptSubmit = promptHooks;
    added.push(`UserPromptSubmit: provider-route-hook (${label})`);
  } else {
    skipped.push(`UserPromptSubmit: provider-route-hook (${label}, already exists)`);
  }

  // Provider status hook — SessionStart
  const sessionHooks = settings.hooks.SessionStart || [];
  const hasStatusHook = sessionHooks.some((entry) =>
    entry.hooks?.some((h) => h.command === statusHookCommand)
  );

  if (!hasStatusHook) {
    sessionHooks.push({
      matcher: '',
      hooks: [{ type: 'command', command: statusHookCommand }],
    });
    settings.hooks.SessionStart = sessionHooks;
    added.push(`SessionStart: provider-status-hook (${label})`);
  } else {
    skipped.push(`SessionStart: provider-status-hook (${label}, already exists)`);
  }

  // Atomic write
  const tmpPath = hookConfigPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, hookConfigPath);

  return { added, skipped };
}

function createClaudeHookEntries(): HookRegistrationResult {
  const projectRoot = findProjectRoot();
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');

  const routeHookCommand = 'hive-flow providers hook route';
  const statusHookCommand = 'hive-flow providers hook status';

  return writeHookEntries(settingsPath, routeHookCommand, statusHookCommand, 'claude');
}

function createCodexHookEntries(): HookRegistrationResult {
  const projectRoot = findProjectRoot();
  const hooksPath = path.join(projectRoot, '.codex', 'hooks.json');

  const routeHookCommand = 'hive-flow providers hook route';
  const statusHookCommand = 'hive-flow providers hook status';

  return writeHookEntries(hooksPath, routeHookCommand, statusHookCommand, 'codex');
}

/**
 * Enable the hooks feature flag in ~/.codex/config.toml.
 * Migrates the legacy `codex_hooks` key to `hooks` when found.
 * Safe to call multiple times — idempotent.
 */
function enableCodexHooksFeature(): boolean {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const configPath = path.join(home, '.codex', 'config.toml');

  if (!fs.existsSync(configPath)) {
    // No Codex config — nothing to enable
    return false;
  }

  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return false;
  }

  // Check if [features] section exists
  if (!/\[features\]/.test(content)) {
    // Append [features] section with hooks
    content += '\n[features]\nhooks = true\n';
    fs.writeFileSync(configPath, content);
    return true;
  }

  // Migrate legacy codex_hooks → hooks (regardless of value)
  if (/^\s*codex_hooks\s*=/m.test(content)) {
    content = content.replace(/^\s*codex_hooks\s*=\s*\w+/m, 'hooks = true');
    fs.writeFileSync(configPath, content);
    return true;
  }

  // Already has hooks = something — ensure it's true
  if (/^\s*hooks\s*=/m.test(content)) {
    if (/^\s*hooks\s*=\s*true/m.test(content)) {
      return false; // Already correctly set
    }
    content = content.replace(/^\s*hooks\s*=\s*\w+/m, 'hooks = true');
    fs.writeFileSync(configPath, content);
    return true;
  }

  // [features] exists but no hooks line — add it
  content = content.replace(/(\[features\][^\[]*)/, (match) => {
    return match.trimEnd() + '\nhooks = true\n';
  });
  fs.writeFileSync(configPath, content);
  return true;
}

// ===== Main =====

function main(): void {
  console.log('=== Provider Agent Setup ===\n');

  // Step 1: Validate binaries
  console.log('1. Checking provider binaries...');
  const binaries = validateProviderBinaries();
  for (const info of binaries) {
    if (info.found) {
      console.log(`   [OK] ${info.name}: ${info.binary} (${info.version})`);
    } else {
      console.log(`   [--] ${info.name}: ${info.binary} not found`);
    }
  }

  // Step 2: Register agent types
  console.log('\n2. Registering agent types...');
  const { registered, skipped: typeSkipped } = registerAgentTypes();
  for (const name of registered) {
    console.log(`   [+] Registered: ${name}`);
  }
  for (const name of typeSkipped) {
    console.log(`   [=] Already registered: ${name}`);
  }

  // Step 3: Configure Claude Code hooks
  console.log('\n3. Configuring Claude Code hooks (.claude/settings.json)...');
  const claudeHooks = createClaudeHookEntries();
  for (const name of claudeHooks.added) {
    console.log(`   [+] Added: ${name}`);
  }
  for (const name of claudeHooks.skipped) {
    console.log(`   [=] ${name}`);
  }

  // Step 4: Configure Codex hooks
  console.log('\n4. Configuring Codex/ForgeCode hooks (.codex/hooks.json)...');
  const codexHooks = createCodexHookEntries();
  for (const name of codexHooks.added) {
    console.log(`   [+] Added: ${name}`);
  }
  for (const name of codexHooks.skipped) {
    console.log(`   [=] ${name}`);
  }

  // Step 5: Enable hooks feature flag
  const featureEnabled = enableCodexHooksFeature();
  if (featureEnabled) {
    console.log('   [+] Enabled hooks feature in ~/.codex/config.toml');
  } else {
    console.log('   [=] hooks feature already enabled (or no Codex config found)');
  }

  // Summary
  const readyCount = binaries.filter((b) => b.found).length;
  const totalAdded = claudeHooks.added.length + codexHooks.added.length;
  const totalSkipped = claudeHooks.skipped.length + codexHooks.skipped.length;
  console.log(`\n=== Setup Complete ===`);
  console.log(`Providers ready: ${readyCount}/${binaries.length}`);
  console.log(`Agent types: ${registered.length} new, ${typeSkipped.length} existing`);
  console.log(`Hooks: ${totalAdded} new, ${totalSkipped} existing`);

  if (readyCount === 0) {
    console.log('\nNo provider binaries found. Install at least one:');
    // DO-NOT-REVERT (2026-06): point at ANTIGRAVITY (`agy`), not @google/gemini-cli (dead, 404s).
    console.log('  Gemini CLI: install Antigravity (https://antigravity.google), then run "agy install" — binary "agy"');
    console.log('  Codex CLI:  install @openai/codex with your configured package manager');
    console.log('  Cursor CLI: Available via Cursor IDE');
  }
}

main();
