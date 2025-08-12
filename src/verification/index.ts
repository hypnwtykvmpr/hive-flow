/**
 * Verification Module - Index
 * 
 * Main entry point for the verification system.
 * Provides a unified interface for all verification capabilities.
 */

export * from './hooks.js';
export * from './cli-integration.js';

// Re-export key components for convenience
export {
  verificationHookManager,
  VerificationHookManager,
  DEFAULT_PRE_TASK_CHECKERS,
  DEFAULT_POST_TASK_VALIDATORS,
  DEFAULT_TRUTH_VALIDATORS,
  DEFAULT_ROLLBACK_TRIGGERS,
  DEFAULT_VERIFICATION_CONFIG
} from './hooks.js';

export {
  initializeVerificationCLI,
  createVerificationCommand,
  VerificationCLICommands
} from './cli-integration.js';

import { Logger } from '../core/logger.js';
import { verificationHookManager } from './hooks.js';
import { initializeVerificationCLI } from './cli-integration.js';

const logger = new Logger({
  level: 'info',
  format: 'text',
  destination: 'console'
}, { prefix: 'VerificationModule' });

/**
 * Initialize the complete verification system
 */
export async function initializeVerificationSystem(): Promise<void> {
  logger.info('Initializing verification system...');
  
  try {
    // Initialize CLI integration
    await initializeVerificationCLI();
    
    // Start cleanup interval (every hour)
    setInterval(() => {
      verificationHookManager.cleanup();
    }, 60 * 60 * 1000);
    
    logger.info('Verification system initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize verification system:', error);
    throw error;
  }
}

/**
 * Get verification system status
 */
export function getVerificationSystemStatus(): {
  initialized: boolean;
  hooksRegistered: number;
  activeContexts: number;
  metrics: any;
} {
  const metrics = verificationHookManager.getMetrics();
  
  return {
    initialized: true,
    hooksRegistered: 5, // Pre-task, post-task, integration, truth, rollback
    activeContexts: metrics.activeContexts || 0,
    metrics
  };
}

/**
 * Shutdown verification system gracefully
 */
export async function shutdownVerificationSystem(): Promise<void> {
  logger.info('Shutting down verification system...');
  
  try {
    // Cleanup all contexts and snapshots
    verificationHookManager.cleanup(0); // Cleanup all data
    
    logger.info('Verification system shut down successfully');
  } catch (error) {
    logger.error('Error during verification system shutdown:', error);
    throw error;
  }
}