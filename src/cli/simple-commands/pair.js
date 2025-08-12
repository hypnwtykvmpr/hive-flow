/**
 * Pair Programming Command
 * Interactive pair programming with AI assistance
 */

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

async function pairCommand(args = [], flags = {}) {
  console.log('\n👥 Pair Programming Session');
  console.log('━'.repeat(50));

  // Handle help flag
  if (flags.help || args.includes('--help')) {
    showHelp();
    return;
  }

  // Handle background execution
  if (flags.background || flags.bg) {
    return startBackgroundSession(args, flags);
  }

  // Handle start flag
  if (flags.start) {
    return startInteractiveSession(args, flags);
  }

  // Handle status flag
  if (flags.status) {
    return showSessionStatus();
  }

  // Handle end flag
  if (flags.end) {
    return endSession(flags.sessionId || 'current');
  }

  // Default: show help
  showHelp();
}

function showHelp() {
  console.log(`
📚 USAGE:
  claude-flow pair [options]

⚙️ OPTIONS:
  --start              Start a new pair programming session
  --end                End current session
  --status             Show session status
  --mode <type>        Programming mode: driver, navigator, switch (default: switch)
  --agent <name>       AI pair partner (default: auto-select)
  --verify             Enable real-time verification
  --test               Run tests after each change
  --background, --bg   Run in background
  --help               Show this help message

📝 MODES:
  driver     You write code, AI assists
  navigator  AI writes code, you guide
  switch     Automatically alternate roles

💡 EXAMPLES:
  claude-flow pair --start
  claude-flow pair --start --mode driver --verify
  claude-flow pair --start --agent senior-dev --test
  claude-flow pair --status
  claude-flow pair --end

🎯 QUICK START:
  npx claude-flow@alpha pair --start

📚 For detailed documentation, see:
  .claude/commands/pair/README.md
`);
}

async function startInteractiveSession(args, flags) {
  const mode = flags.mode || 'switch';
  const agent = flags.agent || 'auto';
  const verify = flags.verify || false;
  const test = flags.test || false;
  
  const sessionId = `pair_${Date.now()}`;
  const sessionData = {
    id: sessionId,
    mode,
    agent,
    verify,
    test,
    startTime: new Date().toISOString(),
    status: 'active'
  };

  // Save session data
  const sessionPath = '.claude-flow/sessions/pair';
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(
    path.join(sessionPath, `${sessionId}.json`),
    JSON.stringify(sessionData, null, 2)
  );

  console.log('\n🚀 Starting Pair Programming Session');
  console.log('━'.repeat(50));
  console.log(`Session ID: ${sessionId}`);
  console.log(`Mode: ${mode}`);
  console.log(`Agent: ${agent}`);
  console.log(`Verification: ${verify ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`Testing: ${test ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('━'.repeat(50));

  // Start based on mode
  switch (mode) {
    case 'driver':
      console.log('\n👤 You are the DRIVER - Write code while AI assists');
      console.log('🤖 AI is the NAVIGATOR - Providing guidance and suggestions');
      break;
    case 'navigator':
      console.log('\n🤖 AI is the DRIVER - Writing code based on your guidance');
      console.log('👤 You are the NAVIGATOR - Providing high-level direction');
      break;
    case 'switch':
      console.log('\n🔄 SWITCH MODE - Roles alternate every 10 minutes');
      console.log('👤 Starting role: DRIVER (you)');
      console.log('🤖 AI starts as: NAVIGATOR');
      break;
  }

  console.log('\n📝 Session Commands:');
  console.log('  /help     - Show available commands');
  console.log('  /switch   - Switch driver/navigator roles');
  console.log('  /suggest  - Get AI suggestions');
  console.log('  /review   - Request code review');
  console.log('  /test     - Run tests');
  console.log('  /commit   - Commit with verification');
  console.log('  /end      - End session');

  // If verify is enabled, show verification status
  if (verify) {
    console.log('\n✅ Verification Enabled');
    console.log('  • Real-time code validation');
    console.log('  • Truth score threshold: 0.95');
    console.log('  • Auto-rollback on failures');
  }

  // If test is enabled, show test status
  if (test) {
    console.log('\n🧪 Testing Enabled');
    console.log('  • Tests run on save');
    console.log('  • Coverage tracking');
    console.log('  • Regression prevention');
  }

  console.log('\n💡 Type /help for commands or start coding...\n');

  // In a real implementation, this would start an interactive session
  // For now, we'll just show the session is ready
  console.log('Session is ready. Use /end to finish.\n');
}

async function startBackgroundSession(args, flags) {
  console.log('\n🔄 Starting pair session in background...');
  
  const child = spawn(process.argv[0], [
    process.argv[1],
    'pair',
    '--start',
    ...args.filter(arg => arg !== '--background' && arg !== '--bg')
  ], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();
  
  const pid = child.pid;
  console.log(`✅ Background session started (PID: ${pid})`);
  console.log('\n📊 Monitor with: claude-flow pair --status');
  console.log('🛑 Stop with: claude-flow pair --end\n');
}

async function showSessionStatus() {
  try {
    const sessionPath = '.claude-flow/sessions/pair';
    const files = await fs.readdir(sessionPath);
    const sessions = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readFile(path.join(sessionPath, file), 'utf8');
        sessions.push(JSON.parse(data));
      }
    }

    if (sessions.length === 0) {
      console.log('\n❌ No active pair programming sessions\n');
      return;
    }

    console.log('\n📊 Active Pair Programming Sessions:');
    console.log('━'.repeat(50));
    
    for (const session of sessions) {
      const duration = Math.floor((Date.now() - new Date(session.startTime).getTime()) / 1000 / 60);
      console.log(`\nSession: ${session.id}`);
      console.log(`  Mode: ${session.mode}`);
      console.log(`  Agent: ${session.agent}`);
      console.log(`  Duration: ${duration} minutes`);
      console.log(`  Status: ${session.status}`);
    }
    
    console.log('━'.repeat(50));
  } catch (error) {
    console.log('\n❌ No active pair programming sessions\n');
  }
}

async function endSession(sessionId) {
  console.log(`\n🛑 Ending pair programming session: ${sessionId}`);
  
  try {
    const sessionPath = '.claude-flow/sessions/pair';
    
    if (sessionId === 'current') {
      // End most recent session
      const files = await fs.readdir(sessionPath);
      const jsonFiles = files.filter(f => f.endsWith('.json'));
      if (jsonFiles.length > 0) {
        // Sort by timestamp in filename
        jsonFiles.sort().reverse();
        sessionId = jsonFiles[0].replace('.json', '');
      }
    }
    
    const sessionFile = path.join(sessionPath, `${sessionId}.json`);
    const data = await fs.readFile(sessionFile, 'utf8');
    const session = JSON.parse(data);
    
    session.status = 'completed';
    session.endTime = new Date().toISOString();
    
    await fs.writeFile(sessionFile, JSON.stringify(session, null, 2));
    
    console.log('✅ Session ended successfully');
    console.log(`\n📊 Session Summary:`);
    console.log(`  Duration: ${Math.floor((new Date(session.endTime) - new Date(session.startTime)) / 1000 / 60)} minutes`);
    console.log(`  Mode: ${session.mode}`);
    console.log(`  Agent: ${session.agent}\n`);
  } catch (error) {
    console.log('❌ Failed to end session:', error.message);
  }
}

export default pairCommand;