/**
 * SignalManager Tests
 * Tests for file-based IPC signal system.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SignalManager, SignalEvents } from '../../cli/src/shared/signals/manager.js';
import type { IEventBus } from '../../cli/src/shared/core/interfaces/event.interface.js';

function createMockEventBus(): IEventBus & { emit: Mock } {
  return {
    emit: vi.fn(),
    emitAsync: vi.fn(),
    on: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    once: vi.fn().mockReturnValue({ unsubscribe: vi.fn(), pause: vi.fn(), resume: vi.fn(), isActive: vi.fn() }),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
    listenerCount: vi.fn().mockReturnValue(0),
    eventNames: vi.fn().mockReturnValue([]),
  } as unknown as IEventBus & { emit: Mock };
}

describe('SignalManager', () => {
  let eventBus: IEventBus & { emit: Mock };
  let signalManager: SignalManager;
  let signalsDir: string;

  beforeEach(async () => {
    eventBus = createMockEventBus();
    signalsDir = path.join(os.tmpdir(), `hive-flow-test-signals-${Date.now()}`);
    signalManager = new SignalManager(eventBus, {
      signalsDir,
      swarmId: 'test-swarm',
      pollIntervalMs: 50, // Fast polling for tests
    });
  });

  afterEach(async () => {
    await signalManager.cleanup();
  });

  describe('init', () => {
    it('should create signals directory', async () => {
      await signalManager.init();
      const stat = await fs.stat(signalsDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('state', () => {
    it('should start with default state', () => {
      const state = signalManager.getState();
      expect(state.paused).toBe(false);
      expect(state.stopped).toBe(false);
      expect(state.mode).toBe('autonomous');
      expect(state.lastSignal).toBeNull();
    });

    it('should report isPaused correctly', () => {
      expect(signalManager.isPaused).toBe(false);
    });

    it('should report isStopped correctly', () => {
      expect(signalManager.isStopped).toBe(false);
    });

    it('currentMode getter returns autonomous initially', () => {
      expect(signalManager.currentMode).toBe('autonomous');
    });
  });

  describe('sendPause', () => {
    it('should write a pause signal file', async () => {
      await signalManager.init();
      await signalManager.sendPause('test pause');

      const files = await fs.readdir(signalsDir);
      expect(files).toContain('pause.signal');

      const content = await fs.readFile(path.join(signalsDir, 'pause.signal'), 'utf8');
      const signal = JSON.parse(content);
      expect(signal.type).toBe('pause');
      expect(signal.reason).toBe('test pause');
      expect(signal.source).toBe('user');
    });
  });

  describe('sendResume', () => {
    it('should write a resume signal file', async () => {
      await signalManager.init();
      await signalManager.sendResume();

      const files = await fs.readdir(signalsDir);
      expect(files).toContain('resume.signal');
    });
  });

  describe('sendStop', () => {
    it('should write a stop signal file', async () => {
      await signalManager.init();
      await signalManager.sendStop('shutting down');

      const content = await fs.readFile(path.join(signalsDir, 'stop.signal'), 'utf8');
      const signal = JSON.parse(content);
      expect(signal.type).toBe('stop');
      expect(signal.reason).toBe('shutting down');
    });
  });

  describe('sendModeChange', () => {
    it('should write a mode-change signal file', async () => {
      await signalManager.init();
      await signalManager.sendModeChange('interactive', 'user requested');

      const content = await fs.readFile(path.join(signalsDir, 'mode-change.signal'), 'utf8');
      const signal = JSON.parse(content);
      expect(signal.type).toBe('mode-change');
      expect(signal.targetMode).toBe('interactive');
    });
  });

  describe('polling', () => {
    it('should detect and process pause signal', async () => {
      await signalManager.init();

      // Write a pause signal file directly
      await signalManager.sendPause('poll test');

      // Wait for polling to pick it up
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(eventBus.emit).toHaveBeenCalledWith(
        SignalEvents.PAUSE_REQUESTED,
        expect.objectContaining({ type: 'pause' }),
      );
      expect(signalManager.isPaused).toBe(true);
    });

    it('should consume signal files after processing', async () => {
      await signalManager.init();
      await signalManager.sendSkip();

      // Wait for polling
      await new Promise(resolve => setTimeout(resolve, 150));

      const files = await fs.readdir(signalsDir);
      const signalFiles = files.filter(f => f.endsWith('.signal'));
      expect(signalFiles).toHaveLength(0);
    });

    it('polling detects resume signal and sets paused to false', async () => {
      await signalManager.init();

      // Force to paused state first
      await signalManager.sendPause();
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(signalManager.isPaused).toBe(true);

      // Now resume
      await signalManager.sendResume();
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(signalManager.isPaused).toBe(false);
      expect(eventBus.emit).toHaveBeenCalledWith(
        SignalEvents.RESUME_REQUESTED,
        expect.objectContaining({ type: 'resume' }),
      );
    });

    it('polling detects stop signal and updates state', async () => {
      await signalManager.init();

      await signalManager.sendStop('Emergency stop');
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(signalManager.isStopped).toBe(true);
      expect(eventBus.emit).toHaveBeenCalledWith(
        SignalEvents.STOP_REQUESTED,
        expect.objectContaining({ type: 'stop', reason: 'Emergency stop' }),
      );
    });
  });

  describe('state getters', () => {
    it('currentMode returns autonomous initially', async () => {
      expect(signalManager.currentMode).toBe('autonomous');
    });

    it('polling detects mode-change signal and updates mode', async () => {
      await signalManager.init();

      await signalManager.sendModeChange('interactive');
      await new Promise(resolve => setTimeout(resolve, 150));

      expect(signalManager.currentMode).toBe('interactive');
      expect(eventBus.emit).toHaveBeenCalledWith(
        SignalEvents.MODE_CHANGE_REQUESTED,
        expect.objectContaining({ type: 'mode-change', targetMode: 'interactive' }),
      );
    });
  });

  describe('acknowledge', () => {
    it('should write an ack file', async () => {
      await signalManager.init();
      await signalManager.acknowledge('pause', 'coordinator', 'Agents paused');

      const files = await fs.readdir(signalsDir);
      expect(files).toContain('pause.ack');

      const content = await fs.readFile(path.join(signalsDir, 'pause.ack'), 'utf8');
      const ack = JSON.parse(content);
      expect(ack.signalType).toBe('pause');
      expect(ack.acknowledged).toBe(true);
      expect(ack.acknowledgedBy).toBe('coordinator');
    });

    it('should emit SIGNAL_ACKNOWLEDGED event', async () => {
      await signalManager.init();
      await signalManager.acknowledge('stop', 'coordinator');

      expect(eventBus.emit).toHaveBeenCalledWith(
        SignalEvents.SIGNAL_ACKNOWLEDGED,
        expect.objectContaining({ signalType: 'stop', acknowledged: true }),
      );
    });
  });
});
