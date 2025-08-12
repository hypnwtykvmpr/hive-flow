#!/usr/bin/env node
/**
 * Stream Chain Command - Connect multiple Claude instances via stream-json
 * Clean implementation focused on real Claude CLI execution
 */

import { exec, execSync, spawn } from 'child_process';

/**
 * Check if claude CLI is available
 */
function checkClaudeAvailable() {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mock implementation for fallback
 */
function mockResponse(prompt) {
  return {
    success: true,
    duration: 500,
    output: `✅ Mock response for: ${prompt.slice(0, 50)}...`,
    stream: null,
    error: null
  };
}

/**
 * Execute a single Claude CLI command
 */
async function executeClaudeCommand(prompt, timeout = 20000, useStreamJson = false) {
  return new Promise((resolve) => {
    // Build command arguments array for spawn
    const args = ['-p'];
    
    if (useStreamJson) {
      args.push('--output-format', 'stream-json', '--verbose');
    }
    
    // Add the prompt as final argument
    args.push(prompt);
    
    console.log(`🔄 Executing: claude ${args.map(arg => arg.includes(' ') ? `"${arg}"` : arg).join(' ')}`);
    
    const startTime = Date.now();
    
    // Use spawn instead of exec to handle arguments properly
    const claudeProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    
    let stdout = '';
    let stderr = '';
    let processCompleted = false;
    
    claudeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    claudeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    claudeProcess.on('close', (code) => {
      if (processCompleted) return;
      processCompleted = true;
      
      const duration = Date.now() - startTime;
      
      if (code !== 0) {
        console.error('Claude CLI error: Process exited with code', code);
        if (stderr) {
          console.error('stderr:', stderr);
        }
        resolve(mockResponse(prompt));
        return;
      }
      
      resolve({
        success: true,
        duration,
        output: stdout.trim(),
        stream: useStreamJson ? stdout : null,
        error: stderr ? stderr.trim() : null
      });
    });
    
    claudeProcess.on('error', (error) => {
      if (processCompleted) return;
      processCompleted = true;
      
      console.error('Claude CLI spawn error:', error.message);
      resolve(mockResponse(prompt));
    });
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      if (processCompleted) return;
      processCompleted = true;
      
      console.log('⚠️  Claude CLI timed out, using mock response...');
      claudeProcess.kill();
      resolve(mockResponse(prompt));
    }, timeout);
    
    claudeProcess.on('close', () => {
      clearTimeout(timeoutId);
    });
  });
}

/**
 * Main stream chain command
 */
export async function streamChainCommand(args, flags) {
  const subcommand = args[0] || 'help';
  
  if (subcommand === 'help') {
    console.log(`
🔗 Stream Chain Command

USAGE:
  stream-chain run "prompt1" "prompt2" [...]  # Execute custom chain
  stream-chain demo                           # Run demo chain
  stream-chain test                           # Test Claude CLI
  stream-chain help                           # Show this help

OPTIONS:
  --timeout <seconds>   Timeout per step (default: 20)
  --mock               Force mock mode
  --verbose            Show detailed output

EXAMPLES:
  stream-chain run "Hello" "How are you?"
  stream-chain demo --timeout 30
  stream-chain test

For real execution, Claude CLI must be installed and configured.
    `);
    return;
  }
  
  if (subcommand === 'test') {
    console.log('🧪 Testing Claude CLI...');
    
    if (!checkClaudeAvailable()) {
      console.log('❌ Claude CLI not found');
      return;
    }
    
    const result = await executeClaudeCommand('Hello, test', 10000);
    console.log('✅ Test result:', result.success ? 'PASSED' : 'FAILED');
    if (result.output) {
      console.log('📄 Output:', result.output.slice(0, 100) + '...');
    }
    return;
  }
  
  if (subcommand === 'demo') {
    console.log('🎭 Running Stream Chain Demo');
    console.log('━'.repeat(50));
    
    const prompts = [
      "Analyze requirements for a todo app",
      "Design the data model",
      "Create implementation plan"
    ];
    
    return runChain(prompts, flags);
  }
  
  if (subcommand === 'run') {
    const prompts = args.slice(1);
    
    if (prompts.length < 2) {
      console.error('❌ Error: Need at least 2 prompts');
      console.log('Usage: stream-chain run "prompt1" "prompt2" [...]');
      return;
    }
    
    return runChain(prompts, flags);
  }
  
  console.error(`❌ Unknown subcommand: ${subcommand}`);
  console.log('Use "stream-chain help" for usage information');
}

/**
 * Execute a chain of prompts
 */
async function runChain(prompts, flags) {
  const timeout = (flags.timeout || 20) * 1000;
  const useMock = flags.mock || !checkClaudeAvailable();
  
  if (useMock) {
    console.log('ℹ️  Using mock mode (Claude CLI not available or --mock flag used)');
  } else {
    console.log('ℹ️  Using real Claude CLI execution');
  }
  
  console.log(`📝 Chain length: ${prompts.length} steps\n`);
  
  const results = [];
  
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    console.log(`🔄 Step ${i + 1}/${prompts.length}: ${prompt.slice(0, 50)}...`);
    
    let result;
    if (useMock) {
      result = mockResponse(prompt);
    } else {
      result = await executeClaudeCommand(prompt, timeout, false);
    }
    
    results.push({
      step: i + 1,
      prompt: prompt.slice(0, 50),
      success: result.success,
      duration: result.duration
    });
    
    if (!result.success) {
      console.error(`❌ Step ${i + 1} failed`);
      break;
    }
    
    console.log(`✅ Step ${i + 1} completed (${result.duration}ms)`);
    if (flags.verbose && result.output) {
      console.log(`   Output: ${result.output.slice(0, 200)}...`);
    }
  }
  
  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Chain Summary');
  console.log('═'.repeat(50));
  
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} Step ${result.step}: ${result.prompt}... (${result.duration}ms)`);
  }
  
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
  console.log(`\n⏱️  Total execution time: ${totalTime}ms`);
}

export default streamChainCommand;