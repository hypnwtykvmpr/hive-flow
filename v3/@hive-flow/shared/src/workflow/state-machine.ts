/**
 * Workflow State Machine — parallel track support + HMAC persistence
 *
 * Manages workflow state transitions with:
 * - Defined states from IDLE through COMPLETE
 * - Parallel track support for concurrent module states
 * - HMAC-signed persistence to .hive-flow/workflows/state.json
 * - Advocate transitions (any state -> any state) vs agent transitions (forward only)
 * - Compaction-safe: survives session breaks
 *
 * HMAC pattern: Uses the same scheme as workflow-enforcer.ts.
 * Intentionally self-contained — @hive-flow/shared does not depend on
 * @hive-flow/cli, so the helpers are inlined rather than imported.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import type {
  WorkflowState,
  WorkflowModuleState,
  WorkflowParallelTrack,
  WorkflowExecutionStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// State Definitions
// ---------------------------------------------------------------------------

/**
 * All valid workflow state machine positions.
 */
export const WORKFLOW_STATES = [
  'IDLE',
  'INVESTIGATING',
  'RESEARCHING',
  'VERIFYING_INVESTIGATION',
  'VERIFYING_RESEARCH',
  'DESIGNING',
  'PLANNING',
  'VERIFYING_DESIGN',
  'VERIFYING_PLAN',
  'AWAITING_HUMAN_APPROVAL',
  'IMPLEMENTING',
  'VERIFYING_IMPLEMENTATION',
  'AUDITING',
  'VERIFYING_AUDIT',
  'COMMITTING',
  'COMPLETE',
] as const;

export type WorkflowStateName = typeof WORKFLOW_STATES[number];

/**
 * Valid forward transitions for agent-initiated state changes.
 * Agents can only move forward through the defined sequence.
 */
const FORWARD_TRANSITIONS: Record<WorkflowStateName, WorkflowStateName[]> = {
  IDLE: ['INVESTIGATING', 'RESEARCHING', 'DESIGNING', 'PLANNING'],
  INVESTIGATING: ['VERIFYING_INVESTIGATION'],
  RESEARCHING: ['VERIFYING_RESEARCH'],
  VERIFYING_INVESTIGATION: ['RESEARCHING', 'DESIGNING'],
  VERIFYING_RESEARCH: ['DESIGNING', 'PLANNING'],
  DESIGNING: ['VERIFYING_DESIGN'],
  PLANNING: ['VERIFYING_PLAN'],
  VERIFYING_DESIGN: ['PLANNING', 'IMPLEMENTING'],
  VERIFYING_PLAN: ['AWAITING_HUMAN_APPROVAL', 'IMPLEMENTING'],
  AWAITING_HUMAN_APPROVAL: ['IMPLEMENTING'],
  IMPLEMENTING: ['VERIFYING_IMPLEMENTATION'],
  VERIFYING_IMPLEMENTATION: ['AUDITING', 'IMPLEMENTING'],
  AUDITING: ['VERIFYING_AUDIT'],
  VERIFYING_AUDIT: ['COMMITTING', 'IMPLEMENTING'],
  COMMITTING: ['COMPLETE'],
  COMPLETE: [],
};

// ---------------------------------------------------------------------------
// HMAC Helpers (self-contained — matches workflow-enforcer.ts pattern)
// ---------------------------------------------------------------------------

const STORAGE_DIR = '.hive-flow';
const WORKFLOW_DIR = 'workflows';
const STATE_FILE = 'state.json';

function getWorkflowDir(): string {
  return join(process.cwd(), STORAGE_DIR, WORKFLOW_DIR);
}

function getStatePath(): string {
  return join(getWorkflowDir(), STATE_FILE);
}

