import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import * as nodePath from 'node:path';

// Real (un-mocked) fs — obtained via require BEFORE vi.mock hoisting rewrites the module.
// This is used in Part 2 for actual filesystem operations in enforcement.cjs tests.
// We use a CJS require() so vitest's ESM mock does not intercept it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = require('fs') as typeof import('node:fs');

// ── Module mocks (hoisted before imports) ────────────────────────────────
//
// workflow-tools.ts imports from 'node:fs' as ES named imports.
// We mock the entire module so no disk I/O occurs during MCP tool tests.

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRenameSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockAppendFileSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  renameSync: (...args: unknown[]) => mockRenameSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
}));

// workflow-executor is imported by workflow-tools — mock it to avoid side effects
vi.mock('../mcp-tools/workflow-executor.js', () => ({
  executeWorkflowStep: vi.fn().mockResolvedValue({ stepId: 'step-1', status: 'completed', result: {} }),
}));

import { workflowTools } from '../mcp-tools/workflow-tools.js';

// ── Extract pipeline tool handlers ────────────────────────────────────────

type HandlerFn = (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function getTool(name: string): HandlerFn {
  const tool = workflowTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' not found in workflowTools`);
  return tool.handler as HandlerFn;
}

// ── HMAC helpers (mirrors what workflow-tools.ts does internally) ─────────

/**
 * Capture the HMAC key written to disk and use it to produce valid test envelopes.
 * Since getPipelineHmacKey() will call existsSync(HMAC_KEY_FILE) -> false (mocked),
 * then write a new random key, we capture it via writeFileSync mock.
 */
let capturedHmacKey: string | null = null;

function resetHmacKeyCapture() {
  capturedHmacKey = null;
}

function setupHmacKeyMock() {
  // The first call to getPipelineHmacKey() will:
  //   1. existsSync(HMAC_KEY_FILE) -> false
  //   2. generate random key
  //   3. writeFileSync(HMAC_KEY_FILE, key)
  // We intercept the write to capture the key.
  mockWriteFileSync.mockImplementation((...args: unknown[]) => {
    const filePath = args[0] as string;
    const data = args[1] as string;
    if (typeof filePath === 'string' && filePath.endsWith('.hmac-key')) {
      capturedHmacKey = data.trim();
    }
    // always succeed
  });
}

function computeHmac(key: string, data: unknown): string {
  return nodeCrypto.createHmac('sha256', key).update(JSON.stringify(data)).digest('hex');
}

function makeEnvelope(key: string, state: Record<string, unknown>) {
  const hmac = computeHmac(key, state);
  return { state, hmac };
}

// ── Default pipeline stages ───────────────────────────────────────────────

const DEFAULT_STAGES = ['implement', 'verify', 'test', 'debug', 'verify_test', 'audit', 'verify_audit'];
const CUSTOM_STAGES = ['planning', 'coding', 'review'];

// ──────────────────────────────────────────────────────────────────────────
// Part 1 — MCP Tool Tests (workflow-tools.ts handlers)
// ──────────────────────────────────────────────────────────────────────────

describe('Pipeline MCP Tools (workflow-tools.ts)', () => {
  let pipeline_init: HandlerFn;
  let pipeline_stage_complete: HandlerFn;
  let pipeline_status: HandlerFn;

  beforeEach(() => {
    vi.clearAllMocks();
    resetHmacKeyCapture();

    pipeline_init = getTool('pipeline_init');
    pipeline_stage_complete = getTool('pipeline_stage_complete');
    pipeline_status = getTool('pipeline_status');

    // Default: HMAC key file does not exist → will be created
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('.hmac-key')) return false;
      if (typeof p === 'string' && p.endsWith('pipeline-state.json')) return false;
      return false;
    });
    mockMkdirSync.mockReturnValue(undefined);
    mockRenameSync.mockReturnValue(undefined);
    mockAppendFileSync.mockReturnValue(undefined);
    setupHmacKeyMock();
  });

  // ── pipeline_init ───────────────────────────────────────────────────────

  describe('pipeline_init', () => {
    it('test 1: creates pipeline-state.json with default stages when no stages provided', async () => {
      const result = await pipeline_init({});

      // mkdirSync should have been called to ensure enforcement dir exists
      expect(mockMkdirSync).toHaveBeenCalled();

      // writeFileSync should be called (for both .hmac-key and then the tmp state file)
      expect(mockWriteFileSync).toHaveBeenCalled();

      // renameSync does the atomic write of the state file
      expect(mockRenameSync).toHaveBeenCalled();

      // Tool return value should include default stages
      expect(result.stages).toEqual(DEFAULT_STAGES);
      expect(result.message).toContain('7 stages');
    });

    it('test 2: creates pipeline-state.json with custom stages when stages array provided', async () => {
      const result = await pipeline_init({ stages: CUSTOM_STAGES });

      expect(result.stages).toEqual(CUSTOM_STAGES);
      expect(result.message).toContain('3 stages');
    });

    it('test 3: generates taskId when none provided', async () => {
      const result = await pipeline_init({});

      expect(result.taskId).toBeDefined();
      expect(typeof result.taskId).toBe('string');
      expect((result.taskId as string).startsWith('task-')).toBe(true);
    });

    it('test 4: uses provided taskId', async () => {
      const result = await pipeline_init({ taskId: 'my-custom-task-123' });

      expect(result.taskId).toBe('my-custom-task-123');
    });

    it('test 5: state is HMAC-signed (written file contains state and hmac fields)', async () => {
      // Capture what gets written to the tmp state file (not .hmac-key)
      let writtenPayload: Record<string, unknown> | null = null;
      mockWriteFileSync.mockImplementation((...args: unknown[]) => {
        const filePath = args[0] as string;
        const data = args[1] as string;
        if (typeof filePath === 'string' && filePath.endsWith('.hmac-key')) {
          capturedHmacKey = data.trim();
          return;
        }
        // State file write (tmp path ending with pid.timestamp)
        if (typeof filePath === 'string' && filePath.includes('pipeline-state.json')) {
          writtenPayload = JSON.parse(data);
        }
      });

      await pipeline_init({ taskId: 'task-sign-test' });

      expect(writtenPayload).not.toBeNull();
      expect(writtenPayload).toHaveProperty('state');
      expect(writtenPayload).toHaveProperty('hmac');
      expect(typeof (writtenPayload as Record<string, unknown>).hmac).toBe('string');
    });

    it('test 6: all stages initialized as complete: false', async () => {
      let writtenPayload: Record<string, unknown> | null = null;
      mockWriteFileSync.mockImplementation((...args: unknown[]) => {
        const filePath = args[0] as string;
        const data = args[1] as string;
        if (typeof filePath === 'string' && filePath.endsWith('.hmac-key')) {
          capturedHmacKey = data.trim();
          return;
        }
        if (typeof filePath === 'string' && filePath.includes('pipeline-state.json')) {
          writtenPayload = JSON.parse(data);
        }
      });

      await pipeline_init({ stages: CUSTOM_STAGES });

      const envelope = writtenPayload as { state: Record<string, unknown> } | null;
      expect(envelope).not.toBeNull();
      const state = envelope!.state as Record<string, unknown>;
      const stages = state.stages as Record<string, { complete: boolean }>;

      for (const stageName of CUSTOM_STAGES) {
        expect(stages[stageName]).toBeDefined();
        expect(stages[stageName].complete).toBe(false);
      }
    });
  });

  // ── pipeline_stage_complete ─────────────────────────────────────────────

  describe('pipeline_stage_complete', () => {
    /**
     * Setup: mock the file system so that pipelineReadState() returns a valid
     * signed state with the given stages and taskId.
     */
    function setupPipelineState(
      taskId: string,
      stages: string[],
      completedStages: string[] = [],
      hmacKey?: string,
    ) {
      const key = hmacKey ?? 'test-fixed-key-for-stage-tests';
      const stagesObj: Record<string, { complete: boolean; completedAt: string | null; completedBy: string | null }> = {};
      for (const s of stages) {
        stagesObj[s] = {
          complete: completedStages.includes(s),
          completedAt: completedStages.includes(s) ? new Date().toISOString() : null,
          completedBy: null,
        };
      }
      const state = {
        taskId,
        startedAt: new Date().toISOString(),
        stages: stagesObj,
        requiredStages: stages,
        overrideActive: false,
        overrideReason: null,
        overrideAt: null,
      };
      const envelope = makeEnvelope(key, state);

      // HMAC key file exists and returns our test key
      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('.hmac-key')) return true;
        if (typeof p === 'string' && p.endsWith('pipeline-state.json')) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('.hmac-key')) return key;
        if (typeof p === 'string' && p.endsWith('pipeline-state.json')) return JSON.stringify(envelope);
        throw new Error(`Unexpected readFileSync: ${p}`);
      });
    }

    it('test 7: marks a stage as complete', async () => {
      setupPipelineState('task-abc', CUSTOM_STAGES);

      const result = await pipeline_stage_complete({ stage: 'planning' });

      expect(result.success).toBe(true);
      expect(result.stage).toBe('planning');
      expect(result.completedAt).toBeDefined();
      // Should write updated state back to disk
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockRenameSync).toHaveBeenCalled();
    });

    it('test 8: returns error when no active pipeline', async () => {
      // File does not exist
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockImplementation(() => { throw new Error('File not found'); });

      const result = await pipeline_stage_complete({ stage: 'implement' });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('No active pipeline');
    });

    it('test 9: returns error for unknown stage name', async () => {
      setupPipelineState('task-abc', CUSTOM_STAGES);

      const result = await pipeline_stage_complete({ stage: 'nonexistent-stage' });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Unknown stage');
      expect(result.reason).toContain('nonexistent-stage');
    });

    it('test 10: returns "already complete" for already-completed stage', async () => {
      setupPipelineState('task-abc', CUSTOM_STAGES, ['planning']);

      const result = await pipeline_stage_complete({ stage: 'planning' });

      expect(result.success).toBe(true);
      expect(result.reason).toContain('Already complete');
    });

    it('test 11: records completedAt timestamp', async () => {
      setupPipelineState('task-abc', CUSTOM_STAGES);

      const before = new Date().toISOString();
      const result = await pipeline_stage_complete({ stage: 'planning' });
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      const completedAt = result.completedAt as string;
      expect(completedAt).toBeDefined();
      expect(completedAt >= before).toBe(true);
      expect(completedAt <= after).toBe(true);
    });

    it('test 12: taskId mismatch returns error', async () => {
      setupPipelineState('task-abc', CUSTOM_STAGES);

      const result = await pipeline_stage_complete({ stage: 'planning', taskId: 'wrong-task-id' });

      expect(result.success).toBe(false);
      expect(result.reason).toContain('mismatch');
      expect(result.reason).toContain('task-abc');
      expect(result.reason).toContain('wrong-task-id');
    });
  });

  // ── pipeline_status ─────────────────────────────────────────────────────

  describe('pipeline_status', () => {
    function setupStatusState(
      taskId: string,
      stages: string[],
      completedStages: string[] = [],
      overrideActive = false,
      hmacKey = 'test-fixed-key-for-status-tests',
    ) {
      const stagesObj: Record<string, { complete: boolean; completedAt: string | null; completedBy: string | null }> = {};
      for (const s of stages) {
        stagesObj[s] = {
          complete: completedStages.includes(s),
          completedAt: completedStages.includes(s) ? new Date().toISOString() : null,
          completedBy: null,
        };
      }
      const state = {
        taskId,
        startedAt: new Date().toISOString(),
        stages: stagesObj,
        requiredStages: stages,
        overrideActive,
        overrideReason: null,
        overrideAt: null,
      };
      const envelope = makeEnvelope(hmacKey, state);

      mockExistsSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('.hmac-key')) return true;
        if (typeof p === 'string' && p.endsWith('pipeline-state.json')) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('.hmac-key')) return hmacKey;
        if (typeof p === 'string' && p.endsWith('pipeline-state.json')) return JSON.stringify(envelope);
        throw new Error(`Unexpected readFileSync: ${p}`);
      });
    }

    it('test 13: returns null when no pipeline exists', async () => {
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockImplementation(() => { throw new Error('No file'); });

      const result = await pipeline_status({});

      expect(result.active).toBe(false);
      expect(result.message).toContain('No active pipeline');
    });

    it('test 14: returns stage details with complete/incomplete status', async () => {
      setupStatusState('task-xyz', CUSTOM_STAGES, ['planning']);

      const result = await pipeline_status({});

      expect(result.active).toBe(true);
      expect(result.taskId).toBe('task-xyz');

      const stages = result.stages as Array<{ name: string; complete: boolean }>;
      expect(stages).toHaveLength(3);

      const planningStage = stages.find(s => s.name === 'planning');
      const codingStage = stages.find(s => s.name === 'coding');

      expect(planningStage?.complete).toBe(true);
      expect(codingStage?.complete).toBe(false);
    });

    it('test 15: returns commitBlocked: true when stages are incomplete', async () => {
      setupStatusState('task-xyz', CUSTOM_STAGES, ['planning']); // 2 of 3 still pending

      const result = await pipeline_status({});

      expect(result.commitBlocked).toBe(true);
      expect(result.allComplete).toBe(false);
      const incomplete = result.incompleteStages as string[];
      expect(incomplete).toContain('coding');
      expect(incomplete).toContain('review');
    });

    it('test 16: returns commitBlocked: false when all stages complete', async () => {
      setupStatusState('task-xyz', CUSTOM_STAGES, CUSTOM_STAGES); // all complete

      const result = await pipeline_status({});

      expect(result.commitBlocked).toBe(false);
      expect(result.allComplete).toBe(true);
      const incomplete = result.incompleteStages as string[];
      expect(incomplete).toHaveLength(0);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Part 2 — enforcement.cjs Pipeline Functions (direct require)
// ──────────────────────────────────────────────────────────────────────────
//
// enforcement.cjs uses the real filesystem but derives PIPELINE_STATE_FILE
// from __dirname. We test using the actual path the module uses, cleaning up
// before/after each test to avoid cross-test contamination.

const ENFORCEMENT_CJS_PATH = nodePath.resolve(
  __dirname, '..', '..', '..', '..', '..', '.claude', 'helpers', 'enforcement.cjs'
);

// The enforcement dir as the module will use it (from __dirname)
const ENF_DIR = nodePath.resolve(
  nodePath.dirname(ENFORCEMENT_CJS_PATH), '..', '..', '.hive-flow', 'enforcement'
);
const PIPELINE_STATE_PATH = nodePath.join(ENF_DIR, 'pipeline-state.json');
const HMAC_KEY_PATH = nodePath.join(ENF_DIR, '.hmac-key');

function cleanEnforcementPipelineState() {
  try { realFs.unlinkSync(PIPELINE_STATE_PATH); } catch { /* ok */ }
}

function cleanHmacKey() {
  // Not called in tests but kept as a utility. Uses realFs.
  try { realFs.unlinkSync(HMAC_KEY_PATH); } catch { /* ok */ }
}

describe('enforcement.cjs Pipeline Functions (direct require)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let enf: any;

  beforeEach(() => {
    vi.resetModules();
    // Require fresh module each time
    enf = require(ENFORCEMENT_CJS_PATH);
    // Clean state from previous tests
    cleanEnforcementPipelineState();
  });

  afterEach(() => {
    cleanEnforcementPipelineState();
  });

  // ── initPipeline ──────────────────────────────────────────────────────

  describe('initPipeline', () => {
    it('test 17: initPipeline creates signed state file on disk', () => {
      enf.initPipeline('task-cjs-1', ['implement', 'verify']);

      expect(realFs.existsSync(PIPELINE_STATE_PATH)).toBe(true);
      const raw = JSON.parse(realFs.readFileSync(PIPELINE_STATE_PATH, 'utf-8'));
      expect(raw).toHaveProperty('state');
      expect(raw).toHaveProperty('hmac');

      const state = raw.state;
      expect(state.taskId).toBe('task-cjs-1');
      expect(state.requiredStages).toEqual(['implement', 'verify']);
    });

    it('test 17b: initPipeline with default stages when none provided', () => {
      enf.initPipeline(null, null);

      expect(realFs.existsSync(PIPELINE_STATE_PATH)).toBe(true);
      const raw = JSON.parse(realFs.readFileSync(PIPELINE_STATE_PATH, 'utf-8'));
      const state = raw.state;
      expect(state.requiredStages).toEqual(['implement', 'verify', 'test', 'debug', 'verify_test', 'audit', 'verify_audit']);
      // all stages initialized as complete: false
      for (const s of state.requiredStages) {
        expect(state.stages[s].complete).toBe(false);
      }
    });
  });

  // ── completePipelineStage ─────────────────────────────────────────────

  describe('completePipelineStage', () => {
    it('test 18: completePipelineStage updates and re-signs the state file', () => {
      enf.initPipeline('task-cjs-2', ['step-a', 'step-b']);

      const result = enf.completePipelineStage('task-cjs-2', 'step-a');

      expect(result.success).toBe(true);

      // Verify the file was re-written and the stage is marked complete
      const raw = JSON.parse(realFs.readFileSync(PIPELINE_STATE_PATH, 'utf-8'));
      expect(raw).toHaveProperty('hmac'); // re-signed
      expect(raw.state.stages['step-a'].complete).toBe(true);
      expect(raw.state.stages['step-a'].completedAt).toBeDefined();
      expect(raw.state.stages['step-b'].complete).toBe(false);
    });

    it('returns no active pipeline when no file', () => {
      // No initPipeline called
      const result = enf.completePipelineStage('task-x', 'step-a');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('No active pipeline');
    });
  });

  // ── getPipelineState ──────────────────────────────────────────────────

  describe('getPipelineState', () => {
    it('test 19: returns null when no file exists', () => {
      const state = enf.getPipelineState();
      expect(state).toBeNull();
    });

    it('test 20: returns state object when file exists', () => {
      enf.initPipeline('task-get-1', ['a', 'b', 'c']);

      const state = enf.getPipelineState();

      expect(state).not.toBeNull();
      expect(state.taskId).toBe('task-get-1');
      expect(state.requiredStages).toEqual(['a', 'b', 'c']);
      expect(state.overrideActive).toBe(false);
    });
  });

  // ── overridePipeline ──────────────────────────────────────────────────

  describe('overridePipeline', () => {
    it('test 21: overridePipeline sets overrideActive to true', () => {
      enf.initPipeline('task-ov-1', ['step-x']);

      const result = enf.overridePipeline('Emergency bypass for hotfix');

      expect(result.success).toBe(true);

      const state = enf.getPipelineState();
      expect(state.overrideActive).toBe(true);
      expect(state.overrideReason).toBe('Emergency bypass for hotfix');
      expect(state.overrideAt).toBeDefined();
    });

    it('returns error when no active pipeline', () => {
      const result = enf.overridePipeline('no pipeline exists');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('No active pipeline');
    });
  });

  // ── resetPipeline ─────────────────────────────────────────────────────

  describe('resetPipeline', () => {
    it('test 22: resetPipeline deletes the state file', () => {
      enf.initPipeline('task-reset-1', ['s1']);
      expect(realFs.existsSync(PIPELINE_STATE_PATH)).toBe(true);

      const result = enf.resetPipeline();

      expect(result.success).toBe(true);
      expect(realFs.existsSync(PIPELINE_STATE_PATH)).toBe(false);
    });

    it('succeeds even when no file exists', () => {
      const result = enf.resetPipeline();
      expect(result.success).toBe(true);
    });
  });

  // ── checkVerificationGate — pipeline integration ──────────────────────

  describe('checkVerificationGate — pipeline integration', () => {
    it('test 23: checkVerificationGate blocks git commit when stages incomplete', () => {
      enf.initPipeline('task-gate-1', ['implement', 'verify']);

      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "WIP"' });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('[PIPELINE GATE]');
      expect(result.reason).toContain('implement');
      expect(result.reason).toContain('verify');
    });

    it('test 24: checkVerificationGate allows git commit when all stages complete', () => {
      enf.initPipeline('task-gate-2', ['implement', 'verify']);
      enf.completePipelineStage('task-gate-2', 'implement');
      enf.completePipelineStage('task-gate-2', 'verify');

      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "Done"' });

      expect(result.blocked).toBe(false);
    });

    it('test 25: checkVerificationGate allows when overrideActive is true', () => {
      enf.initPipeline('task-gate-3', ['implement', 'verify']); // stages not complete
      enf.overridePipeline('Emergency');

      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "Override"' });

      expect(result.blocked).toBe(false);
    });

    it('test 26: checkVerificationGate falls through to swarm check when no pipeline file', () => {
      // No pipeline file exists — should NOT produce a PIPELINE GATE block.
      // In non-swarm mode (no .hive-flow/swarm dir), it falls through to allow.
      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "No pipeline"' });

      // result.blocked may be true due to swarm gate, but NOT due to pipeline gate
      // The reason must NOT contain '[PIPELINE GATE]'
      if (result.blocked) {
        expect(result.reason).not.toContain('[PIPELINE GATE]');
      } else {
        expect(result.blocked).toBe(false);
      }
    });

    it('test 26b: checkVerificationGate does not block non-Bash tools', () => {
      enf.initPipeline('task-gate-nb', ['implement']);

      const result = enf.checkVerificationGate('Write', { file_path: 'foo.ts' });

      expect(result.blocked).toBe(false);
    });

    it('test 26c: checkVerificationGate does not block Bash commands that are not git commit', () => {
      enf.initPipeline('task-gate-nc', ['implement']);

      const result = enf.checkVerificationGate('Bash', { command: 'npm test' });

      expect(result.blocked).toBe(false);
    });

    it('test 27: checkVerificationGate blocks when HMAC is tampered', () => {
      enf.initPipeline('task-gate-tamper', ['implement']);

      // Read the state file, tamper the hmac, write it back
      const raw = JSON.parse(realFs.readFileSync(PIPELINE_STATE_PATH, 'utf-8'));
      raw.hmac = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      realFs.writeFileSync(PIPELINE_STATE_PATH, JSON.stringify(raw));

      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "tampered"' });

      // With a tampered HMAC, the gate should block due to integrity failure
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('[PIPELINE GATE]');
    });

    it('test 28: allows commit when HIVE_FLOW_PIPELINE_OVERRIDE=1 is set', () => {
      // Initialize pipeline with incomplete stages
      enf.initPipeline('test-env-override', ['implement', 'verify']);
      // Set env var
      process.env.HIVE_FLOW_PIPELINE_OVERRIDE = '1';
      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "override"' });
      expect(result.blocked).toBe(false);
      // Clean up env var
      delete process.env.HIVE_FLOW_PIPELINE_OVERRIDE;
    });

    it('test 29: blocks commit when HIVE_FLOW_PIPELINE_OVERRIDE is not set', () => {
      enf.initPipeline('test-no-override', ['implement', 'verify']);
      delete process.env.HIVE_FLOW_PIPELINE_OVERRIDE;
      const result = enf.checkVerificationGate('Bash', { command: 'git commit -m "test"' });
      expect(result.blocked).toBe(true);
    });
  });
});
