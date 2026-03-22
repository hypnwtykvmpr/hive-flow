#!/usr/bin/env node
/**
 * Advocate State Machine with Task Signing
 * 
 * Manages the advocate state file: .hive-flow/data/advocate-state.json
 * Schema: {
 *   state: 'active' | 'waiting-for-hive' | 'waiting-for-human' | 'finished',
 *   lastTransition: ISO timestamp,
 *   lastActivity: ISO timestamp,
 *   description?: string,
 *   activeHives?: string[]
 * }
 * 
 * Also provides HMAC-signed transitions for advocate role verification.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Derive PROJECT_DIR from script location
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(PROJECT_DIR, '.hive-flow', 'data', 'advocate-state.json');
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
const HMAC_KEY_FILE = path.join(ENFORCEMENT_DIR, '.hmac-key');

// Valid state transitions
const VALID_TRANSITIONS = {
  'waiting-for-human': ['active'],
  'active': ['waiting-for-hive', 'waiting-for-human', 'finished'],
  'waiting-for-hive': ['active', 'waiting-for-human', 'finished'],
  'finished': ['active'] // Can restart from finished
};

// ============================================================================
// HMAC Utilities (mirrors enforcement.cjs logic)
// ============================================================================

function getHmacKey() {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) {
      return fs.readFileSync(HMAC_KEY_FILE, 'utf8').trim();
    }
  } catch {
    // Key file doesn't exist or unreadable
  }
  return null;
}

function computeHmac(data, key) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

// ============================================================================
// State File Management
// ============================================================================

/**
 * Load advocate state from file.
 * Returns default state if file doesn't exist.
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return createDefaultState();
    }
    
    const stats = fs.statSync(STATE_FILE);
    if (stats.size > 10240) { // 10KB sanity limit
      return createDefaultState();
    }
    
    const content = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(content);
    
    // Validate structure - support both schemas
    // Canonical schema: {state, updatedAt, description, history, activeHives}
    // Legacy schema: {state, lastTransition, lastActivity, description, activeHives}
    
    // Handle schema conversion
    if (state.updatedAt) {
      // Canonical schema (hook-handler.cjs)
      if (!state.state || !state.updatedAt) {
        return createDefaultState();
      }
      // Ensure activeHives exists
      if (!state.activeHives || !Array.isArray(state.activeHives)) {
        state.activeHives = [];
      }
      // Ensure history exists
      if (!state.history || !Array.isArray(state.history)) {
        state.history = [];
      }
    } else if (state.lastTransition) {
      // Legacy schema (advocate-state.cjs) - convert to canonical
      state.updatedAt = state.lastTransition;
      state.history = [];
      if (!state.activeHives || !Array.isArray(state.activeHives)) {
        state.activeHives = [];
      }
    } else {
      // Invalid schema
      return createDefaultState();
    }
    
    return state;
  } catch (error) {
    return createDefaultState();
  }
}

/**
 * Create default advocate state.
 */
function createDefaultState() {
  const now = new Date().toISOString();
  return {
    state: 'waiting-for-human',
    lastTransition: now,
    lastActivity: now,
    description: 'Awaiting human prompt',
    activeHives: []
  };
}

/**
 * Save advocate state to file (atomic write).
 */
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Update timestamps
    const now = new Date().toISOString();
    const updatedState = {
      ...state,
      lastActivity: now
      // Note: lastTransition is only updated in transitionState()
    };
    
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(updatedState, null, 2), 'utf8');
    fs.renameSync(tmpFile, STATE_FILE);
    
    return updatedState;
  } catch (error) {
    // Clean up temp file on error
    try {
      const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
    return null;
  }
}

/**
 * Transition to a new state with optional description.
 * Validates state transition rules.
 */
function transitionState(newState, description = '') {
  const current = loadState();
  
  // Check if transition is valid
  const allowedTransitions = VALID_TRANSITIONS[current.state] || [];
  if (!allowedTransitions.includes(newState)) {
    throw new Error(`Invalid state transition: ${current.state} → ${newState}`);
  }
  
  // Update state
  const updated = {
    ...current,
    state: newState,
    lastTransition: new Date().toISOString(),
    description: description || current.description || ''
  };
  
  // Clear activeHives when moving out of active state
  if (newState !== 'active') {
    updated.activeHives = [];
  }
  
  return saveState(updated);
}

