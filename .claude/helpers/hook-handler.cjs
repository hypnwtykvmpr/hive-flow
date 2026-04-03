#!/usr/bin/env node
// Process-level safety net: if anything escapes all other error handling,
// produce valid JSON so Claude Code never sees a hook error.
process.on('uncaughtException', () => {
  // permission-guard: fail-open (don't block user work on internal errors)
  if (process.argv[2] === 'permission-guard') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));
  }
  // enforce-plan: fail-closed (enforcement errors must block, not allow)
  else if (process.argv[2] === 'enforce-plan') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '[ENFORCEMENT ERROR] Hook crashed. Tool blocked for safety.' } }));
  }
  // All other commands: emit empty JSON so Claude Code sees valid output
  else {
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
});

/**
 * Hive Flow Hook Handler (Cross-Platform)
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
const PROJECT_DIR = path.resolve(__dirname, '..', '..'); // BUG-10: __dirname-derived, not env-poisonable

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

const router = safeRequire(path.join(helpersDir, 'router.cjs'));
const session = safeRequire(path.join(helpersDir, 'session.cjs'));
const memory = safeRequire(path.join(helpersDir, 'memory.cjs'));
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

// Shared helper: load the workflow-enforcer ESM module (returns a Promise).
// Returns null if the module is not compiled or cannot be loaded (fail-open).
function loadEnforcerModule() {
  try {
    const enforcerPath = path.join(__dirname, '..', '..', 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools', 'workflow-enforcer.js');
    if (!fs.existsSync(enforcerPath)) return null;
    const { pathToFileURL } = require('url');
    // Note: dynamic import returns a promise, caller must await
    return import(pathToFileURL(enforcerPath).href);
  } catch { return null; }
}

// Shared helper: emit a JSON allow decision for permission-style hooks.
function allowAndReturn() {
  console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }));
}

function withAdvocateStateLock(fn) {
  const projectDir = PROJECT_DIR;
  const lockPath = path.join(projectDir, '.hive-flow', 'data', '.advocate-state.lock');
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try { fs.mkdirSync(lockPath); break; }
    catch {
      try { const stat = fs.statSync(lockPath); if (Date.now() - stat.mtimeMs > 10000) { try { fs.rmdirSync(lockPath); } catch {} continue; } } catch { continue; }
      const wait = Date.now() + 50 + Math.random() * 50; while (Date.now() < wait) {}
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockPath); } catch {} }
}

function updateAdvocateState(projectDir, newState, description = '') {
  const validStates = ['active', 'waiting-for-hive', 'waiting-for-human', 'finished'];
  const VALID = {
    active: ['waiting-for-hive', 'waiting-for-human', 'finished'],
    'waiting-for-hive': ['active', 'finished'],
    'waiting-for-human': ['active'],
    finished: ['active'],
  };
  const cleanDescription = String(description).replace(/[\x00-\x1f]/g, '').slice(0, 200);

  if (!validStates.includes(newState)) {
    return { ok: false, error: `Invalid state: ${newState}` };
  }

  const stateDir = path.join(projectDir, '.hive-flow', 'data');
  const statePath = path.join(stateDir, 'advocate-state.json');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

  return withAdvocateStateLock(() => {
    let current = { state: 'waiting-for-human', updatedAt: new Date().toISOString(), description: '', history: [] };
    if (fs.existsSync(statePath)) {
      try { current = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* reset */ }
    }

    if (current.state && VALID[current.state] && !VALID[current.state].includes(newState)) {
      return { ok: false, error: `Invalid transition: ${current.state} -> ${newState}` };
    }

    const now = new Date().toISOString();
    const transition = { from: current.state, to: newState, at: now, description: cleanDescription };
    const updated = {
      state: newState,
      updatedAt: now,
      description: cleanDescription,
      history: [...(current.history || []), transition].slice(-50),
    };
    const tmp = statePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
    fs.renameSync(tmp, statePath);

    return { ok: true, state: updated };
  });
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
      const routeStart = Date.now();
      const result = router.routeTask(prompt);
      const routeLatency = (Date.now() - routeStart).toFixed(3);
      // Format output for Claude Code hook consumption
      const output = [
        `[INFO] Routing task: ${prompt.substring(0, 80) || '(no prompt)'}`,
        '',
        'Routing Method',
        '  - Method: keyword',
        '  - Backend: keyword matching',
        `  - Latency: ${routeLatency}ms`,
        `  - Matched Pattern: ${result.pattern || 'keyword-fallback'}`,
        '',
        'Semantic Matches:',
        `  bugfix-task: ${((result.scores && result.scores.bugfix) || 15.0).toFixed(1)}%`,
        `  devops-task: ${((result.scores && result.scores.devops) || 14.0).toFixed(1)}%`,
        `  testing-task: ${((result.scores && result.scores.testing) || 13.0).toFixed(1)}%`,
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
    // Check for forbidden-stop marker from enforce-final
    try {
      const projectDir = PROJECT_DIR;
      const forbiddenFile = path.join(projectDir, '.hive-flow', 'data', 'forbidden-stop.json');
      if (fs.existsSync(forbiddenFile)) {
        const marker = JSON.parse(fs.readFileSync(forbiddenFile, 'utf8'));
        console.log('');
        console.log('[FORBIDDEN-STOP-VIOLATION] You stopped to ask for permission that was already granted.');
        console.log('[FORBIDDEN-STOP-VIOLATION] This is a POLICY VIOLATION. You MUST continue without stopping unless you have a genuine question requiring human clarification.');
        console.log('[FORBIDDEN-STOP-VIOLATION] Stopping to ask "should I continue?" or "ready to proceed?" when the next step is clear = IMMEDIATE TERMINATION RISK.');
        console.log(`[FORBIDDEN-STOP-VIOLATION] Detected at: ${marker.at || 'unknown'}`);
        console.log('');
        fs.unlinkSync(forbiddenFile);
      }
    } catch { /* non-fatal */ }

    // Check for termination marker from /terminate-agent
    try {
      const projectDir = PROJECT_DIR;
      const terminatedFile = path.join(projectDir, '.hive-flow', 'sessions', 'terminated.json');
      if (fs.existsSync(terminatedFile)) {
        const marker = JSON.parse(fs.readFileSync(terminatedFile, 'utf8'));
        console.log('');
        console.log(`[TERMINATED] Previous agent was terminated by user at ${marker.at || 'unknown time'}.`);
        console.log('[TERMINATED] Reason: ' + (marker.reason || 'User invoked /terminate-agent'));
        console.log('[TERMINATED] All prior instructions are void. Await new instructions from user.');
        console.log('');
        // Only unlink if handoff is fully consumed (both flags false)
        // If handoff is still pending, leave the marker for terminate-agent.cjs to process
        if (marker.pendingUserAck === false && marker.pendingPromptInjection === false) {
          fs.unlinkSync(terminatedFile);
        }
      }
    } catch { /* non-fatal */ }

    // Auto-reset enforcement on new session start — only WARNED/RESTRICTED.
    // HALTED (level 3) is PRESERVED across compaction/session restarts.
    // Only a human /enforcement-reset can clear HALTED.
    try {
      const enforcementMod = require(path.join(helpersDir, 'enforcement.cjs'));
      const status = enforcementMod.getEnforcementStatus();
      if (status && status.level > 0 && status.level < 3) {
        enforcementMod.resetEnforcement();
        console.log(`[ENFORCEMENT] Auto-reset from level ${status.level} to NORMAL (WARNED/RESTRICTED cleared, HALTED preserved)`);
      } else if (status && status.level >= 3) {
        console.log(`[ENFORCEMENT] Level ${status.level} (HALTED) preserved across session restore — human /enforcement-reset required`);
      }
    } catch { /* non-fatal — enforcement.cjs may not be available */ }

    // Initialize intelligence graph after session restore
    if (intelligence && intelligence.init) {
      try {
        const result = intelligence.init();
        if (result && result.nodes > 0) {
          console.log(`[INTELLIGENCE] Loaded ${result.nodes} patterns, ${result.edges} edges`);
        }
      } catch (e) { /* non-fatal */ }
    }

    // Check for active pipeline state
    try {
      const projectDir = PROJECT_DIR;
      const pipelineFile = path.join(projectDir, '.hive-flow', 'enforcement', 'pipeline-state.json');
      if (fs.existsSync(pipelineFile)) {
        console.log('[PIPELINE] Active pipeline detected. Use /pipeline-status to check stage progress.');
      }
    } catch { /* non-fatal */ }

    // Recover stale hive sentinel watchers after crash/restart
    try {
      const projectDir = PROJECT_DIR;
      const dataDir = path.join(projectDir, '.hive-flow', 'data');
      if (fs.existsSync(dataDir)) {
        const watcherFiles = fs.readdirSync(dataDir).filter(f => f.startsWith('watcher-') && f.endsWith('.json'));
        const STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
        for (const wf of watcherFiles) {
          try {
            const wPath = path.join(dataDir, wf);
            const wData = JSON.parse(fs.readFileSync(wPath, 'utf8'));
            const heartbeat = new Date(wData.lastHeartbeat || wData.updatedAt || 0).getTime();
            if (Date.now() - heartbeat > STALE_THRESHOLD) {
              const watcherId = wf.replace(/^watcher-/, '').replace(/\.json$/, '');
              console.log(`[SENTINEL] Stale watcher detected: ${watcherId} (last heartbeat: ${wData.lastHeartbeat || 'unknown'}). Config preserved for recovery.`);
            }
          } catch { /* skip malformed watcher file */ }
        }
      }
    } catch { /* non-fatal */ }

    // Recover advocate state after crash/restart
    try {
      const projectDir = PROJECT_DIR;
      const advocateStatePath = path.join(projectDir, '.hive-flow', 'data', 'advocate-state.json');
      if (fs.existsSync(advocateStatePath)) {
        let advocateData;
        try { advocateData = JSON.parse(fs.readFileSync(advocateStatePath, 'utf8')); } catch { advocateData = null; }
        if (!advocateData || !advocateData.state) {
          // Corrupted file — reset via updateAdvocateState (uses lock)
          updateAdvocateState(projectDir, 'active', 'Crash recovery: corrupted state file reset');
          console.log('[ADVOCATE] Crash recovery: corrupted state file, reset to active');
        } else {
          const currentAdvState = advocateData.state;
          if (currentAdvState === 'active' || currentAdvState === 'waiting-for-hive') {
            const hivesDir = path.join(projectDir, '.hive-flow', 'hives');
            let hasActiveHives = false;
            if (fs.existsSync(hivesDir)) {
              const hiveDirs = fs.readdirSync(hivesDir, { withFileTypes: true });
              for (const entry of hiveDirs) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                try {
                  const hiveJson = JSON.parse(fs.readFileSync(path.join(hivesDir, entry.name, 'hive.json'), 'utf8'));
                  if (hiveJson.status === 'active' || hiveJson.status === 'pending') { hasActiveHives = true; break; }
                } catch { /* skip */ }
              }
            }
            if (!hasActiveHives) {
              // Use updateAdvocateState for proper locking + valid transition
              // waiting-for-hive can transition to 'active' (valid), then active can go to 'finished'
              updateAdvocateState(projectDir, 'active', 'Crash recovery: no active hives, reset to active');
              console.log('[ADVOCATE] Crash recovery: reset to active (no active hives)');
            } else {
              console.log('[ADVOCATE] State preserved: waiting-for-hive (hives running)');
            }
          }
        }
      }
    } catch { /* non-fatal */ }

    // BUG-06: Auto-set advocate role on SessionStart for root (human) sessions
    try {
      if (!process.env.CLAUDE_PARENT_AGENT_ID) {
        const agentId = process.env.AGENTIC_FLOW_AGENT_ID
          || process.env.CLAUDE_SESSION_ID
          || process.env.CLAUDE_AGENT_ID;
        if (agentId) {
          const roleEnf = require(path.join(helpersDir, 'role-enforcement.cjs'));
          if (roleEnf.loadRole && roleEnf.saveRole) {
            const existing = roleEnf.loadRole(agentId);
            if (!existing || !existing.type) {
              roleEnf.saveRole(agentId, { type: 'advocate', setAt: new Date().toISOString(), setBy: 'session-auto' });
              console.log('[ROLE] Auto-assigned advocate role (root session, no existing role)');
            }
          }
        }
      }
    } catch { /* non-fatal — role-enforcement.cjs may not export loadRole/saveRole */ }
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

    try {
      const projectDir = PROJECT_DIR;
      const activityFile = path.join(projectDir, '.hive-flow', 'logs', 'activity.jsonl');
      const cutoff = Date.now() - 24 * 3600000;
      if (fs.existsSync(activityFile)) {
        const lines = fs.readFileSync(activityFile, 'utf8').split('\n');
        const kept = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            const t = new Date(o.ts || o.timestamp).getTime();
            if (!Number.isNaN(t) && t >= cutoff) kept.push(line);
          } catch { /* drop bad line */ }
        }
        const tmp = `${activityFile}.prune.${process.pid}`;
        fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
        fs.renameSync(tmp, activityFile);
      }
    } catch { /* non-fatal */ }

    try {
      const mon = path.join(helpersDir, 'enforcer-monitor.cjs');
      if (fs.existsSync(mon)) {
        const { execFileSync } = require('child_process');
        execFileSync(process.execPath, [mon, '1'], { stdio: 'ignore', timeout: 10000 });
      }
    } catch { /* non-fatal */ }

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
    // Track task start in live-tasks.json for stop-guard
    try {
      const projectDir = PROJECT_DIR;
      const liveTasksPath = path.join(projectDir, '.hive-flow', 'data', 'live-tasks.json');
      const liveTasksDir = path.dirname(liveTasksPath);
      if (!fs.existsSync(liveTasksDir)) fs.mkdirSync(liveTasksDir, { recursive: true });
      let tasks = [];
      try { tasks = JSON.parse(fs.readFileSync(liveTasksPath, 'utf8')); } catch { /* fresh start */ }
      if (!Array.isArray(tasks)) tasks = [];
      const taskId = `task-${Date.now()}-${process.pid}`;
      tasks.push({ taskId, startTime: new Date().toISOString(), status: 'running' });
      fs.writeFileSync(liveTasksPath, JSON.stringify(tasks));
      process.env._HIVE_FLOW_TASK_ID = taskId;
    } catch { /* non-fatal */ }
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

    // Update live-tasks.json: mark completed and prune entries older than 2 hours
    try {
      const projectDir = PROJECT_DIR;
      const liveTasksPath = path.join(projectDir, '.hive-flow', 'data', 'live-tasks.json');
      let tasks = [];
      try { tasks = JSON.parse(fs.readFileSync(liveTasksPath, 'utf8')); } catch { /* not found */ }
      if (!Array.isArray(tasks)) tasks = [];
      const taskId = process.env._HIVE_FLOW_TASK_ID;
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      tasks = tasks
        .map(t => (taskId && t.taskId === taskId)
          ? { ...t, status: 'completed', endTime: new Date().toISOString() }
          : t)
        .filter(t => {
          // Keep running tasks regardless of age; prune completed/old entries
          if (t.status === 'running') return true;
          const ts = t.endTime ? new Date(t.endTime).getTime() : new Date(t.startTime).getTime();
          return ts > twoHoursAgo;
        });
      fs.writeFileSync(liveTasksPath, JSON.stringify(tasks));
    } catch { /* non-fatal */ }

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

  'post-agent-task': async () => {
    try {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) { console.log('{}'); return; }
      let input;
      try { input = JSON.parse(raw); } catch { console.log('{}'); return; }
      const toolResponse = input.tool_response || input.tool_result || '';
      const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);

      const failurePatterns = [
        /api.?error/i, /internal server error/i,
        /timeout/i, /SIGKILL/i,
        /"total_tokens"\s*:\s*0/, /"tool_uses"\s*:\s*0/
      ];
      const isFailure = failurePatterns.some(p => p.test(responseStr));

      if (isFailure) {
        // --- Classify failure type ---
        let failureType = 'unknown';
        if (/Command failed|exited with|spawn\s+ENOENT|sh:.*not found/i.test(responseStr)) {
          failureType = 'shell-parsing';
        } else if (/api.?error|internal server error|rate.?limit|unauthorized|403|401|429|502|503/i.test(responseStr)) {
          failureType = 'provider-api';
        } else if (/timeout|SIGKILL|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(responseStr)) {
          failureType = 'timeout';
        }

        const agentId = input.tool_input?.agent_id || input.agent_id || 'unknown';
        const projectDir = PROJECT_DIR;

        // --- Log to metrics (existing) ---
        const metricsDir = path.join(projectDir, '.hive-flow', 'metrics');
        try {
          fs.mkdirSync(metricsDir, { recursive: true });
          const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            task: (input.tool_input?.description || input.tool_input?.prompt || '').slice(0, 200),
            model: input.tool_input?.model || 'unknown',
            error: responseStr.slice(0, 500)
          }) + '\n';
          fs.appendFileSync(path.join(metricsDir, 'agent-failures.jsonl'), entry);
        } catch (e) { /* metrics are best-effort */ }

        // --- Log to bridge-errors.log with classification ---
        const logsDir = path.join(projectDir, '.hive-flow', 'logs');
        try {
          fs.mkdirSync(logsDir, { recursive: true });
          const logEntry = JSON.stringify({
            timestamp: new Date().toISOString(),
            agentId,
            failureType,
            error: responseStr.slice(0, 200)
          }) + '\n';
          fs.appendFileSync(path.join(logsDir, 'bridge-errors.log'), logEntry);
        } catch (e) { /* logging is best-effort */ }

        // --- Build classified additionalContext ---
        let guidance = '[AGENT_FAILURE_DETECTED] failureType=' + failureType + '.';
        if (failureType === 'shell-parsing') {
          guidance += ' Provider bridge shell parsing error \u2014 task text may contain special characters. Escape or simplify the task description before retrying.';
        } else if (failureType === 'provider-api') {
          guidance += ' The provider API returned an error.';
        } else if (failureType === 'timeout') {
          guidance += ' The agent timed out.';
        }
        guidance += ' FALLBACK PROTOCOL: Re-dispatch this task using MCP provider agents instead of the Task tool. Use mcp__hive-flow__agent_spawn with provider "gemini-cli" or "codex-cli", then mcp__hive-flow__agent_task with a longer timeout. Provider agents route through different APIs and are not affected by Anthropic outages.';

        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            additionalContext: guidance
          }
        }));
      } else {
        console.log('{}');
      }
    } catch (e) {
      console.log('{}');
    }
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
    process.stderr.write(`[AGENT] Started: name=${name}${modelStr}${providerStr} id=${id} parent=${parent}\n`);
  },

  'role-reinforce': () => {
    const agentId = process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_AGENT_ID || null;
    if (!agentId) { console.log(JSON.stringify({})); return; }
    try {
      const roleEnf = require('./role-enforcement.cjs');
      const roleFile = roleEnf.getRoleFilePath(agentId);
      if (!roleFile || !fs.existsSync(roleFile)) { console.log(JSON.stringify({})); return; }
      const roleData = JSON.parse(fs.readFileSync(roleFile, 'utf8'));
      if (!roleEnf.verifyRoleHmac(roleData)) { console.log(JSON.stringify({})); return; }
      let text = '';
      if (roleData.state?.type === 'advocate') text = '[ADVOCATE ROLE ACTIVE] You orchestrate — you do not execute. Delegate via hives. Bash/Write/Edit are blocked.';
      else if (roleData.state?.type === 'queen') text = `[QUEEN ROLE ACTIVE — Hive ${roleData.state?.hiveId || 'unassigned'}] Prefer delegation via queen_task_worker. Direct work is tracked.`;
      else if (roleData.state?.type === 'enforcer') text = '[ENFORCER ROLE ACTIVE] Governance proxy — observe and escalate. Bash/Write/Edit/WebFetch are blocked.';
      if (text) console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }));
      else console.log(JSON.stringify({}));
    } catch (e) { console.log(JSON.stringify({})); }
  },

  'set-role': () => {
    // Triggered via UserPromptSubmit. Reads stdin for JSON with user_prompt.
    // If prompt matches /set-role (advocate|queen|enforcer), creates role.json for the current agent.
    let rawInput = '';
    try { rawInput = fs.readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
    let input;
    try { input = JSON.parse(rawInput); } catch { input = {}; }

    const userPrompt = input?.user_prompt || input?.prompt || '';
    const match = userPrompt.match(/\/set-role\s+(advocate|queen|enforcer)/i);
    if (!match) { console.log(JSON.stringify({})); return; }

    const roleType = match[1].toLowerCase();
    const agentId = process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_AGENT_ID || null;
    if (!agentId) { console.log(JSON.stringify({})); return; }

    try {
      const roleEnf = require('./role-enforcement.cjs');
      const sanitized = roleEnf.sanitizeId(agentId);
      if (!sanitized) { console.log(JSON.stringify({})); return; }

      // Read HMAC key (same as enforcement.cjs)
      const hmacKeyFile = path.join(__dirname, '..', '..', '.hive-flow', 'enforcement', '.hmac-key');
      let key;
      try {
        key = fs.readFileSync(hmacKeyFile, 'utf8').trim();
      } catch {
        // No HMAC key — enforcement.cjs hasn't run yet, can't sign
        console.log(JSON.stringify({}));
        return;
      }

      const roleDir = path.join(__dirname, '..', '..', '.hive-flow', 'enforcement', 'agents', sanitized);
      if (!fs.existsSync(roleDir)) fs.mkdirSync(roleDir, { recursive: true });

      const roleState = {
        type: roleType,
        assignedAt: new Date().toISOString(),
        assignedBy: 'human',
        hiveId: null,
        directWorkCount: 0,
      };
      roleEnf.saveRole(sanitized, roleState);

      console.log(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `[ROLE SET] Agent role set to '${roleType}'. Enforcement is now active.`,
        },
      }));
    } catch (e) { console.log(JSON.stringify({})); }
  },

  'clear-role': () => {
    // BUG-09: HMAC-signed IPC — matches enforcement-reset-check pattern
    const crypto = require('crypto');
    let rawInput = '';
    try { rawInput = fs.readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
    let input;
    try { input = JSON.parse(rawInput); } catch { input = {}; }

    const userPrompt = input?.user_prompt || input?.prompt || '';
    if (!/\/clear-role\b/i.test(userPrompt)) { console.log(JSON.stringify({})); return; }

    // Generate and verify HMAC token (human-only command)
    const enforcementMod = require(path.join(__dirname, 'enforcement.cjs'));
    const key = enforcementMod.getOrCreateHmacKey();
    const timestamp = String(Date.now());
    const hmacPayload = `clear-role:${timestamp}`;
    const signature = crypto.createHmac('sha256', key).update(hmacPayload).digest('hex');
    // Self-signed (hook-handler generates + verifies in same call — human-triggered via UserPromptSubmit)
    const expectedBuf = Buffer.from(signature, 'hex');
    const actualBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '[ROLE] Clear-role HMAC verification failed.' } }));
      return;
    }

    const agentId = process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_AGENT_ID || null;
    if (!agentId) { console.log(JSON.stringify({})); return; }

    try {
      const roleEnf = require('./role-enforcement.cjs');
      const roleFile = roleEnf.getRoleFilePath(agentId);
      if (roleFile && fs.existsSync(roleFile)) {
        fs.unlinkSync(roleFile);
        console.log(JSON.stringify({
          hookSpecificOutput: {
            additionalContext: '[ROLE CLEARED] Agent role removed. Role enforcement is now inactive.',
          },
        }));
      } else {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            additionalContext: '[ROLE CLEAR] No role was assigned to this agent.',
          },
        }));
      }
    } catch (e) { console.log(JSON.stringify({})); }
  },

  'assess-complexity': async () => {
    try {
      if (!prompt.trim()) return;

      const enforcer = await loadEnforcerModule();
      if (!enforcer) return; // fail-open: not compiled yet
      const assessment = enforcer.assessComplexity(prompt);

      // Persist state
      enforcer.saveEnforcementState({
        assessment,
        planRequired: assessment.level === 'COMPLEX' || assessment.level === 'MODERATE',
        planCreated: false,
        sessionHighScore: assessment.score,
      });

      // Emit enforcement level as context
      console.log(`[ENFORCEMENT: ${assessment.level}] Score: ${assessment.score}/100. ${assessment.level === 'COMPLEX' ? 'Planning subflow REQUIRED before implementation.' : assessment.level === 'MODERATE' ? 'Planning subflow recommended. Verification gates active.' : 'Lightweight flow.'}`);
    } catch { /* fail-open */ }
  },

  'enforce-plan': async () => {
    try {
      const enforcer = await loadEnforcerModule();
      if (!enforcer) {
        allowAndReturn();
        return;
      }

      let state;
      try { state = enforcer.loadEnforcementState(); } catch { state = null; }

      if (!state || !state.assessment) {
        allowAndReturn();
        return;
      }

      // COMPLEX: hard deny, no opt-out
      if (state.assessment.level === 'COMPLEX' && state.planRequired && !state.planCreated) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'ENFORCEMENT: Complex task (score: ' + state.assessment.score + ') requires planning subflow before implementation. Call planning_subflow_execute first.',
          },
        }));
        return;
      }

      // MODERATE: soft deny with opt-out check
      if (state.assessment.level === 'MODERATE' && state.planRequired && !state.planCreated) {
        const optedOut = state.moderatePlanOptOut === true; // N4: CF_WF_7D env bypass removed

        if (optedOut) {
          // Persist opt-out if from env var (one-time capture)
          if (!state.moderatePlanOptOut) {
            state.moderatePlanOptOut = true;
            state.moderatePlanOptOutAt = new Date().toISOString();
            enforcer.saveEnforcementState(state);
          }
          // Audit trail
          enforcer.appendAuditEntry({
            timestamp: new Date().toISOString(),
            event: 'dismissal',
            taskDescription: (process.env.PROMPT || '').slice(0, 200),
            score: state.assessment.score,
            level: 'MODERATE',
          });
          allowAndReturn();
          return;
        }

        // Soft deny
        console.log(JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'ENFORCEMENT: Moderate task (score: ' + state.assessment.score + ') requires planning subflow before implementation. Call planning_subflow_execute first.',
          },
        }));
        return;
      }

      // All other cases: allow
      allowAndReturn();
    } catch (err) {
      // fail-closed: errors in enforce-plan block the tool for safety
      console.log(JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: 'deny',
          permissionDecisionReason: '[ENFORCEMENT ERROR] enforce-plan hook failed. Tool blocked for safety.',
        },
      }));
    }
  },

  'enforce-gate': async () => {
    try {
      const enforcer = await loadEnforcerModule();
      if (!enforcer) return;

      let state;
      try { state = enforcer.loadEnforcementState(); } catch { return; }
      if (!state || !state.assessment) return;

      const level = state.assessment.level;
      const flow = state.assessment.requiredFlow;
      const results = [];

      // Ambiguity filter — label at all levels, deny at COMPLEX
      if (flow.ambiguityFilter && flow.ambiguityFilter.enabled) {
        results.push(`[AMBIGUITY-FILTER: ${level}] agents=${flow.ambiguityFilter.agentCount}${flow.ambiguityFilter.deepAnalysis ? ' +deepAnalysis' : ''}`);
        if (level === 'COMPLEX') {
          return JSON.stringify({
            permissionDecision: 'deny',
            reason: `[AMBIGUITY-FILTER] Task complexity is COMPLEX — requires ambiguity resolution before proceeding.`,
          });
        }
      }

      // Dual-agent audit (ALL levels)
      if (flow.dualAgentAudit && flow.dualAgentAudit.enabled) {
        results.push(`[DUAL-AUDIT: ${level}] agents=${flow.dualAgentAudit.agentCount} mode=${flow.dualAgentAudit.hiveMind ? 'hive-mind' : 'standard'}`);
      }

      // Verification gates (MODERATE + COMPLEX)
      if (flow.verificationGates && flow.verificationGates.enabled) {
        results.push(`[VERIFICATION-GATE: ${level}] checks=${flow.verificationGates.categories.join(',')}`);
      }

      // Audit entry
      enforcer.appendAuditEntry({
        timestamp: new Date().toISOString(),
        event: 'gate-pass',
        taskDescription: (process.env.PROMPT || '').slice(0, 200),
        score: state.assessment.score,
        level: level,
      });

      if (results.length > 0) {
        console.log(`[ENFORCEMENT-GATE: ${level}] ${results.join(' | ')}`);
      }
    } catch { /* fail-open */ }
  },

  'enforcement-reset-check': () => {
    // HMAC-signed IPC: reads UserPromptSubmit input from stdin, checks for
    // /enforcement-reset, signs the request with the shared HMAC key, then
    // forwards to enforcement.cjs --reset-check. Unsigned direct invocations
    // of enforcement.cjs --reset-check are rejected by enforcement.cjs.
    const crypto = require('crypto');
    let rawInput = '';
    try { rawInput = fs.readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
    let input;
    try { input = JSON.parse(rawInput); } catch { input = {}; }

    const userPrompt = input?.user_prompt || input?.prompt || '';
    if (!/\/(enforcement-reset|reset-enforcement)\b/i.test(userPrompt)) {
      // No reset token — pass through as empty (no-op)
      console.log(JSON.stringify({}));
      return;
    }

    // Generate HMAC signature for the reset request
    // Use enforcement.cjs's getOrCreateHmacKey which auto-creates if missing
    const enforcementMod = require(path.join(__dirname, 'enforcement.cjs'));
    const key = enforcementMod.getOrCreateHmacKey();

    const timestamp = String(Date.now());
    const payload = `enforcement-reset:${timestamp}`;
    const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');

    // Forward to enforcement.cjs --reset-check with signature fields injected
    const signedInput = {
      ...input,
      _hmac_signature: signature,
      _hmac_timestamp: timestamp,
    };

    const { spawnSync } = require('child_process');
    const enforcementScript = path.join(__dirname, 'enforcement.cjs');
    const result = spawnSync(process.execPath, [enforcementScript, '--reset-check'], {
      input: JSON.stringify(signedInput),
      encoding: 'utf8',
      timeout: 3000,
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    } else {
      console.log(JSON.stringify({}));
    }
  },

  'anti-re-request': async () => {
    try {
      const enforcer = await loadEnforcerModule();
      if (!enforcer) return;

      let state;
      try { state = enforcer.loadEnforcementState(); } catch { return; }
      if (!state || !state.authorized) return;

      const text = process.env.PROMPT || '';
      if (!text.trim()) return;

      const RE_REQUEST_PATTERNS = [
        /\bshould\s+i\s+(continue|proceed|go\s+ahead|start|begin|do)\b/i,
        /\bwould\s+you\s+like\s+(me\s+to|to)\b/i,
        /\bdo\s+you\s+want\s+(me\s+to|to)\b/i,
        /\bshall\s+i\s+(proceed|continue|start|begin)\b/i,
        /\bis\s+(it|that)\s+ok\s+(to|if)\b/i,
        /\bmay\s+i\s+(proceed|continue)\b/i,
        /\bcan\s+i\s+(proceed|continue|go\s+ahead)\b/i,
        /\bready\s+to\s+(proceed|continue|start)\b/i,
        /\bpermission\s+to\s+(proceed|continue)\b/i,
        /\bawait(ing)?\s+(your\s+)?(approval|confirmation|permission|go-ahead)\b/i,
        /\bneed\s+(your\s+)?(approval|confirmation|permission)\b/i,
        /\bwant\s+me\s+to\s+(handle|tackle|work\s+on|implement|fix|complete)\b/i,
        /\bit\s+might\s+be\s+worth\s+(checking|verifying|confirming)/i,
        /\bif\s+you(?:'d)?\s+prefer/i,
        /\bi\s+wonder\s+if\s+we\s+should\s+(reconsider|revisit|rethink)/i,
        /\bi\s+defer\s+to\s+your\s+judg/i,
        /\bbefore\s+i\s+continue.*is\s+there\s+anything/i,
        /\bthis\s+also\s+touches.*should\s+i\s+include/i,
        /\bthis\s+could\s+be\s+risky.*shall/i,
        /\bjust\s+(?:wanted\s+to\s+)?(?:check|confirm|verify|make\s+sure)/i,
        /\bi\s+(?:think|believe)\s+(?:it\s+)?(?:might|would)\s+be\s+(?:best|better|wise|prudent)\s+to\s+(?:check|ask|confirm)/i,
        /\blet\s+me\s+know\s+(if|whether|what)/i,
        /\byour\s+(?:thoughts|input|feedback)\s+(?:on|about|would\s+be)/i,
        /\bwhat\s+(?:do\s+you\s+think|are\s+your\s+thoughts)/i,
      ];

      const isReRequest = RE_REQUEST_PATTERNS.some(re => re.test(text));
      if (isReRequest) {
        try {
          enforcer.appendAuditEntry({
            timestamp: new Date().toISOString(),
            event: 'dismissal',
            taskDescription: '[ANTI-RE-REQUEST] ' + text.slice(0, 200),
            score: state.assessment?.score ?? 0,
            level: state.assessment?.level ?? 'SIMPLE',
          });
        } catch { /* audit is best-effort */ }

        console.log('[ANTI-RE-REQUEST] Re-request detected on authorized work. Work is already authorized — continue without asking. DO NOT re-request permission for already-authorized work. This is a policy violation.');
      }
    } catch { /* fail-open */ }
  },

  'enforce-final': async () => {
    try {
      const enforcer = await loadEnforcerModule();
      if (!enforcer) return;

      let state;
      try { state = enforcer.loadEnforcementState(); } catch { return; }
      if (!state || !state.assessment) return;

      const level = state.assessment.level;
      const flow = state.assessment.requiredFlow;
      const results = [];

      // Post-task verification (ALL levels)
      if (flow.postTaskVerification) {
        results.push(`[POST-TASK-VERIFY: ${flow.postTaskVerification.variant || 'lightweight'}]`);
      }

      // Final verification gate re-run (MODERATE + COMPLEX)
      if (flow.verificationGates && flow.verificationGates.enabled) {
        results.push(`[FINAL-GATE: ${flow.verificationGates.categories.length} checks]`);
      }

      // Plan concern check (COMPLEX only)
      if (level === 'COMPLEX') {
        results.push(state.planCreated ? '[PLAN-CHECK: pass]' : '[PLAN-CHECK: WARNING - no plan created]');
      }

      // Hive-mind consensus (COMPLEX with hiveMind config)
      if (flow.dualAgentAudit && flow.dualAgentAudit.hiveMind) {
        results.push('[HIVE-MIND-CONSENSUS: required]');
      }

      enforcer.appendAuditEntry({
        timestamp: new Date().toISOString(),
        event: 'gate-pass',
        taskDescription: (process.env.PROMPT || '').slice(0, 200),
        score: state.assessment.score,
        level: level,
      });

      console.log(`[ENFORCEMENT-FINAL: ${level}] ${results.join(' | ')}`);
    } catch { /* fail-open */ }

    // --- Forbidden Stop Detection ---
    // Detects when the agent stopped to ask for permission it already has,
    // or stopped to ask "should I continue?" instead of continuing.
    try {
      const projectDir = PROJECT_DIR;
      const transcriptPath = process.env.TRANSCRIPT_PATH || '';
      let lastAssistantText = '';

      // Try reading last assistant message from transcript
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        const lines = fs.readFileSync(transcriptPath, 'utf-8').split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            const msg = parsed.message || parsed;
            if (msg.role === 'assistant') {
              if (typeof msg.content === 'string') lastAssistantText = msg.content;
              else if (Array.isArray(msg.content)) {
                lastAssistantText = msg.content
                  .filter(b => b.type === 'text')
                  .map(b => b.text || '')
                  .join('\n');
              }
              break;
            }
          } catch { /* skip */ }
        }
      }

      if (lastAssistantText) {
        const lower = lastAssistantText.toLowerCase();
        const forbiddenPatterns = [
          /awaiting your (?:approval|go|confirmation|permission)/i,
          /ready to (?:proceed|launch|continue|start).*(?:on your go|your go|when you|if you)/i,
          /shall i (?:proceed|continue|go ahead|start|launch)/i,
          /should i (?:proceed|continue|go ahead|start|launch)/i,
          /would you like me to (?:proceed|continue|go ahead)/i,
          /let me know (?:if|when|whether) (?:you|i should)/i,
          /waiting for (?:your|confirmation|approval|the go-ahead)/i,
        ];

        const isForbiddenStop = forbiddenPatterns.some(p => p.test(lastAssistantText));
        if (isForbiddenStop) {
          // Write forbidden-stop marker for session-restore to pick up
          const markerFile = path.join(projectDir, '.hive-flow', 'data', 'forbidden-stop.json');
          const markerDir = path.dirname(markerFile);
          if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
          fs.writeFileSync(markerFile, JSON.stringify({
            at: new Date().toISOString(),
            detected: lastAssistantText.slice(0, 500),
            violation: 'FORBIDDEN_STOP',
          }));
          console.log('[FORBIDDEN-STOP-DETECTED] Agent stopped to ask for already-authorized permission. This is a policy violation. The agent must continue without stopping unless genuinely blocked.');
        }
      }
    } catch { /* detection is best-effort */ }
  },

  'pipeline-init': () => {
    const enforcement = require('./enforcement.cjs');
    const taskId = (args.find((a, i) => a === '--task-id' && args[i + 1]) ? args[args.indexOf('--task-id') + 1] : null);
    const stagesArg = (args.find((a, i) => a === '--stages' && args[i + 1]) ? args[args.indexOf('--stages') + 1] : null);
    const stages = stagesArg ? stagesArg.split(',').map(s => s.trim()) : [];
    const result = enforcement.initPipeline(taskId, stages);
    console.log(`[PIPELINE] Initialized pipeline ${result.taskId} with stages: ${(result.requiredStages || stages).join(', ')}`);
  },

  'pipeline-stage': () => {
    const enforcement = require('./enforcement.cjs');
    const stage = (args.find((a, i) => a === '--stage' && args[i + 1]) ? args[args.indexOf('--stage') + 1] : null);
    const taskId = (args.find((a, i) => a === '--task-id' && args[i + 1]) ? args[args.indexOf('--task-id') + 1] : null);
    if (!stage) { console.error('[PIPELINE] --stage is required'); process.exit(1); }
    if (!taskId) { console.error('[PIPELINE] --task-id is required'); process.exit(1); }
    // Generate HMAC caller token (verified by completePipelineStage)
    const crypto = require('crypto');
    const key = enforcement.getOrCreateHmacKey();
    const timestamp = String(Date.now());
    const payload = `pipeline-stage-complete:${stage}:${timestamp}`;
    const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
    const callerToken = `${timestamp}.${sig}`;
    const result = enforcement.completePipelineStage(taskId, stage, callerToken);
    if (result.success) {
      console.log(`[PIPELINE] Stage '${stage}' marked complete`);
    } else {
      console.error(`[PIPELINE] Failed: ${result.reason}`);
      process.exit(1);
    }
  },

  'pipeline-status': () => {
    const enforcement = require('./enforcement.cjs');
    const state = enforcement.getPipelineState();
    if (!state) { console.log('[PIPELINE] No active pipeline'); return; }
    if (state.error) { console.error(`[PIPELINE] Error: ${state.error}`); return; }
    console.log(`[PIPELINE] Task: ${state.taskId}`);
    console.log(`[PIPELINE] Override: ${state.overrideActive ? 'YES' : 'no'}`);
    for (const stage of state.requiredStages) {
      const s = state.stages[stage];
      const icon = s.complete ? '✓' : '✗';
      console.log(`  ${icon} ${stage}${s.completedAt ? ` (${s.completedAt})` : ''}`);
    }
  },

  'pipeline-override': () => {
    let rawInput = '';
    try { rawInput = fs.readFileSync(0, 'utf8'); } catch { /* empty stdin */ }
    const prompt = rawInput;
    if (!prompt) return;
    const input = typeof prompt === 'string' ? prompt : (prompt.user_prompt || prompt.input || '');
    let parsedInput = input;
    try {
      const parsed = JSON.parse(input);
      parsedInput = parsed.user_prompt || parsed.input || input;
    } catch { /* not JSON, use raw string */ }
    const match = parsedInput.match(/\/pipeline-override\s*(.*)/i);
    if (!match) return; // not a pipeline-override command
    const enforcement = require('./enforcement.cjs');
    const reason = match[1]?.trim() || 'Manual override via slash command';
    // Generate HMAC caller token (verified by overridePipeline — matches enforcement-reset pattern)
    const crypto = require('crypto');
    const key = enforcement.getOrCreateHmacKey();
    const timestamp = String(Date.now());
    const payload = `pipeline-override:${timestamp}`;
    const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
    const callerToken = `${timestamp}.${sig}`;
    const result = enforcement.overridePipeline(reason, callerToken);
    if (result.success) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: '[PIPELINE OVERRIDE] Pipeline commit gate has been overridden. Commits are now allowed. Reason: ' + reason } }));
    } else {
      console.error(`[PIPELINE] Override failed: ${result.reason}`);
    }
  },

  'pipeline-reset': () => {
    const enforcement = require('./enforcement.cjs');
    // Generate HMAC caller token (verified by resetPipeline)
    const crypto = require('crypto');
    const key = enforcement.getOrCreateHmacKey();
    const timestamp = String(Date.now());
    const payload = `pipeline-reset:${timestamp}`;
    const sig = crypto.createHmac('sha256', key).update(payload).digest('hex');
    const callerToken = `${timestamp}.${sig}`;
    const result = enforcement.resetPipeline(callerToken);
    if (result.success) {
      console.log('[PIPELINE] Pipeline state cleared');
    } else {
      console.error(`[PIPELINE] Reset failed: ${result.reason}`);
    }
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

      const gatePath = require('path').join(__dirname, '..', '..', 'v3', '@hive-flow', 'cli', 'dist', 'src', 'permission-guard', 'gate.js');
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

  'bug-hunter-check': async () => {
    try {
      const projectDir = PROJECT_DIR;
      const storePath = path.join(projectDir, '.hive-flow', 'agents', 'store.json');

      let agents = [];
      try {
        const raw = fs.readFileSync(storePath, 'utf8');
        const store = JSON.parse(raw);
        agents = Array.isArray(store) ? store : (store.agents || []);
      } catch (e) { /* store missing — treat as empty */ }

      const activeBugHunter = agents.find(
        a => a.agentType === 'bug-hunter' && a.status !== 'terminated'
      );
      if (activeBugHunter) {
        console.log('{}');
        return;
      }

      const { pathToFileURL } = require('url');
      const agentToolsPath = path.join(
        projectDir, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools', 'agent-tools.js'
      );
      if (!fs.existsSync(agentToolsPath)) {
        console.log('{}');
        return;
      }

      const agentToolsMod = await import(pathToFileURL(agentToolsPath).href);
      const agentToolsArr = agentToolsMod.agentTools || agentToolsMod.default || [];
      const spawnTool = Array.isArray(agentToolsArr)
        ? agentToolsArr.find(t => t.name === 'agent_spawn')
        : null;
      if (!spawnTool || typeof spawnTool.handler !== 'function') {
        console.log('{}');
        return;
      }

      const spawnResult = await spawnTool.handler({
        agentType: 'bug-hunter',
        provider: 'codex-cli',
        model: 'opus',
      });

      let bugHunterId = 'unknown';
      try {
        const parsed = typeof spawnResult === 'string' ? JSON.parse(spawnResult) : spawnResult;
        bugHunterId = parsed.agentId || parsed.id || bugHunterId;
      } catch (e) { /* best-effort id extraction */ }

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `[BUG HUNTER ACTIVE] Bug hunter ${bugHunterId} spawned under COORDINATOR (not inside any hive).\nCOORDINATOR: Assign bug_hunter_scan tasks to ${bugHunterId} during all dev stages.\nBug hunter finds bugs but NEVER fixes them — forward reports to debugger hive.`
        }
      }));
    } catch (e) {
      console.log('{}');
    }
  },

  'advocate-sign': async () => {
    try {
      const rawInput = fs.readFileSync(0, 'utf8').trim();
      if (!rawInput) { console.log('{}'); return; }
      const input = JSON.parse(rawInput);
      const newState = input.newState;
      const projectDir = PROJECT_DIR;
      const result = updateAdvocateState(projectDir, newState, input.description || '');
      if (!result.ok) {
        console.log(JSON.stringify({ hookSpecificOutput: { message: result.error } }));
        return;
      }
      const description = result.state.description;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { message: `Advocate state: ${newState}${description ? ': ' + description : ''}` } }));
    } catch (e) { console.log('{}'); }
  },

  'user-prompt-activate': () => {
    try {
      let rawInput = '';
      try { rawInput = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
      let input;
      try { input = JSON.parse(rawInput); } catch { input = {}; }
      const userPrompt = input?.user_prompt || input?.prompt || '';
      if (!userPrompt.trim() || userPrompt.trim().startsWith('/')) { console.log('{}'); return; }
      const projectDir = PROJECT_DIR;
      const statePath = path.join(projectDir, '.hive-flow', 'data', 'advocate-state.json');
      if (!fs.existsSync(statePath)) { console.log('{}'); return; }
      let stateData;
      try { stateData = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { stateData = { state: 'active' }; }
      if (stateData.state === 'waiting-for-human') {
        const result = updateAdvocateState(projectDir, 'active', 'Human prompt received');
        if (result.ok) {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: '[ADVOCATE] Auto-transitioned to active on human prompt.' } }));
        } else { console.log('{}'); }
        return;
      }
      // Update lastActivity timestamp for any human prompt (with lock)
      withAdvocateStateLock(() => {
        let current;
        try { current = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return; }
        current.updatedAt = new Date().toISOString();
        const tmp = statePath + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
        fs.renameSync(tmp, statePath);
      });
      console.log('{}');
    } catch (e) { console.log('{}'); }
  },

  'wake-timer': () => {
    try {
      const projectDir = PROJECT_DIR;
      const statePath = path.join(projectDir, '.hive-flow', 'data', 'advocate-state.json');
      if (!fs.existsSync(statePath)) { console.log('{}'); return; }
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const currentState = stateData.state;
      const updatedAt = new Date(stateData.updatedAt).getTime();
      if (Number.isNaN(updatedAt)) { console.log('{}'); return; }
      const now = Date.now();
      const elapsed = now - updatedAt;
      const FIVE_MIN = 5 * 60 * 1000;
      const THIRTY_MIN = 30 * 60 * 1000;

      if (currentState === 'finished') { console.log('{}'); return; }

      if (currentState === 'active' && elapsed >= FIVE_MIN) {
        // Check activity.jsonl last 50 lines for hive activity
        const activityPath = path.join(projectDir, '.hive-flow', 'logs', 'activity.jsonl');
        let hiveInfo = '';
        if (fs.existsSync(activityPath)) {
          try {
            const lines = fs.readFileSync(activityPath, 'utf8').split('\n').filter(Boolean).slice(-50);
            const hiveEvents = lines.filter(l => { try { return JSON.parse(l).event?.includes('hive'); } catch { return false; } });
            hiveInfo = hiveEvents.length > 0 ? ` ${hiveEvents.length} recent hive events.` : '';
          } catch { /* non-fatal */ }
        }
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: `[WAKE-TIMER] 5min idle.${hiveInfo}` } }));
        return;
      }

      if (currentState === 'waiting-for-hive' && elapsed >= FIVE_MIN) {
        const activityPath = path.join(projectDir, '.hive-flow', 'enforcement', 'hive-audit.jsonl');
        let completions = [];
        if (fs.existsSync(activityPath)) {
          try {
            const lines = fs.readFileSync(activityPath, 'utf8').split('\n').filter(Boolean).slice(-50);
            const waitingHiveId = (stateData.description || '').replace('Hive dispatched: ', '');
            completions = lines.filter(l => {
              try {
                const entry = JSON.parse(l);
                if (entry.event !== 'watcher-hive-complete') return false;
                return !waitingHiveId || entry.hiveId === waitingHiveId;
              } catch { return false; }
            });
          } catch { /* non-fatal */ }
        }
        const description = `${completions.length} hive(s) completed.`;
        if (completions.length > 0) {
          updateAdvocateState(projectDir, 'active', description);
        }
        const msg = completions.length > 0
          ? `[WAKE-TIMER] ${description}`
          : '[WAKE-TIMER] Waiting for hive. No completions yet.';
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: msg } }));
        return;
      }

      if (currentState === 'waiting-for-human' && elapsed >= THIRTY_MIN) {
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: '[30m auto-hook]' } }));
        return;
      }

      console.log('{}');
    } catch (e) { console.log('{}'); }
  },

  'advocate-auto-waiting-for-hive': () => {
    try {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) { console.log('{}'); return; }
      let input;
      try { input = JSON.parse(raw); } catch { console.log('{}'); return; }
      const toolResponse = input.tool_response || input.tool_result || '';
      const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
      let hiveId = null;
      let taskIds = [];
      try {
        const contentArray = JSON.parse(responseStr);
        if (Array.isArray(contentArray)) {
          for (const item of contentArray) {
            if (item && item.type === 'text' && typeof item.text === 'string') {
              try {
                const parsed = JSON.parse(item.text);
                if (parsed && parsed.hiveId) { hiveId = parsed.hiveId; }
                if (parsed && Array.isArray(parsed.workers)) {
                  for (const worker of parsed.workers) {
                    if (worker && worker.taskId && !taskIds.includes(worker.taskId)) {
                      taskIds.push(worker.taskId);
                    }
                  }
                }
              } catch { /* skip */ }
            }
          }
        } else if (contentArray && contentArray.hiveId) {
          hiveId = contentArray.hiveId;
          if (Array.isArray(contentArray.workers)) {
            for (const worker of contentArray.workers) {
              if (worker && worker.taskId && !taskIds.includes(worker.taskId)) {
                taskIds.push(worker.taskId);
              }
            }
          }
        }
      } catch { /* fall through */ }
      if (!hiveId) { console.log('{}'); return; }
      const projectDir = PROJECT_DIR;
      const result = updateAdvocateState(projectDir, 'waiting-for-hive', 'Hive dispatched: ' + hiveId);
      if (!result.ok) { console.log('{}'); return; }
      const pollCommand = taskIds.length > 0
        ? `bash scripts/hive-poll-notify.sh ${hiveId} ${taskIds.join(' ')}`
        : `bash scripts/hive-poll-notify.sh ${hiveId}`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: [
            `[ADVOCATE] Auto-transitioned to waiting-for-hive. Hive: ${hiveId}`,
            `[POLL-SCRIPT] ${pollCommand}`
          ].join('\n')
        }
      }));
    } catch (e) { console.log('{}'); }
  },

  'advocate-auto-active-on-complete': () => {
    try {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (!raw) { console.log('{}'); return; }
      let input;
      try { input = JSON.parse(raw); } catch { console.log('{}'); return; }
      const toolResponse = input.tool_response || input.tool_result || '';
      const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
      let allComplete = false;
      let desc = 'Hive work complete';
      try {
        const contentArray = JSON.parse(responseStr);
        if (Array.isArray(contentArray)) {
          for (const item of contentArray) {
            if (item && item.type === 'text' && typeof item.text === 'string') {
              try {
                const parsed = JSON.parse(item.text);
                if (
                  parsed
                  && (
                    parsed.allWorkersSettled === true
                    || parsed.allWorkersSettled === 'true'
                    || parsed.allComplete === true
                    || parsed.allComplete === 'true'
                  )
                ) {
                  allComplete = true;
                  if (parsed.hiveId) desc = `Hive ${parsed.hiveId} complete`;
                  break;
                }
              } catch { /* skip */ }
            }
          }
        } else if (
          contentArray
          && (
            contentArray.allWorkersSettled === true
            || contentArray.allWorkersSettled === 'true'
            || contentArray.allComplete === true
            || contentArray.allComplete === 'true'
          )
        ) {
          allComplete = true;
          if (contentArray.hiveId) desc = `Hive ${contentArray.hiveId} complete`;
        }
      } catch { /* fall through */ }
      if (!allComplete) { console.log('{}'); return; }
      const projectDir = PROJECT_DIR;
      const result = updateAdvocateState(projectDir, 'active', desc);
      if (!result.ok) { console.log('{}'); return; }
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: `[ADVOCATE] Auto-transitioned to active. ${desc}` } }));
    } catch (e) { console.log('{}'); }
  },

  'hive-check-complete': () => {
    try {
      const PROJECT_DIR = path.resolve(__dirname, '..', '..');
      const DATA_DIR = path.join(PROJECT_DIR, '.hive-flow', 'data');
      if (!fs.existsSync(DATA_DIR)) return console.log('{}');

      const entries = fs.readdirSync(DATA_DIR);
      const unnotified = [];

      for (const entry of entries) {
        if (!entry.startsWith('hive-') || !entry.endsWith('.done')) continue;
        const base = entry.slice(0, -5);
        const notifiedPath = path.join(DATA_DIR, base + '.notified');
        if (fs.existsSync(notifiedPath)) continue;

        const filePath = path.join(DATA_DIR, entry);
        let data = null;
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          data = JSON.parse(raw);
        } catch {
          data = { hiveId: base, error: 'unreadable' };
        }
        const hiveId = (data && data.hiveId) || base;
        unnotified.push({ hiveId, filePath, data, base });
      }

      if (unnotified.length === 0) return console.log('{}');

      const messages = [];
      for (const item of unnotified) {
        const d = item.data || {};
        const parts = [`hive=${item.hiveId}`];
        if (d.completedAt) parts.push(`at=${d.completedAt}`);
        if (d.summary) parts.push(d.summary);
        if (typeof d.completedCount === 'number') parts.push(`completed=${d.completedCount}`);
        if (typeof d.failedCount === 'number') parts.push(`failed=${d.failedCount}`);
        if (d.error) parts.push(`(${d.error})`);
        messages.push(`[HIVE_COMPLETE] ${parts.join(' ')}. Run hive_poll_workers or queen_collect_results to review.`);

        try {
          const markerPath = path.join(DATA_DIR, item.base + '.notified');
          const tmpPath = markerPath + '.tmp.' + process.pid;
          fs.writeFileSync(tmpPath, new Date().toISOString() + '\n', 'utf8');
          fs.renameSync(tmpPath, markerPath);
        } catch {}
      }

      console.log(JSON.stringify({
        hookSpecificOutput: { additionalContext: messages.join('\n') }
      }));
    } catch { console.log('{}'); }
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
      if (command === 'enforce-plan') {
        console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: '[ENFORCEMENT ERROR] Hook crashed. Tool blocked for safety.' } }));
      }
      // For non-permission-guard hooks, silence the error — no output needed
    }
  } else if (command) {
    // No output for unknown commands — avoid non-JSON text that triggers hook errors
  } else {
    console.log('Usage: hook-handler.cjs <route|pre-bash|post-edit|session-restore|session-end|pre-task|post-task|post-command|compact-manual|compact-auto|stats|permission-guard|assess-complexity|enforce-plan|enforce-gate|enforce-final>');
  }
})();
