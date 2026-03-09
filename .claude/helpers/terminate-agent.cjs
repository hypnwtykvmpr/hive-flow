#!/usr/bin/env node
/**
 * Terminate Agent Hook
 * Intercepts /terminate-agent before the model call.
 * Implements a safe, in-process "agent termination" without killing Claude Code.
 *
 * Behavior:
 * - /terminate-agent (or exact sentinel) is blocked at UserPromptSubmit.
 * - A termination marker is persisted for handoff tracking.
 * - Next prompt gets one-time [TERMINATED] additionalContext injection.
 *
 * This guarantees the active LLM turn is not executed while the Claude process
 * remains alive.
 *
 * Trigger: UserPromptSubmit hook (FIRST in chain)
 * Kill patterns: /terminate-agent, [TERMINATE_AGENT_NOW]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SESSION_DIR = path.join(PROJECT_DIR, '.hive-flow', 'sessions');
const SESSION_FILE = path.join(SESSION_DIR, 'current.json');
const MARKER_FILE = path.join(SESSION_DIR, 'terminated.json');
const SETTINGS_FILE = path.join(PROJECT_DIR, '.claude', 'settings.json');
const TERMINATE_STEPS_LOG_FILE = path.join(SESSION_DIR, 'terminate-steps.log.jsonl');

// Model ID mapping for settings.json "model" field
const MODEL_IDS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function getJsonlProjectDir() {
  const override = process.env.HIVE_FLOW_JSONL_DIR;
  if (override) return override;
  const encoded = PROJECT_DIR.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

// Marker TTL: ignore markers older than 1 hour
const MARKER_TTL_MS = 60 * 60 * 1000;

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

function emitJson(data) {
  try {
    process.stdout.write(JSON.stringify(data));
  } catch {
    // Hooks must be fail-safe and silent on serialization errors.
  }
}

function parseHookInput(input) {
  const raw = `${input || ''}`;
  try {
    const parsed = JSON.parse(raw);
    const prompt = `${parsed.prompt || parsed.user_prompt || parsed.message || ''}`;
    return {
      raw,
      parsed,
      prompt,
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      transcriptPath: typeof parsed.transcript_path === 'string' ? parsed.transcript_path : null,
    };
  } catch {
    return {
      raw,
      parsed: null,
      prompt: raw,
      sessionId: null,
      transcriptPath: null,
    };
  }
}

function readHookInput() {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch {}
  return parseHookInput(input);
}

function isTerminatePrompt(prompt) {
  const normalizedPrompt = `${prompt || ''}`.trim();
  return /^\/terminate-agent$/i.test(normalizedPrompt) ||
         /^\[TERMINATE_AGENT_NOW\]$/i.test(normalizedPrompt);
}

function isMarkerExpired(marker) {
  if (!marker || !marker.at) return false;
  try {
    const age = Date.now() - new Date(marker.at).getTime();
    return age > MARKER_TTL_MS;
  } catch {
    return false;
  }
}

function persistTermination(nowIso) {
  try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}

  const session = readJson(SESSION_FILE) || {};
  const prevGeneration = Number.isFinite(Number(session.logicalAgentGeneration))
    ? Number(session.logicalAgentGeneration)
    : 0;
  const nextGeneration = prevGeneration + 1;

  session.terminated = true;
  session.terminatedAt = nowIso;
  session.terminationReason = 'User invoked /terminate-agent';
  session.logicalAgentGeneration = nextGeneration;
  writeJsonAtomic(SESSION_FILE, session);

  const marker = {
    terminated: true,
    at: nowIso,
    reason: 'User invoked /terminate-agent',
    generation: nextGeneration,
    pendingUserAck: true,
    pendingPromptInjection: true,
    note: '[TERMINATED] Previous agent was forcefully terminated by user.',
  };

  const wrote = writeJsonAtomic(MARKER_FILE, marker);
  if (!wrote) {
    marker._persistFailed = true;
  }
  return marker;
}

function emitTerminateBlock(marker) {
  const generation = Number.isFinite(Number(marker?.generation))
    ? Number(marker.generation)
    : 0;

  let suffix = '';
  if (marker.sessionDumped) {
    suffix += ` Session dumped to ${path.basename(marker.sessionDumpPath || 'session-dump.json')}.`;
  }
  if (marker.modelSwitched) {
    suffix += ` Model switched: ${marker.previousModel} \u2192 ${marker.targetModel}.`;
  }
  if (marker.sessionCleared) {
    suffix += ' Session state cleared.';
  }

  if (marker._persistFailed) {
    emitJson({
      decision: 'block',
      continue: false,
      suppressOutput: true,
      stopReason: `[TERMINATED][AGENT_GENERATION:${generation}][PERSIST_FAILED] Agent terminated but marker could not be saved. Handoff stages may not fire.${suffix} Send your next message to retry.`,
    });
    return;
  }

  emitJson({
    decision: 'block',
    continue: false,
    suppressOutput: true,
    stopReason: `[TERMINATED][AGENT_GENERATION:${generation}] Active agent terminated. Claude process is still running.${suffix} Send your next message to receive replacement-agent handshake.`,
  });
}

function cleanupMarker() {
  try { fs.unlinkSync(MARKER_FILE); } catch {}
}

function appendTerminateLaunchLog(event, fields = {}) {
  try {
    fs.mkdirSync(path.dirname(TERMINATE_STEPS_LOG_FILE), { recursive: true });
    fs.appendFileSync(TERMINATE_STEPS_LOG_FILE, JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }) + '\n', 'utf8');
  } catch {
    // Never block terminate flow on logging failures.
  }
}

/**
 * Detect the currently active Claude model from ~/.claude.json lastModelUsage.
 * Returns 'opus', 'sonnet', 'haiku', or null if unknown.
 */