/**
 * Update lastActivity timestamp without changing state.
 */
function updateActivity() {
  const current = loadState();
  const updated = {
    ...current,
    lastActivity: new Date().toISOString()
  };
  
  const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2), 'utf8');
  fs.renameSync(tmpFile, STATE_FILE);
  
  return updated;
}

/**
 * Add a hive to activeHives list (only when in 'active' state).
 */
function addActiveHive(hiveId) {
  const current = loadState();
  
  if (current.state !== 'active') {
    throw new Error(`Cannot add hive in state: ${current.state}`);
  }
  
  if (!current.activeHives.includes(hiveId)) {
    const updated = {
      ...current,
      activeHives: [...current.activeHives, hiveId],
      lastActivity: new Date().toISOString()
    };
    
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpFile, STATE_FILE);
    
    return updated;
  }
  
  return current;
}

/**
 * Remove a hive from activeHives list.
 */
function removeActiveHive(hiveId) {
  const current = loadState();
  
  if (current.activeHives.includes(hiveId)) {
    const updated = {
      ...current,
      activeHives: current.activeHives.filter(id => id !== hiveId),
      lastActivity: new Date().toISOString()
    };
    
    const tmpFile = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2), 'utf8');
    fs.renameSync(tmpFile, STATE_FILE);
    
    return updated;
  }
  
  return current;
}

// ============================================================================
// Signed Transitions (for MCP tool / explicit advocate calls)
// ============================================================================

/**
 * Create a signed transition request for advocate verification.
 * Returns envelope with HMAC signature.
 */
function createSignedTransition(newState, description = '', agentId = '') {
  const key = getHmacKey();
  if (!key) {
    throw new Error('HMAC key not available for signing');
  }
  
  const timestamp = new Date().toISOString();
  const payload = {
    newState,
    description,
    agentId,
    timestamp,
    currentState: loadState().state
  };
  
  const signature = computeHmac(payload, key);
  
  return {
    payload,
    signature,
    envelope: {
      payload,
      signature
    }
  };
}

/**
 * Verify and apply a signed transition.
 */
function applySignedTransition(envelope) {
  const key = getHmacKey();
  if (!key) {
    throw new Error('HMAC key not available for verification');
  }
  
  const { payload, signature } = envelope;
  if (!payload || !signature) {
    throw new Error('Invalid envelope structure');
  }
  
  // Verify signature
  const expected = computeHmac(payload, key);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  
  if (expectedBuf.length !== actualBuf.length || 
      !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error('Invalid signature');
  }
  
  // Check timestamp (prevent replay attacks, 5-minute window)
  const envelopeTime = new Date(payload.timestamp).getTime();
  const now = Date.now();
  if (Math.abs(now - envelopeTime) > 5 * 60 * 1000) {
    throw new Error('Transition envelope expired');
  }
  
  // Verify current state matches
  const currentState = loadState().state;
  if (currentState !== payload.currentState) {
    throw new Error(`State mismatch: expected ${payload.currentState}, got ${currentState}`);
  }
  
  // Apply transition
  return transitionState(payload.newState, payload.description);
}

// ============================================================================
// Wake Timer Integration
// ============================================================================

/**
 * Check if advocate should wake based on state and activity.
 * Used by wake timer hook.
 */
function shouldWake() {
  const state = loadState();
  const now = Date.now();
  const lastActivity = new Date(state.lastActivity).getTime();
  
  // Always wake if in 'active' state
  if (state.state === 'active') {
    return true;
  }
  
  // Wake if waiting for hive and it's been more than 5 minutes
  if (state.state === 'waiting-for-hive') {
    const idleTime = now - lastActivity;
    return idleTime > 5 * 60 * 1000; // 5 minutes
  }
  
  // Don't wake if waiting for human or finished
  return false;
}

/**
 * Get wake context for hook output.
 */
