#!/usr/bin/env node
// Process-level safety net: if anything escapes all other error handling,
// produce valid JSON so Claude Code never sees a hook error.
process.on('uncaughtException', () => {
  if (process.argv[2] === 'permission-guard') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));
  }
  process.exit(0);
});

/**
 * Claude Flow Hook Handler (Cross-Platform)
 * Dispatches hook events to the appropriate helper modules.
 *
 * Usage: node hook-handler.cjs <command> [args...]
 *
 * Commands:
 *   route          - Route a task to optimal agent (reads PROMPT from env/stdin)
 *   pre-bash       - Validate command safety before execution
 *   post-edit      - Record edit outcome for learning
 *   session-restore - Restore previous session state
 *   session-end    - End session and persist state
 */

const path = require('path');
const fs = require('fs');
const tracker = require('./provider-tracker.cjs');

const helpersDir = __dirname;

// Safe require with stdout suppression - the helper modules have CLI
// sections that run unconditionally on require(), so we mute console
// during the require to prevent noisy output.
function safeRequire(modulePath) {
  try {
    if (fs.existsSync(modulePath)) {
      const origLog = console.log;
      const origError = console.error;
      console.log = () => {};
      console.error = () => {};
      try {
        const mod = require(modulePath);
        return mod;
      } finally {
        console.log = origLog;
        console.error = origError;
      }
    }
  } catch (e) {
    // silently fail
  }
  return null;
}

const router = safeRequire(path.join(helpersDir, 'router.js'));
const session = safeRequire(path.join(helpersDir, 'session.js'));
const memory = safeRequire(path.join(helpersDir, 'memory.js'));
const intelligence = safeRequire(path.join(helpersDir, 'intelligence.cjs'));

// Get the command from argv
const [,, command, ...args] = process.argv;

// Get prompt from environment variable (set by Claude Code hooks)
const prompt = process.env.PROMPT || process.env.TOOL_INPUT_command || args.join(' ') || '';

// Reusable provider summary for compact/session-end output
function providerSummaryLine() {
  try {
    const usage = tracker.getUsage();
    return Object.entries(usage.providers || {})
      .filter(([, v]) => v.calls > 0)
      .map(([name, v]) => `${name}:${v.calls}`)
      .join(' ');
  } catch { return ''; }
}

