/**
 * Signal Manager
 * Central coordinator for user-initiated workflow control signals.
 * Uses file-based IPC for cross-process signaling between the CLI
 * and running agents/swarms.
 *
 * Signal flow:
 *   User CLI → writes signal file → SignalManager polls → emits on EventBus
 *   Coordinator reads EventBus → handles signal → writes ack file
 *
 * Adapted from CodeMachine-CLI's SignalManager pattern.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IEventBus } from '../core/interfaces/event.interface.js';
import type {
  Signal,
  SignalAck,
  SignalState,
  SignalType,
  SignalManagerConfig,
  ExecutionMode,
} from './types.js';

/** Events emitted by SignalManager through the EventBus */
export const SignalEvents = {
  PAUSE_REQUESTED: 'signal.pause.requested',
  RESUME_REQUESTED: 'signal.resume.requested',
  SKIP_REQUESTED: 'signal.skip.requested',
  STOP_REQUESTED: 'signal.stop.requested',
  MODE_CHANGE_REQUESTED: 'signal.mode-change.requested',
  SIGNAL_ACKNOWLEDGED: 'signal.acknowledged',
} as const;

export class SignalManager {
  private state: SignalState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private signalsDir: string;
  private pollIntervalMs: number;

  constructor(
    private eventBus: IEventBus,
    private config: SignalManagerConfig,
  ) {
    this.signalsDir = config.signalsDir;
    this.pollIntervalMs = config.pollIntervalMs ?? 500;
    this.state = {
      paused: false,
      stopped: false,
      mode: 'autonomous',
      lastSignal: null,
      lastAck: null,
    };
  }

  /** Initialize the signal manager — create directories and start polling */
  async init(): Promise<void> {
    await fs.mkdir(this.signalsDir, { recursive: true });
    this.startPolling();
  }

  /** Stop polling and clean up */
  async cleanup(): Promise<void> {
    this.stopPolling();
    try {
      await fs.rm(this.signalsDir, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  }

  /** Get current signal state */
  getState(): Readonly<SignalState> {
    return { ...this.state };
  }

  /** Check if workflow is paused */
  get isPaused(): boolean {
    return this.state.paused;
  }

  /** Check if workflow is stopped */
  get isStopped(): boolean {
    return this.state.stopped;
  }

  /** Get current execution mode */
  get currentMode(): ExecutionMode {
    return this.state.mode;
  }

  // ─── Signal Sending (CLI / User side) ──────────────────────────

  /** Send a pause signal */
  async sendPause(reason?: string, targetId?: string): Promise<void> {
    await this.writeSignal({
      type: 'pause',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason,
      targetId,
    });
  }

  /** Send a resume signal */
  async sendResume(reason?: string, targetId?: string): Promise<void> {
    await this.writeSignal({
      type: 'resume',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason,
      targetId,
    });
  }

  /** Send a skip signal */
  async sendSkip(reason?: string, targetId?: string): Promise<void> {
    await this.writeSignal({
      type: 'skip',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason,
      targetId,
    });
  }

  /** Send a stop signal */
  async sendStop(reason?: string): Promise<void> {
    await this.writeSignal({
      type: 'stop',
      timestamp: new Date().toISOString(),
      source: 'user',
      reason,
    });
  }

  /** Send a mode-change signal */
  async sendModeChange(targetMode: ExecutionMode, reason?: string): Promise<void> {
    await this.writeSignal({
      type: 'mode-change',
      timestamp: new Date().toISOString(),
      source: 'user',
      targetMode,
      reason,
    });
  }

  // ─── Signal Acknowledgment (Coordinator side) ──────────────────

  /** Acknowledge a signal (called by coordinator after handling) */
  async acknowledge(
    signalType: SignalType,
    acknowledgedBy: string,
    message?: string,
  ): Promise<void> {
    const ack: SignalAck = {
      signalType,
      acknowledged: true,
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy,
      message,
    };

    this.state.lastAck = ack;

    const ackPath = path.join(this.signalsDir, `${signalType}.ack`);
    await fs.writeFile(ackPath, JSON.stringify(ack, null, 2));

    this.eventBus.emit(SignalEvents.SIGNAL_ACKNOWLEDGED, ack);
  }

  // ─── Private ──────────────────────────────────────────────────

  private async writeSignal(signal: Signal): Promise<void> {
    const signalPath = path.join(this.signalsDir, `${signal.type}.signal`);
    await fs.writeFile(signalPath, JSON.stringify(signal, null, 2));
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollSignals();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollSignals(): Promise<void> {
    try {
      const files = await fs.readdir(this.signalsDir);
      const signalFiles = files.filter(f => f.endsWith('.signal'));

      for (const file of signalFiles) {
        const filePath = path.join(this.signalsDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const signal = JSON.parse(content) as Signal;

          // Process the signal
          this.handleSignal(signal);

          // Remove the signal file (consumed)
          await fs.unlink(filePath);
        } catch {
          // Invalid or partial signal file — skip, don't delete (TOCTOU safety)
          // Will be retried on next poll; partial writes will eventually complete
        }
      }
    } catch {
      // Signals directory may not exist yet — ignore
    }
  }

  private handleSignal(signal: Signal): void {
    this.state.lastSignal = signal;

    switch (signal.type) {
      case 'pause':
        this.state.paused = true;
        this.eventBus.emit(SignalEvents.PAUSE_REQUESTED, signal);
        break;

      case 'resume':
        this.state.paused = false;
        this.eventBus.emit(SignalEvents.RESUME_REQUESTED, signal);
        break;

      case 'skip':
        this.eventBus.emit(SignalEvents.SKIP_REQUESTED, signal);
        break;

      case 'stop':
        this.state.stopped = true;
        this.state.paused = false;
        this.eventBus.emit(SignalEvents.STOP_REQUESTED, signal);
        break;

      case 'mode-change':
        if (signal.targetMode) {
          this.state.mode = signal.targetMode;
        }
        this.eventBus.emit(SignalEvents.MODE_CHANGE_REQUESTED, signal);
        break;
    }
  }
}
