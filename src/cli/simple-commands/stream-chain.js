#!/usr/bin/env node
/**
 * Stream Chain Command - Real Claude CLI stream-json chaining
 * Implements proper stream-json format chaining as documented
 */

import { spawn, execSync } from 'child_process';
import { Readable } from 'stream';

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
 * Execute a chain of Claude instances with real stream-json piping
 */
async function executeRealChain(prompts, flags = {}) {
  const results = [];
  let previousOutput = null;
  
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const isFirst = i === 0;
    const isLast = i === prompts.length - 1;
    
    console.log(`\n🔄 Step ${i + 1}/${prompts.length}: ${prompt.slice(0, 50)}...`);
    
    const result = await executeChainStep(
      prompt, 
      previousOutput, 
      isFirst, 
      isLast, 
      flags
    );
    
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
    
    // Store output for next step
    if (!isLast && result.output) {
      previousOutput = result.output;
      if (flags.verbose) {
        console.log(`   Output length: ${result.output.length} bytes`);
      }
    }
  }
  
  return results;
}

/**
 * Transform stream-json output to create proper input for next step
 * This converts the previous assistant's output into a user message for chaining
 */
function transformStreamForChaining(rawOutput, nextPrompt) {
  const lines = rawOutput.split('\n').filter(line => line.trim());
  const messages = [];
  let assistantContent = '';
  
  // Extract the assistant's response from the stream
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (json.type === 'message' && json.role === 'assistant' && json.content) {
        // Extract text content from assistant messages
        for (const content of json.content) {
          if (content.type === 'text' && content.text) {
            assistantContent += content.text + '\n';
          }
        }
      }
    } catch (e) {
      // Skip invalid JSON lines
    }
  }
  
  // Create a user message with the previous output and new prompt
  if (assistantContent) {
    const userMessage = {
      type: 'message',
      role: 'user',
      content: [{
        type: 'text',
        text: `Previous step output:\n${assistantContent.trim()}\n\nNext step: ${nextPrompt}`
      }]
    };
    return JSON.stringify(userMessage);
  }
  
  // Fallback: just create a user message with the prompt
  const fallbackMessage = {
    type: 'message',
    role: 'user',
    content: [{
      type: 'text',
      text: nextPrompt
    }]
  };
  return JSON.stringify(fallbackMessage);
}

/**
 * Execute a single step in the chain with proper stream-json handling
 */
async function executeChainStep(prompt, inputData, isFirst, isLast, flags) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const timeout = (flags.timeout || 30) * 1000;
    
    // Build command args following the spec from docs/stream-chaining.md
    const args = ['-p'];
    
    // Add input format if we have previous output
    // Note: --input-format stream-json requires --output-format stream-json
    if (!isFirst && inputData) {
      args.push('--input-format', 'stream-json');
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
    } else if (!isLast) {
      // Only output format for first/middle steps
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
    }
    
    // Add the prompt
    args.push(prompt);
    
    if (flags.verbose) {
      console.log(`   Command: claude ${args.join(' ')}`);
    }
    
    // Spawn Claude process
    const claudeProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    
    let output = '';
    let stderr = '';
    let processCompleted = false;
    
    // Pipe input data if available
    if (!isFirst && inputData) {
      try {
        // Filter the input to remove system messages
        const filteredInput = filterStreamJson(inputData);
        
        // Write the filtered output as input
        claudeProcess.stdin.write(filteredInput);
        claudeProcess.stdin.end();
        if (flags.verbose) {
          console.log('   🔗 Piped filtered input from previous step');
          console.log(`   Filtered ${inputData.split('\n').length} lines to ${filteredInput.split('\n').filter(l => l).length} lines`);
        }
      } catch (error) {
        console.error('   Error piping input:', error.message);
      }
    } else {
      // No input, close stdin
      claudeProcess.stdin.end();
    }
    
    // Capture output
    claudeProcess.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    
    // Capture errors
    claudeProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    
    // Handle completion
    claudeProcess.on('close', (code) => {
      if (processCompleted) return;
      processCompleted = true;
      
      const duration = Date.now() - startTime;
      
      if (code !== 0) {
        if (flags.verbose && stderr) {
          console.error(`   stderr: ${stderr.slice(0, 500)}`);
        }
        resolve({
          success: false,
          duration,
          output: null,
          error: `Process exited with code ${code}`
        });
        return;
      }
      
      resolve({
        success: true,
        duration,
        output: output,
        error: null
      });
    });
    
    // Handle errors
    claudeProcess.on('error', (error) => {
      if (processCompleted) return;
      processCompleted = true;
      
      console.error('   Process error:', error.message);
      resolve({
        success: false,
        duration: Date.now() - startTime,
        output: null,
        error: error.message
      });
    });
    
    // Timeout handling
    setTimeout(() => {
      if (!processCompleted) {
        processCompleted = true;
        claudeProcess.kill('SIGTERM');
        console.log('   ⏱️  Step timed out');
        resolve({
          success: false,
          duration: timeout,
          output: null,
          error: 'Timeout'
        });
      }
    }, timeout);
  });
}

/**
 * Main stream chain command
 */