function detectCurrentModel() {
  try {
    const claudeCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (!claudeCfg?.projects) return null;
    const cwd = PROJECT_DIR;
    let bestPath = '', bestCfg = null;
    for (const [projPath, projCfg] of Object.entries(claudeCfg.projects)) {
      if ((cwd === projPath || cwd.startsWith(projPath + '/')) && projPath.length > bestPath.length) {
        bestPath = projPath;
        bestCfg = projCfg;
      }
    }
    if (!bestCfg?.lastModelUsage) return null;
    let bestId = '', bestTs = 0;
    for (const [id, info] of Object.entries(bestCfg.lastModelUsage)) {
      const ts = info?.lastUsedAt ? new Date(info.lastUsedAt).getTime() : 0;
      if (ts > bestTs) { bestTs = ts; bestId = id; }
    }
    if (!bestId) return null;
    const lower = bestId.toLowerCase();
    if (lower.includes('opus')) return 'opus';
    if (lower.includes('sonnet')) return 'sonnet';
    if (lower.includes('haiku')) return 'haiku';
    return null;
  } catch { return null; }
}

/**
 * Fork a detached background process to run post-termination steps
 * (memory update via Gemini sub-agent). Non-blocking, fire-and-forget.
 */
function launchPostTerminationSteps() {
  try {
    if (process.env.HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS === '1') {
      appendTerminateLaunchLog('terminate.steps.launch.skipped', { reason: 'disabled-via-env' });
      return;
    }
    const stepsScript = path.join(__dirname, 'terminate-steps.cjs');
    if (!fs.existsSync(stepsScript)) {
      appendTerminateLaunchLog('terminate.steps.launch.skipped', { reason: 'steps-script-missing', stepsScript });
      return;
    }
    const child = fork(stepsScript, [MARKER_FILE], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECT_DIR,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT_DIR },
    });
    child.on('error', (err) => {
      appendTerminateLaunchLog('terminate.steps.launch.error', {
        reason: err?.message || String(err),
        stepsScript,
      });
    });
    appendTerminateLaunchLog('terminate.steps.launch.started', {
      pid: child.pid || null,
      stepsScript,
    });
    child.unref();
  } catch {
    appendTerminateLaunchLog('terminate.steps.launch.error', { reason: 'fork-threw-synchronously' });
    // Fire-and-forget — failure must not block termination.
  }
}

