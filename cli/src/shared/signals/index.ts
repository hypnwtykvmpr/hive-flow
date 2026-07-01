/**
 * Signals Module
 * User-initiated workflow control signals with file-based IPC.
 * Ported from CodeMachine-CLI's workflow signals system.
 */

export { SignalManager, SignalEvents } from './manager.js';
export type {
  Signal,
  SignalAck,
  SignalState,
  SignalType,
  ExecutionMode,
  SignalManagerConfig,
} from './types.js';