function getHmacKeyPath(): string {
  return join(process.cwd(), STORAGE_DIR, 'enforcement', '.hmac-key');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getOrCreateHmacKey(): string {
  const keyPath = getHmacKeyPath();
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf-8').trim();
  }
  // Generate a new key if none exists
  const enfDir = join(process.cwd(), STORAGE_DIR, 'enforcement');
  ensureDir(enfDir);
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function signPayload(payload: unknown, key: string): string {
  return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
}

function verifySignature(payload: unknown, signature: string, key: string): boolean {
  const expected = signPayload(payload, key);
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

export class WorkflowStateMachine {
  private state: WorkflowState;

  constructor(workflowName: string, instanceId?: string) {
    this.state = {
      workflowName,
      instanceId: instanceId || `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      currentPosition: 'IDLE',
      moduleStates: {},
      parallelTracks: [],
      variables: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // State access
  // -----------------------------------------------------------------------

  getState(): Readonly<WorkflowState> {
    return { ...this.state };
  }

  getCurrentPosition(): WorkflowStateName {
    return this.state.currentPosition as WorkflowStateName;
  }

  getStatus(): WorkflowExecutionStatus {
    return this.state.status;
  }

  getModuleState(moduleName: string): WorkflowModuleState | undefined {
    return this.state.moduleStates[moduleName];
  }

  getParallelTracks(): ReadonlyArray<WorkflowParallelTrack> {
    return [...this.state.parallelTracks];
  }

  // -----------------------------------------------------------------------
  // Agent transitions (forward only)
  // -----------------------------------------------------------------------

  /**
   * Transition to a new state. Agents can only move forward through valid transitions.
   * Returns true if transition succeeded, false if invalid.
   */
  agentTransition(targetState: WorkflowStateName): boolean {
    const current = this.state.currentPosition as WorkflowStateName;
    const validTargets = FORWARD_TRANSITIONS[current];

    if (!validTargets || !validTargets.includes(targetState)) {
      return false;
    }

    this.state.currentPosition = targetState;
    this.state.updatedAt = new Date().toISOString();

    if (targetState === 'COMPLETE') {
      this.state.status = 'completed';
    } else if (this.state.status === 'pending') {
      this.state.status = 'running';
    }

    return true;
  }

  /**
   * Get valid forward transitions from the current state.
   */
  getValidTransitions(): WorkflowStateName[] {
    const current = this.state.currentPosition as WorkflowStateName;
    return FORWARD_TRANSITIONS[current] || [];
  }

  // -----------------------------------------------------------------------
  // Advocate transitions (any state -> any state)
  // -----------------------------------------------------------------------

  /**
   * Advocate/override transition — can move to any state.
   * This is used by human advocates or coordinator overrides.
   */
  advocateTransition(targetState: WorkflowStateName): void {
    this.state.currentPosition = targetState;
    this.state.updatedAt = new Date().toISOString();

    if (targetState === 'COMPLETE') {
      this.state.status = 'completed';
    } else if (targetState === 'IDLE') {
      this.state.status = 'pending';
    } else {
      this.state.status = 'running';
    }
  }

  // -----------------------------------------------------------------------
  // Module state management
  // -----------------------------------------------------------------------

  /**
   * Register a module execution instance.
   */
  registerModule(moduleName: string, instanceId?: string): string {
    const id = instanceId || `mod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state.moduleStates[moduleName] = {
      moduleName,
      instanceId: id,
      status: 'pending',
    };
    this.state.updatedAt = new Date().toISOString();
    return id;
  }

  /**
   * Update module state.
   */
  updateModuleState(moduleName: string, update: Partial<WorkflowModuleState>): void {
    const moduleState = this.state.moduleStates[moduleName];
    if (!moduleState) return;

    Object.assign(moduleState, update);
    this.state.updatedAt = new Date().toISOString();
  }

  // -----------------------------------------------------------------------
  // Parallel track management
  // -----------------------------------------------------------------------

  /**
   * Create a parallel track for concurrent module execution.
   */
  createParallelTrack(modules: string[]): string {
    const trackId = `track-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.state.parallelTracks.push({
      trackId,
      modules,
      status: 'pending',
    });
    this.state.updatedAt = new Date().toISOString();
    return trackId;
  }

  /**
   * Update parallel track status.
   */
  updateTrackStatus(trackId: string, status: WorkflowExecutionStatus): void {
    const track = this.state.parallelTracks.find(t => t.trackId === trackId);
    if (track) {
      track.status = status;
      this.state.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Check if all tracks in a parallel group are complete.
   */
  areAllTracksComplete(): boolean {
    return this.state.parallelTracks.every(
      t => t.status === 'completed' || t.status === 'cancelled'
    );
  }

  // -----------------------------------------------------------------------
  // Workflow-level status
  // -----------------------------------------------------------------------

  /**
   * Set the overall workflow status.
   */
  setStatus(status: WorkflowExecutionStatus): void {
    this.state.status = status;
    this.state.updatedAt = new Date().toISOString();
  }

  /**
   * Set a workflow variable.
   */
  setVariable(key: string, value: unknown): void {
    this.state.variables[key] = value;
    this.state.updatedAt = new Date().toISOString();
  }

  /**
   * Get a workflow variable.
   */
  getVariable(key: string): unknown {
    return this.state.variables[key];
  }

  // -----------------------------------------------------------------------
  // HMAC-signed persistence
  // -----------------------------------------------------------------------

  /**
   * Save the current state to disk with HMAC signature.
   * Persists to .hive-flow/workflows/state.json
   */
  save(): void {
    const dir = getWorkflowDir();
    ensureDir(dir);

    const key = getOrCreateHmacKey();
    // Strip signature from payload before signing
    const { signature: _sig, ...payloadWithoutSig } = this.state;
    const sig = signPayload(payloadWithoutSig, key);
    this.state.signature = sig;

    const envelope = {
      payload: payloadWithoutSig,
      signature: sig,
    };

    const targetPath = getStatePath();
    const tmpPath = targetPath + '.tmp.' + process.pid;
    writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8');
    // Atomic rename
    renameSync(tmpPath, targetPath);
  }

  /**
   * Load state from disk and verify HMAC signature.
   * Returns null if no state exists or signature is invalid.
   */
  static load(): WorkflowStateMachine | null {
    try {
      const statePath = getStatePath();
      if (!existsSync(statePath)) return null;

      const raw = JSON.parse(readFileSync(statePath, 'utf-8'));

      let state: WorkflowState;
      let signatureValid = false;

      if (raw?.payload !== undefined && typeof raw?.signature === 'string') {
        // HMAC-signed envelope
        const key = getOrCreateHmacKey();
        signatureValid = verifySignature(raw.payload, raw.signature, key);
        state = raw.payload as WorkflowState;
        state.signature = raw.signature;
      } else {
        // Legacy plain JSON — accept for migration
        state = raw as WorkflowState;
        signatureValid = true; // Trust legacy data
      }

      if (!signatureValid) {
        // Signature mismatch — state may have been tampered with
        return null;
      }

      const machine = new WorkflowStateMachine(state.workflowName, state.instanceId);
      machine.state = state;
      return machine;
    } catch {
      return null;
    }
  }

  /**
   * Check if a persisted state file exists.
   */
  static exists(): boolean {
    return existsSync(getStatePath());
  }

  /**
   * Delete the persisted state file.
   */
  static clear(): void {
    const statePath = getStatePath();
    if (existsSync(statePath)) {
      unlinkSync(statePath);
    }
  }
}