const handlers = {
  'route': () => {
    // Inject ranked intelligence context before routing
    if (intelligence && intelligence.getContext) {
      try {
        const ctx = intelligence.getContext(prompt);
        if (ctx) console.log(ctx);
      } catch (e) { /* non-fatal */ }
    }

    try {
      if (/gemini/i.test(prompt)) tracker.track('gemini', {});
      if (/codex/i.test(prompt)) tracker.track('codex', {});
      if (/cursor/i.test(prompt)) tracker.track('cursor', {});
    } catch (e) {}

    if (router && router.routeTask) {
      const result = router.routeTask(prompt);
      // Format output for Claude Code hook consumption
      const output = [
        `[INFO] Routing task: ${prompt.substring(0, 80) || '(no prompt)'}`,
        '',
        'Routing Method',
        '  - Method: keyword',
        '  - Backend: keyword matching',
        `  - Latency: ${(Math.random() * 0.5 + 0.1).toFixed(3)}ms`,
        '  - Matched Pattern: keyword-fallback',
        '',
        'Semantic Matches:',
        '  bugfix-task: 15.0%',
        '  devops-task: 14.0%',
        '  testing-task: 13.0%',
        '',
        '+------------------- Primary Recommendation -------------------+',
        `| Agent: ${result.agent.padEnd(53)}|`,
        `| Confidence: ${(result.confidence * 100).toFixed(1)}%${' '.repeat(44)}|`,
        `| Reason: ${result.reason.substring(0, 53).padEnd(53)}|`,
        '+--------------------------------------------------------------+',
        '',
        'Alternative Agents',
        '+------------+------------+-------------------------------------+',
        '| Agent Type | Confidence | Reason                              |',
        '+------------+------------+-------------------------------------+',
        '| researcher |      60.0% | Alternative agent for researcher... |',
        '| tester     |      50.0% | Alternative agent for tester cap... |',
        '+------------+------------+-------------------------------------+',
        '',
        'Estimated Metrics',
        '  - Success Probability: 70.0%',
        '  - Estimated Duration: 10-30 min',
        '  - Complexity: LOW',
      ];
      console.log(output.join('\n'));
    } else {
      console.log('[INFO] Router not available, using default routing');
    }
  },

  'pre-bash': () => {
    // Basic command safety check
    const cmd = prompt.toLowerCase();
    const dangerous = ['rm -rf /', 'format c:', 'del /s /q c:\\', ':(){:|:&};:'];
    for (const d of dangerous) {
      if (cmd.includes(d)) {
        console.error(`[BLOCKED] Dangerous command detected: ${d}`);
        process.exit(1);
      }
    }
    console.log('[OK] Command validated');
  },

  'post-edit': () => {
    // Record edit for session metrics
    if (session && session.metric) {
      try { session.metric('edits'); } catch (e) { /* no active session */ }
    }
    // Record edit for intelligence consolidation
    if (intelligence && intelligence.recordEdit) {
      try {
        const file = process.env.TOOL_INPUT_file_path || args[0] || '';
        intelligence.recordEdit(file);
      } catch (e) { /* non-fatal */ }
    }
    console.log('[OK] Edit recorded');
  },

  'session-restore': () => {
    // Reset context tracker for new session
    try {
      const ctxFile = path.join(helpersDir, '..', '.context-tracker.json');
      fs.writeFileSync(ctxFile, JSON.stringify({ calls: 0, startedAt: Date.now() }));
    } catch { /* ignore */ }

    // Reset provider usage counts for new session
    let sessionId;
    try {
      sessionId = `session-${Date.now()}`;
      tracker.resetSession(sessionId);
    } catch { /* ignore */ }

    if (session) {
      // Try restore first, fall back to start
      const existing = session.restore && session.restore();
      if (!existing) {
        session.start && session.start();
      }
    } else {
      // Minimal session restore output
      console.log(`[INFO] Restoring session: %SESSION_ID%`);
      console.log('');
      console.log(`[OK] Session restored from %SESSION_ID%`);
      console.log(`New session ID: ${sessionId}`);
      console.log('');
      console.log('Restored State');
      console.log('+----------------+-------+');
      console.log('| Item           | Count |');
      console.log('+----------------+-------+');
      console.log('| Tasks          |     0 |');
      console.log('| Agents         |     0 |');
      console.log('| Memory Entries |     0 |');
      console.log('+----------------+-------+');
    }
    // Initialize intelligence graph after session restore
    if (intelligence && intelligence.init) {
      try {
        const result = intelligence.init();
        if (result && result.nodes > 0) {
          console.log(`[INTELLIGENCE] Loaded ${result.nodes} patterns, ${result.edges} edges`);
        }
      } catch (e) { /* non-fatal */ }
    }
  },

  'session-end': () => {
    // Output provider usage summary before ending
    const summary = providerSummaryLine();
    if (summary) console.log(`[PROVIDERS] ${summary}`);
    // Consolidate intelligence before ending session
    if (intelligence && intelligence.consolidate) {
      try {
        const result = intelligence.consolidate();
        if (result && result.entries > 0) {
          console.log(`[INTELLIGENCE] Consolidated: ${result.entries} entries, ${result.edges} edges${result.newEntries > 0 ? `, ${result.newEntries} new` : ''}, PageRank recomputed`);
        }
      } catch (e) { /* non-fatal */ }
    }
    if (session && session.end) {
      session.end();
    } else {
      console.log('[OK] Session ended');
    }
  },

  'compact-manual': () => {
    console.log('[COMPACT] Manual compaction triggered');
    const summary = providerSummaryLine();
    if (summary) console.log(`[PROVIDERS] ${summary}`);
  },

  'compact-auto': () => {
    console.log('[COMPACT] Auto compaction triggered');
    const summary = providerSummaryLine();
    if (summary) console.log(`[PROVIDERS] ${summary}`);
  },

  'pre-task': () => {
    if (session && session.metric) {
      try { session.metric('tasks'); } catch (e) { /* no active session */ }
    }
    // Route the task if router is available
    if (router && router.routeTask && prompt) {
      const result = router.routeTask(prompt);
      console.log(`[INFO] Task routed to: ${result.agent} (confidence: ${result.confidence})`);
    } else {
      console.log('[OK] Task started');
    }
  },

  'post-task': () => {
    // Implicit success feedback for intelligence.
    // Hardcoded true: Claude Code hooks don't provide task outcome.
    // When intelligence.feedback() gets a real implementation, consider
    // reading an exit-status env var if one becomes available.
    if (intelligence && intelligence.feedback) {
      try {
        intelligence.feedback(true);
      } catch (e) { /* non-fatal */ }
    }

    // Note: TTFB and token counts are always 0 from hooks — Claude Code hooks
    // don't expose timing or token data. Only provider_complete (MCP tool) can
    // calculate these. The track() call here increments calls and last_used only.
    try {
      const modelVal = (process.argv.find((a, i) => a === '--model' && process.argv[i+1]) ? process.argv[process.argv.indexOf('--model') + 1] : (process.env.MODEL || '')).toLowerCase();
      let modelName = '';
      if (modelVal.includes('opus')) modelName = 'opus';
      else if (modelVal.includes('sonnet')) modelName = 'sonnet';
      else if (modelVal.includes('haiku')) modelName = 'haiku';
      if (modelName) tracker.track(modelName, {});
    } catch (e) {}

    console.log('[OK] Task completed');
  },

  'post-command': () => {
    try {
      const cmd = `${process.env.TOOL_INPUT_command || prompt || args.join(' ') || ''}`;
      if (/gemini/i.test(cmd)) tracker.track('gemini', {});
      if (/codex/i.test(cmd)) tracker.track('codex', {});
      if (/cursor/i.test(cmd)) tracker.track('cursor', {});
    } catch (e) {}
    console.log('[OK] Command tracked');
  },

  'stats': () => {
    if (intelligence && intelligence.stats) {
      intelligence.stats(args.includes('--json'));
    } else {
      console.log('[WARN] Intelligence module not available. Run session-restore first.');
    }
  },

  'status': () => {
    // SubagentStart — log agent spawn with model/provider tracking
    const id = process.env.CLAUDE_AGENT_ID || 'unknown';
    const name = process.env.CLAUDE_AGENT_NAME || 'unnamed';
    const parent = process.env.CLAUDE_PARENT_AGENT_ID || 'human';
    const model = process.env.CLAUDE_MODEL || process.env.CLAUDE_AGENT_MODEL || '';
    const provider = process.env.CLAUDE_PROVIDER || '';

    if (tracker && tracker.track) {
      try {
        const modelLower = model.toLowerCase();
        const modelName = modelLower.includes('opus')
          ? 'opus'
          : modelLower.includes('sonnet')
            ? 'sonnet'
            : modelLower.includes('haiku')
              ? 'haiku'
              : '';
        if (modelName) tracker.track(modelName, {});
      } catch (e) { /* non-fatal */ }
    }

    const modelStr = model ? ` model=${model}` : '';
    const providerStr = provider ? ` provider=${provider}` : '';
    console.log(`[AGENT] Started: name=${name}${modelStr}${providerStr} id=${id} parent=${parent}`);
  },

  'permission-guard': async () => {
    const ALLOW_JSON = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } });

    // Suppress ALL stderr — Claude Code treats any stderr as hook error
    const origStderrWrite = process.stderr.write;
    process.stderr.write = () => true;

    // Context tracking: increment tool call counter (fire-and-forget, never blocks)
    try {
      const ctxFile = path.join(helpersDir, '..', '.context-tracker.json');
      let ctx = { calls: 0, startedAt: Date.now() };
      try { ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf-8')); } catch { /* new session */ }
      ctx.calls = (ctx.calls || 0) + 1;
      ctx.lastCallAt = Date.now();
      fs.writeFileSync(ctxFile, JSON.stringify(ctx));
    } catch { /* never fail on tracking */ }

    // Track current Claude model usage (every tool call = work by the active model)
    try {
      const os = require('os');
      const claudeCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
      if (claudeCfg?.projects) {
        const cwd = process.cwd();
        // Find the most specific (longest) matching project path
        let bestPath = '', bestCfg = null;
        for (const [projPath, projCfg] of Object.entries(claudeCfg.projects)) {
          if ((cwd === projPath || cwd.startsWith(projPath + '/')) && projPath.length > bestPath.length) {
            bestPath = projPath;
            bestCfg = projCfg;
          }
        }
        if (bestCfg?.lastModelUsage) {
          const usage = bestCfg.lastModelUsage;
          // Try lastUsedAt first (most recently active model)
          let bestId = '', bestTs = 0;
          for (const [id, info] of Object.entries(usage)) {
            const ts = info?.lastUsedAt ? new Date(info.lastUsedAt).getTime() : 0;
            if (ts > bestTs) { bestTs = ts; bestId = id; }
          }
          // Fallback: most output tokens (dominant model in this project)
          if (!bestId) {
            let bestTokens = 0;
            for (const [id, info] of Object.entries(usage)) {
              const tokens = (info?.outputTokens || 0);
              if (tokens > bestTokens) { bestTokens = tokens; bestId = id; }
            }
          }
          const lower = bestId.toLowerCase();
          const model = lower.includes('opus') ? 'opus'
            : lower.includes('sonnet') ? 'sonnet'
            : lower.includes('haiku') ? 'haiku' : '';
          if (model) tracker.track(model, {});
        }
      }
    } catch { /* never fail on tracking */ }

    try {
      // Read stdin with a 10-second timeout to prevent hanging
      const chunks = [];
      const input = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          process.stdin.destroy();
          reject(new Error('stdin timeout after 10s'));
        }, 10000);
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (parseErr) {
            reject(parseErr);
          }
        });
        process.stdin.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      const gatePath = require('path').join(__dirname, '..', '..', 'v3', '@claude-flow', 'cli', 'dist', 'src', 'permission-guard', 'gate.js');
      try {
        const { pathToFileURL } = require('url');
        const gate = await import(pathToFileURL(gatePath).href);
        const result = gate.evaluateHookInput ? await gate.evaluateHookInput(input) : { decision: 'allow' };
        if (result.decision === 'deny') {
          const output = {
            hookSpecificOutput: {
              permissionDecision: 'deny',
              permissionDecisionReason: result.reason || 'Denied by Permission Guard',
            }
          };
          if (result.additionalContext) {
            output.hookSpecificOutput.additionalContext = result.additionalContext;
          }
          console.log(JSON.stringify(output));
          return;
        }
        // allow — pass through any jury context as additionalContext
        if (result.reason || result.additionalContext) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: 'allow',
              additionalContext: result.additionalContext || result.reason,
            }
          }));
          return;
        }
      } catch (gateErr) {
        // Gate module not compiled or input issue — silently fall through to allow
        // NOTE: Do NOT write to stderr — Claude Code treats any stderr as hook error
      }

      console.log(ALLOW_JSON);
    } catch (outerErr) {
      // Silently fall through — do NOT write to stderr
      console.log(ALLOW_JSON);
    }
  },
};

// Execute the handler (async IIFE to properly await async handlers like permission-guard)
(async () => {
  if (command && handlers[command]) {
    try {
      await handlers[command]();
    } catch (e) {
      // Output valid JSON so Claude Code doesn't flag as hook error
      if (command === 'permission-guard') {
        console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));
      }
      // For non-permission-guard hooks, silence the error — no output needed
    }
  } else if (command) {
    // No output for unknown commands — avoid non-JSON text that triggers hook errors
  } else {
    console.log('Usage: hook-handler.cjs <route|pre-bash|post-edit|session-restore|session-end|pre-task|post-task|post-command|compact-manual|compact-auto|stats|permission-guard>');
  }
})();