export async function streamChainCommand(args, flags) {
  const subcommand = args[0] || 'help';
  
  if (subcommand === 'help') {
    showHelp();
    return;
  }
  
  // Check Claude CLI availability
  if (!checkClaudeAvailable()) {
    console.error('❌ Claude CLI not found');
    console.log('\nPlease install Claude CLI to use real stream chaining:');
    console.log('  npm install -g @anthropic-ai/claude-cli');
    console.log('  Or use Claude Code: https://claude.ai/code');
    console.log('\nFor documentation, see: docs/stream-chaining.md');
    return;
  }
  
  switch (subcommand) {
    case 'demo':
      await runDemo(flags);
      break;
      
    case 'run':
      await runCustom(args.slice(1), flags);
      break;
      
    case 'test':
      await runTest(flags);
      break;
      
    case 'pipeline':
      await runPipeline(args.slice(1), flags);
      break;
      
    default:
      console.error(`❌ Unknown subcommand: ${subcommand}`);
      showHelp();
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
🔗 Stream Chain Command - Real Claude CLI Stream-JSON Chaining

DESCRIPTION
    Connect multiple Claude instances using stream-json format.
    Each agent receives the full output from the previous agent,
    enabling complex multi-agent workflows with context preservation.

USAGE
    stream-chain <subcommand> [options]

SUBCOMMANDS
    run <p1> <p2> [...]  Execute custom chain (min 2 prompts)
    demo                 Run 3-step demo with real chaining
    test                 Test stream connection
    pipeline <type>      Run predefined pipeline
    help                 Show this help

PIPELINE TYPES
    analysis    Analyze → Identify → Report
    refactor    Identify → Plan → Implement
    test        Coverage → Design → Generate
    optimize    Profile → Identify → Optimize

OPTIONS
    --verbose            Show detailed execution info
    --timeout <seconds>  Timeout per step (default: 30)

EXAMPLES
    stream-chain demo
    stream-chain run "Analyze this" "Improve it" "Finalize"
    stream-chain pipeline analysis --verbose
    stream-chain test --timeout 10

STREAM-JSON FORMAT
    {"type":"init","session_id":"..."}
    {"type":"message","role":"assistant","content":[...]}
    {"type":"tool_use","name":"...","input":{...}}
    {"type":"tool_result","output":"..."}
    {"type":"result","status":"success"}

DOCUMENTATION
    Full docs: ./claude-flow-wiki/Stream-Chain-Command.md
    Spec: ./docs/stream-chaining.md
  `);
}

/**
 * Run demo
 */
async function runDemo(flags) {
  console.log('🎭 Running Real Stream Chain Demo');
  console.log('━'.repeat(50));
  console.log('Demonstrating 3-step chain with context preservation\n');
  
  const prompts = [
    "Write a simple Python function to reverse a string",
    "Review the code and suggest improvements",
    "Apply the improvements and create the final version"
  ];
  
  console.log('📝 Chain:', prompts.map(p => p.slice(0, 30) + '...').join(' → '));
  
  const results = await executeRealChain(prompts, flags);
  showSummary(results);
}

/**
 * Run custom chain
 */
async function runCustom(prompts, flags) {
  if (prompts.length < 2) {
    console.error('❌ Need at least 2 prompts');
    console.log('Usage: stream-chain run "prompt1" "prompt2"');
    return;
  }
  
  console.log('🔗 Starting Custom Stream Chain');
  console.log('━'.repeat(50));
  console.log(`📝 Chain length: ${prompts.length} steps\n`);
  
  const results = await executeRealChain(prompts, flags);
  showSummary(results);
}

/**
 * Run test
 */
async function runTest(flags) {
  console.log('🧪 Testing Stream Connection');
  console.log('━'.repeat(50));
  
  const prompts = [
    "Say exactly: 'Test 1 OK'",
    "If you received 'Test 1 OK', say 'Test 2 OK - Chain working'"
  ];
  
  const results = await executeRealChain(prompts, { ...flags, verbose: true });
  
  console.log('\n📊 Test Results:');
  const allPassed = results.every(r => r.success);
  console.log(allPassed ? '✅ All tests passed!' : '❌ Some tests failed');
}

/**
 * Run pipeline
 */
async function runPipeline(args, flags) {
  const type = args[0] || 'analysis';
  
  const pipelines = {
    analysis: [
      "Analyze the current directory structure",
      "Identify areas for improvement",
      "Generate a detailed report"
    ],
    refactor: [
      "Find code that needs refactoring",
      "Create a refactoring plan",
      "Show refactored examples"
    ],
    test: [
      "Analyze test coverage",
      "Design test cases",
      "Generate test code"
    ],
    optimize: [
      "Profile for bottlenecks",
      "Identify optimizations",
      "Provide optimized code"
    ]
  };
  
  const pipeline = pipelines[type];
  if (!pipeline) {
    console.error(`❌ Unknown pipeline: ${type}`);
    console.log('Available:', Object.keys(pipelines).join(', '));
    return;
  }
  
  console.log(`🚀 Running ${type} pipeline`);
  console.log('━'.repeat(50));
  
  const results = await executeRealChain(pipeline, flags);
  showSummary(results);
}

/**
 * Show execution summary
 */
function showSummary(results) {
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Chain Summary');
  console.log('═'.repeat(50));
  
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`${status} Step ${r.step}: ${r.prompt}... (${r.duration}ms)`);
  }
  
  const total = results.reduce((sum, r) => sum + r.duration, 0);
  const success = results.filter(r => r.success).length;
  
  console.log(`\n⏱️  Total: ${total}ms`);
  console.log(`📈 Success: ${success}/${results.length} steps`);
  
  if (success === results.length) {
    console.log('🎉 Chain completed successfully!');
  }
}

export default streamChainCommand;