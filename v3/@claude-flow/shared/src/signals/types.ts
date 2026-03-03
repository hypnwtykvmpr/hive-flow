/**
 * Signal Types
 * Core interfaces for the Claude Flow signal management system.
 * Adapted from CodeMachine-CLI's workflow signals with file-based IPC.
 */

/** Supported signal types */
export type SignalType = 'pause' | 'resume' | 'skip' | 'stop' | 'mode-change';

/** Execution mode */
export type ExecutionMode = 'autonomous' | 'interactive';

/** A signal written to the signals directory */
export interface Signal {
  type: SignalType;
  timestamp: string;
  source: 'user' | 'agent' | 'system';
  /** For mode-change signals */
  targetMode?: ExecutionMode;
  /** Optional reason/message */
  reason?: string;
  /** Agent or swarm this signal targets (empty = all) */
  targetId?: string;
}

/** Acknowledgment of a signal by the coordinator */
export interface SignalAck {
  signalType: SignalType;
  acknowledged: boolean;
  acknowledgedAt: string;
  acknowledgedBy: string;
  message?: string;
}

/** Current state of the signal system */
export interface SignalState {
  paused: boolean;
  stopped: boolean;
  mode: ExecutionMode;
  lastSignal: Signal | null;
  lastAck: SignalAck | null;
}

/** Configuration for the SignalManager */
export interface SignalManagerConfig {
  /** Directory for signal files (default: ~/.claude/signals/{swarmId}/) */
  signalsDir: string;
  /** Poll interval in ms for checking signal files (default: 500) */
  pollIntervalMs?: number;
  /** Swarm or session ID */
  swarmId: string;
}
