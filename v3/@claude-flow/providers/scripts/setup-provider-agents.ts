#!/usr/bin/env npx tsx
/**
 * Provider Agent Setup Script
 *
 * Registers provider-backed agent types, creates hook entries,
 * and validates provider binaries. Idempotent — safe to run multiple times.
 *
 * Usage: npx tsx v3/@claude-flow/providers/scripts/setup-provider-agents.ts
 *
 * @module @claude-flow/providers/scripts/setup-provider-agents
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ===== Constants =====

const PROVIDER_AGENT_TYPES = [
  {
    name: 'gemini-researcher',
    description: 'Research agent powered by Google Gemini CLI',
    provider: 'gemini-cli',
    defaultModel: 'gemini-3.1-pro-preview',
    capabilities: ['code-analysis', 'architecture-review', 'documentation', 'research'],
  },
  {
    name: 'codex-researcher',
    description: 'Research agent powered by OpenAI Codex CLI',
    provider: 'codex-cli',
    defaultModel: 'gpt-5.3-codex',
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
  { name: 'gemini-cli', binary: 'gemini' },
  { name: 'codex-cli', binary: 'codex' },
  { name: 'cursor-cli', binary: 'cursor-agent', fallback: 'cursor' },
];

// ===== Binary Detection =====

function checkBinary(binary: string): { found: boolean; version: string | null } {
  try {
    execSync(`which ${binary}`, { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { found: false, version: null };
  }

  try {
    const version = execSync(`${binary} --version`, {
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
  return path.join(home, '.claude-flow', 'agents');
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

function createHookEntries(): { added: string[]; skipped: string[] } {
  const projectRoot = findProjectRoot();
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const added: string[] = [];
  const skipped: string[] = [];

  // Ensure .claude directory exists
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Provider route hook — UserPromptSubmit
  const routeHookCommand = 'node v3/@claude-flow/providers/scripts/provider-route-hook.mjs';
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
    added.push('UserPromptSubmit: provider-route-hook');
  } else {
    skipped.push('UserPromptSubmit: provider-route-hook (already exists)');
  }

  // Provider status hook — SessionStart
  const statusHookCommand = 'node v3/@claude-flow/providers/scripts/provider-status-hook.mjs';
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
    added.push('SessionStart: provider-status-hook');
  } else {
    skipped.push('SessionStart: provider-status-hook (already exists)');
  }

  // Atomic write
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
  fs.renameSync(tmpPath, settingsPath);

  return { added, skipped };
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

  // Step 3: Create hook entries
  console.log('\n3. Configuring hooks...');
  const { added, skipped: hookSkipped } = createHookEntries();
  for (const name of added) {
    console.log(`   [+] Added: ${name}`);
  }
  for (const name of hookSkipped) {
    console.log(`   [=] ${name}`);
  }

  // Summary
  const readyCount = binaries.filter((b) => b.found).length;
  console.log(`\n=== Setup Complete ===`);
  console.log(`Providers ready: ${readyCount}/${binaries.length}`);
  console.log(`Agent types: ${registered.length} new, ${typeSkipped.length} existing`);
  console.log(`Hooks: ${added.length} new, ${hookSkipped.length} existing`);

  if (readyCount === 0) {
    console.log('\nNo provider binaries found. Install at least one:');
    console.log('  Gemini CLI: npm install -g @anthropic/gemini-cli');
    console.log('  Codex CLI:  npm install -g @openai/codex');
    console.log('  Cursor CLI: Available via Cursor IDE');
  }
}

main();