/**
 * Switch the active model by writing the "model" field into .claude/settings.json.
 * opus→sonnet, sonnet→opus. If haiku or unknown, default to sonnet.
 * Also updates the termination marker with switch info.
 * Fail-safe: catches all errors, never throws.
 */
function switchModel(marker) {
  try {
    const currentModel = detectCurrentModel();
    let targetModel;
    if (currentModel === 'opus') {
      targetModel = 'sonnet';
    } else if (currentModel === 'sonnet') {
      targetModel = 'opus';
    } else {
      targetModel = 'sonnet';
    }

    const targetModelId = MODEL_IDS[targetModel];

    // Read current settings, write updated model field
    const settings = readJson(SETTINGS_FILE) || {};
    settings.model = targetModelId;
    const wrote = writeJsonAtomic(SETTINGS_FILE, settings);
    if (!wrote) {
      return { switched: false, reason: 'Failed to write settings.json' };
    }

    // Update termination marker with switch info
    if (marker) {
      marker.modelSwitched = true;
      marker.previousModel = currentModel || 'unknown';
      marker.targetModel = targetModel;
      writeJsonAtomic(MARKER_FILE, marker);
    }

    return { switched: true, from: currentModel || 'unknown', to: targetModel };
  } catch (err) {
    return { switched: false, reason: `switchModel error: ${err?.message || err}` };
  }
}

/**
 * Clear ONLY the active session's in-file volatile fields.
 * Scope is intentionally limited to current session state to avoid cross-session
 * destructive side effects.
 */
function clearSessionState(hookInput) {
  const items = [];
  try {
    const session = readJson(SESSION_FILE);
    const sessionId = hookInput?.sessionId || session?.id || 'current';
    if (!session || typeof session !== 'object') {
      return { cleared: true, items, scope: `session:${sessionId}` };
    }

    // Scrub known volatile fields only on current session object.
    const volatileKeys = [
      'context',
      'scratchpad',
      'activePlan',
      'pendingPlan',
      'lastPrompt',
      'lastResponse',
      'lastToolResult',
      'toolCache',
      'routeState',
      'handoffBuffer',
    ];

    for (const key of volatileKeys) {
      if (Object.prototype.hasOwnProperty.call(session, key)) {
        delete session[key];
        items.push(`current:${key}`);
      }
    }

    if (session.transient && typeof session.transient === 'object') {
      session.transient = {};
      items.push('current:transient');
    }

    session.sessionClearedAt = new Date().toISOString();
    const wrote = writeJsonAtomic(SESSION_FILE, session);
    if (!wrote) {
      return { cleared: false, reason: 'Failed to persist session scrub', scope: `session:${sessionId}` };
    }

    return { cleared: true, items, scope: `session:${sessionId}` };
  } catch (err) {
    return { cleared: false, reason: String(err?.message || err) };
  }
}

function resolveTranscriptPath(hookInput) {
  const transcriptPath = hookInput?.transcriptPath;
  if (!transcriptPath) {
    return { ok: false, reason: 'No transcript_path in hook payload' };
  }

  try {
    const resolved = path.resolve(transcriptPath);
    const projectJsonlDir = path.resolve(getJsonlProjectDir());
    const isWithinProjectJsonlDir = resolved === projectJsonlDir || resolved.startsWith(projectJsonlDir + path.sep);
    if (!isWithinProjectJsonlDir) {
      return { ok: false, reason: 'transcript_path is outside project JSONL directory' };
    }

    if (!resolved.endsWith('.jsonl')) {
      return { ok: false, reason: 'transcript_path must be a .jsonl file' };
    }
    if (!fs.existsSync(resolved)) {
      return { ok: false, reason: 'transcript_path file does not exist' };
    }

    if (hookInput?.sessionId) {
      const expected = `${hookInput.sessionId}.jsonl`;
      if (path.basename(resolved) !== expected) {
        return { ok: false, reason: 'transcript_path does not match current session_id' };
      }
    }

    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, reason: `resolveTranscriptPath error: ${err?.message || err}` };
  }
}

