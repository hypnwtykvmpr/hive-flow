import { spawn, ChildProcess, SpawnOptions } from 'node:child_process';
import { createConnection } from 'node:net';
import { ProcessGroupManager } from './process-group-manager.js';

export interface ManagedProcessOptions {
  /** Name of the service for logging */
  name: string;
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Port to check for external service detection */
  port?: number;
  /** Host to check for external service detection (default: localhost) */
  host?: string;
  /** Working directory for the spawned process */
  cwd?: string;
  /** Environment variables for the spawned process */
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the service to become available after spawning (ms) */
  readyTimeout?: number;
}

/**
 * Abstract service for managing external process dependencies.
 *
 * On {@link ManagedProcessService.start}, checks whether the service is already
 * running on the configured port (externally provided). If not, it spawns and
 * tracks a child process via {@link ProcessGroupManager}, waits for readiness,
 * and registers SIGINT/SIGTERM/exit cleanup handlers.
 *
 * Subclasses only need to supply {@link ManagedProcessOptions} — no additional
 * methods must be implemented unless custom spawn or readiness logic is needed.
 */
export abstract class ManagedProcessService {
  protected managedProcess?: ChildProcess;
  protected readonly options: Required<ManagedProcessOptions>;
  private isCleanupInitialized = false;
  private boundSigintHandler?: () => void;
  private boundSigtermHandler?: () => void;
  private boundExitHandler?: () => void;

  constructor(options: ManagedProcessOptions) {
    this.options = {
      args: [],
      port: 0,
      host: 'localhost',
      cwd: process.cwd(),
      env: { ...process.env },
      readyTimeout: 30000,
      ...options,
    };
  }

  /**
   * Start the service. Detects external instance first.
   */
  async start(): Promise<void> {
    if (this.options.port > 0) {
      const isExternalRunning = await this.isServiceRunning();
      if (isExternalRunning) {
        console.log(`[Lifecycle] External service "${this.options.name}" detected on port ${this.options.port}. Using existing instance.`);
        return;
      }
    }

    await this.spawnManagedProcess();
    this.initializeCleanup();
  }

  /**
   * Check if the service is running (by attempting to connect to the port).
   */
  protected isServiceRunning(): Promise<boolean> {
    if (this.options.port <= 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      const socket = createConnection(this.options.port, this.options.host);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Spawn the managed child process.
   */
  protected async spawnManagedProcess(): Promise<void> {
    console.log(`[Lifecycle] Spawning managed service "${this.options.name}"...`);

    const spawnOptions: SpawnOptions = {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    };

    this.managedProcess = spawn(this.options.command, this.options.args, spawnOptions);

    if (this.managedProcess.pid) {
      ProcessGroupManager.track(this.managedProcess, this.options.name);
    }

    this.managedProcess.on('error', (err) => {
      console.error(`[Lifecycle] Failed to start managed service "${this.options.name}":`, err);
    });

    this.managedProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`[Lifecycle] Managed service "${this.options.name}" exited with code ${code}`);
      }
      this.managedProcess = undefined;
    });

    if (this.options.port > 0) {
      await this.waitForReady();
    }
  }

  /**
   * Wait for the service to become available.
   */
  protected async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < this.options.readyTimeout) {
      if (await this.isServiceRunning()) {
        console.log(`[Lifecycle] Managed service "${this.options.name}" is ready on port ${this.options.port}.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Managed service "${this.options.name}" failed to become ready within ${this.options.readyTimeout}ms`);
  }

  /**
   * Stop the managed process if it exists.
   */
  async stop(): Promise<void> {
    if (this.boundSigintHandler) process.off('SIGINT', this.boundSigintHandler);
    if (this.boundSigtermHandler) process.off('SIGTERM', this.boundSigtermHandler);
    if (this.boundExitHandler) process.off('exit', this.boundExitHandler);
    this.isCleanupInitialized = false;
    this.stopSync();
  }

  /**
   * Synchronous version of stop for use in exit handlers.
   */
  protected stopSync(): void {
    if (this.managedProcess && this.managedProcess.pid) {
      console.log(`[Lifecycle] Stopping managed service "${this.options.name}" (PID: ${this.managedProcess.pid})...`);
      try {
        ProcessGroupManager.kill(this.managedProcess.pid);
      } catch (err) {
        // Ignore errors during cleanup
      }
      this.managedProcess = undefined;
    }
  }

  /**
   * Register signal handlers for cleanup.
   */
  private initializeCleanup(): void {
    if (this.isCleanupInitialized) return;

    const handleSignal = async (signal: string) => {
      console.log(`[Lifecycle] Received ${signal}, shutting down "${this.options.name}"...`);
      await this.stop();
    };

    this.boundSigintHandler = () => void handleSignal('SIGINT');
    this.boundSigtermHandler = () => void handleSignal('SIGTERM');
    // exit handler MUST be synchronous
    this.boundExitHandler = () => { this.stopSync(); };

    process.on('SIGINT', this.boundSigintHandler);
    process.on('SIGTERM', this.boundSigtermHandler);
    process.on('exit', this.boundExitHandler);

    this.isCleanupInitialized = true;
  }
}
