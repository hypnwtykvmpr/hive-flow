/**
 * Gas Town Formula Module Exports
 *
 * Provides formula execution with WASM acceleration:
 * - FormulaExecutor: Hybrid WASM/CLI executor
 * - Molecule generation from cooked formulas
 * - Step dependency resolution
 * - Progress tracking and cancellation
 *
 * @module cli/packages/plugin-gastown-bridge/formula
 */

// Main executor
export {
  FormulaExecutor,
  createFormulaExecutor,
  // Types
  type IWasmLoader,
  type ExecuteOptions,
  type StepContext,
  type StepResult,
  type Molecule,
  type ExecutionProgress,
  type ExecutorEvents,
  type ExecutorLogger,
} from './executor.js';

// Default export
export { default } from './executor.js';