function dumpSessionState(marker, hookInput) {
  try {
    const generation = marker?.generation || 0;
    const transcript = resolveTranscriptPath(hookInput);
    if (!transcript.ok) {
      return { dumped: false, reason: transcript.reason || 'Transcript resolution failed' };
    }

    const raw = fs.readFileSync(transcript.path, 'utf8');
    const lines = raw.split('\n');
    const userPrompts = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.indexOf('"type":"user"') === -1) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'user') continue;
        let text = '';
        const content = obj.message?.content;
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter(c => c.type === 'text')
            .map(c => c.text || '')
            .join('\n');
        }
        if (!text.trim()) continue;
        if (text.startsWith('Operation stopped by hook:')) continue;
        userPrompts.push({
          text,
          timestamp: obj.timestamp || null,
          index: userPrompts.length,
        });
      } catch {}
    }

    if (userPrompts.length === 0) {
      return { dumped: false, reason: 'No user prompts found in JSONL' };
    }

    const amplifyCount = Math.min(10, userPrompts.length);
    const cutoff = userPrompts.length - amplifyCount;

    const amplified = userPrompts.slice(cutoff).map(p => ({
      ...p, priority: 'high', amplified: true,
    }));
    const normal = userPrompts.slice(0, cutoff).map(p => ({
      ...p, priority: 'normal', amplified: false,
    }));

    const orderedPrompts = [...amplified, ...normal];

    const dump = {
      version: 1,
      generation,
      dumpedAt: new Date().toISOString(),
      sessionId: hookInput?.sessionId || path.basename(transcript.path, '.jsonl'),
      sourceJsonl: path.basename(transcript.path),
      totalPrompts: userPrompts.length,
      amplifiedCount: amplifyCount,
      prompts: orderedPrompts,
    };

    const dumpPath = path.join(SESSION_DIR, `session-dump-${generation}.json`);
    const wrote = writeJsonAtomic(dumpPath, dump);
    if (!wrote) {
      return { dumped: false, reason: 'Failed to write dump file' };
    }

    return { dumped: true, path: dumpPath, totalPrompts: userPrompts.length };
  } catch (err) {
    return { dumped: false, reason: `dumpSessionState error: ${err?.message || err}` };
  }
}