function getWakeContext() {
  const state = loadState();
  
  switch (state.state) {
    case 'active':
      return {
        shouldWake: true,
        context: `[ADVOCATE ACTIVE] Advocate is orchestrating ${state.activeHives.length} active hive(s). Continue delegation.`,
        state: state.state
      };
      
    case 'waiting-for-hive':
      return {
        shouldWake: true,
        context: `[ADVOCATE WAITING FOR HIVE] Advocate waiting for hive response. Check hive status.`,
        state: state.state
      };
      
    case 'waiting-for-human':
      return {
        shouldWake: false,
        context: `[ADVOCATE WAITING FOR HUMAN] Awaiting human prompt.`,
        state: state.state
      };
      
    case 'finished':
      return {
        shouldWake: false,
        context: `[ADVOCATE FINISHED] Task completed. Awaiting new instructions.`,
        state: state.state
      };
      
    default:
      return {
        shouldWake: false,
        context: `[ADVOCATE UNKNOWN STATE: ${state.state}]`,
        state: state.state
      };
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (require.main === module) {
  const [,, command, ...args] = process.argv;
  
  try {
    if (command === 'get-state') {
      const state = loadState();
      process.stdout.write(JSON.stringify({ state }));
      
    } else if (command === 'transition') {
      const newState = args[0];
      const description = args.slice(1).join(' ') || '';
      
      if (!newState) {
        throw new Error('Missing newState argument');
      }
      
      const result = transitionState(newState, description);
      process.stdout.write(JSON.stringify({ success: true, state: result }));
      
    } else if (command === 'create-signed-transition') {
      const newState = args[0];
      const description = args.slice(1).join(' ') || '';
      
      if (!newState) {
        throw new Error('Missing newState argument');
      }
      
      const agentId = process.env.AGENTIC_FLOW_AGENT_ID || 
                     process.env.CLAUDE_SESSION_ID || 
                     process.env.CLAUDE_AGENT_ID || '';
      
      const signed = createSignedTransition(newState, description, agentId);
      process.stdout.write(JSON.stringify({ 
        success: true, 
        envelope: signed.envelope 
      }));
      
    } else if (command === 'apply-signed-transition') {
      const rawInput = readStdin();
      if (!rawInput) {
        throw new Error('Missing envelope JSON input');
      }
      
      const envelope = JSON.parse(rawInput);
      const result = applySignedTransition(envelope);
      process.stdout.write(JSON.stringify({ 
        success: true, 
        state: result 
      }));
      
    } else if (command === 'add-hive') {
      const hiveId = args[0];
      if (!hiveId) {
        throw new Error('Missing hiveId argument');
      }
      
      const result = addActiveHive(hiveId);
      process.stdout.write(JSON.stringify({ 
        success: true, 
        state: result 
      }));
      
    } else if (command === 'remove-hive') {
      const hiveId = args[0];
      if (!hiveId) {
        throw new Error('Missing hiveId argument');
      }
      
      const result = removeActiveHive(hiveId);
      process.stdout.write(JSON.stringify({ 
        success: true, 
        state: result 
      }));
      
    } else if (command === 'should-wake') {
      const result = shouldWake();
      process.stdout.write(JSON.stringify({ shouldWake: result }));
      
    } else if (command === 'wake-context') {
      const result = getWakeContext();
      process.stdout.write(JSON.stringify(result));
      
    } else if (command === 'update-activity') {
      const result = updateActivity();
      process.stdout.write(JSON.stringify({ success: true, state: result }));
      
    } else {
      // Default: show current state
      const state = loadState();
      process.stdout.write(JSON.stringify({ 
        state: state.state,
        lastTransition: state.lastTransition,
        lastActivity: state.lastActivity,
        description: state.description,
        activeHives: state.activeHives,
        validTransitions: VALID_TRANSITIONS[state.state] || []
      }));
    }
    
  } catch (error) {
    process.stdout.write(JSON.stringify({ 
      success: false, 
      error: error.message 
    }));
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  loadState,
  saveState,
  transitionState,
  updateActivity,
  addActiveHive,
  removeActiveHive,
  createSignedTransition,
  applySignedTransition,
  shouldWake,
  getWakeContext,
  VALID_TRANSITIONS
};