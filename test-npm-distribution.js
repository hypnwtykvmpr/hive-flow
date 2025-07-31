#!/usr/bin/env node

// Test script to verify npm distribution includes all files
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

// Create temporary directory
const testDir = join(tmpdir(), `claude-flow-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });

console.log(`🧪 Testing npm distribution in: ${testDir}`);

try {
  // Change to test directory
  process.chdir(testDir);
  
  // Initialize npm project
  console.log('\n📦 Initializing test project...');
  execSync('npm init -y', { stdio: 'inherit' });
  
  // Install claude-flow from npm
  console.log('\n📥 Installing claude-flow@alpha...');
  execSync('npm install claude-flow@alpha', { stdio: 'inherit' });
  
  // Run init command
  console.log('\n🚀 Running claude-flow init...');
  execSync('npx claude-flow@alpha init --force', { stdio: 'inherit' });
  
  // Verify files
  console.log('\n✅ Verifying files...');
  const filesToCheck = [
    '.claude/settings.json',
    '.claude/helpers/standard-checkpoint-hooks.sh',
    '.claude/helpers/github-checkpoint-hooks.sh',
    '.claude/helpers/checkpoint-manager.sh',
    'CLAUDE.md'
  ];
  
  let allFilesExist = true;
  for (const file of filesToCheck) {
    const exists = existsSync(file);
    console.log(`  ${exists ? '✅' : '❌'} ${file}`);
    if (!exists) allFilesExist = false;
  }
  
  // Check settings.json content
  if (existsSync('.claude/settings.json')) {
    const settings = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    const hasStandardHooks = JSON.stringify(settings).includes('standard-checkpoint-hooks.sh');
    console.log(`\n  ${hasStandardHooks ? '✅' : '❌'} settings.json references standard-checkpoint-hooks.sh`);
  }
  
  // Cleanup
  process.chdir('..');
  rmSync(testDir, { recursive: true, force: true });
  
  console.log('\n🎉 Test complete!');
  process.exit(allFilesExist ? 0 : 1);
  
} catch (error) {
  console.error('\n❌ Test failed:', error.message);
  process.chdir('..');
  rmSync(testDir, { recursive: true, force: true });
  process.exit(1);
}