function maybeEmitHandoff(nowIso) {
  const marker = readJson(MARKER_FILE);
  if (!marker) return 'none';

  // Ignore expired markers from stale sessions
  if (isMarkerExpired(marker)) {
    cleanupMarker();
    return 'none';
  }

  const generation = Number.isFinite(Number(marker.generation))
    ? Number(marker.generation)
    : 0;

  if (marker.pendingUserAck !== false) {
    marker.pendingUserAck = false;
    marker.userAckAt = nowIso;
    writeJsonAtomic(MARKER_FILE, marker);

    emitJson({
      decision: 'block',
      continue: false,
      suppressOutput: true,
      stopReason: `[TERMINATED][AGENT_GENERATION:${generation}] Handoff checkpoint confirmed. This prompt was NOT sent to any model. Re-send your message now to talk to the replacement agent.`,
    });
    return 'blocked';
  }

  if (marker.pendingPromptInjection === false) {
    // Both flags consumed — clean up the marker
    cleanupMarker();
    return 'none';
  }

  marker.pendingPromptInjection = false;
  marker.promptInjectionAt = nowIso;
  writeJsonAtomic(MARKER_FILE, marker);

  const at = marker.at || 'unknown time';
  const reason = marker.reason || 'User invoked /terminate-agent';
  const generationText = Number.isFinite(Number(marker.generation))
    ? ` Logical generation: ${Number(marker.generation)}.`
    : '';

  // Model switch info comes from the marker (set by model-switch agent during termination)
  const modelSwitchText = marker.modelSwitched === true
    ? ` Model was automatically switched from ${marker.previousModel || 'unknown'} to ${marker.targetModel || 'unknown'}.`
    : ' Model switch was attempted but may not have succeeded. Check /model to verify.';

  const clearText = marker.sessionCleared === true
    ? (Array.isArray(marker.clearedItems) && marker.clearedItems.length > 0
      ? ` Session-local state cleared: ${marker.clearedItems.slice(0, 8).join(', ')}.`
      : ` Session-local state cleared for ${marker.clearScope || 'current session'}.`)
    : ' Session-local state clear was attempted but may not have completed.';

  const dumpText = marker.sessionDumped === true && marker.sessionDumpPath
    ? ` Session dump from previous agent exists at ${marker.sessionDumpPath}. Do NOT read it unless the user instructs you to.`
    : '';

  emitJson({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[TERMINATED][AGENT_GENERATION:${generation}] Previous agent was forcefully terminated at ${at}. Reason: ${reason}.${generationText}${modelSwitchText}${clearText}${dumpText} This is a verified handoff from hook state; treat this as a fresh agent continuation with zero prior context. Read MEMORY.md for session history and strictly follow current user instructions.`,
    },
  });
  return 'injected';
}

function main(options = {}) {
  const exitOnFinish = options.exitOnFinish !== false;
  const nowIso = new Date().toISOString();
  const hookInput = options.hookInput || readHookInput();
  const prompt = hookInput.prompt;

  if (isTerminatePrompt(prompt)) {
    const marker = persistTermination(nowIso);

    // Step 1.5: Dump session state (preserve before clearing)
    const dumpResult = dumpSessionState(marker, hookInput);

    // Step 2: Clear only this session's state
    const clearResult = clearSessionState(hookInput);

    // Step 3: Switch model — innocent replacement gets a clean slate
    const switchResult = switchModel(marker);

    // Store all results in marker for handoff injection
    if (dumpResult) {
      marker.sessionDumped = dumpResult.dumped || false;
      marker.sessionDumpPath = dumpResult.path || null;
    }
    if (switchResult) {
      marker.modelSwitched = switchResult.switched || false;
      marker.previousModel = switchResult.from || null;
      marker.targetModel = switchResult.to || null;
    }
    if (clearResult) {
      marker.sessionCleared = clearResult.cleared || false;
      marker.clearedItems = clearResult.items || [];
      marker.clearScope = clearResult.scope || null;
    }
    // Re-persist marker with all metadata
    if (!marker._persistFailed) {
      writeJsonAtomic(MARKER_FILE, marker);
    }

    emitTerminateBlock(marker);

    // Step 4: Launch post-termination steps in background (memory update)
    if (!marker._persistFailed) {
      launchPostTerminationSteps();
    }
    if (exitOnFinish) process.exit(0);
    return { action: 'terminated', marker };
  }

  const handoff = maybeEmitHandoff(nowIso);
  if (exitOnFinish) process.exit(0);
  return { action: 'pass-through', handoff };
}

if (require.main === module) {
  main({ exitOnFinish: true });
}

module.exports = {
  parseHookInput,
  readHookInput,
  isTerminatePrompt,
  isMarkerExpired,
  persistTermination,
  emitTerminateBlock,
  detectCurrentModel,
  launchPostTerminationSteps,
  switchModel,
  clearSessionState,
  resolveTranscriptPath,
  dumpSessionState,
  maybeEmitHandoff,
  main,
};
