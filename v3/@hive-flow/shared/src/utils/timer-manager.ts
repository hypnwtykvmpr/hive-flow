/**
 * Shared TimerManager — tracks setTimeout/setInterval handles for leak-free cleanup.
 * Consolidates the ad-hoc timer tracking patterns used across multiple packages.
 */

export class TimerManager {
  private timers = new Map<string, NodeJS.Timeout>();

  setTimeout(key: string, callback: () => void, ms: number, options?: { unref?: boolean }): void {
    this.clear(key);
    const handle = globalThis.setTimeout(callback, ms);
    if (options?.unref && typeof handle.unref === 'function') {
      handle.unref();
    }
    this.timers.set(key, handle);
  }

  setInterval(key: string, callback: () => void, ms: number, options?: { unref?: boolean }): void {
    this.clear(key);
    const handle = globalThis.setInterval(callback, ms);
    if (options?.unref && typeof handle.unref === 'function') {
      handle.unref();
    }
    this.timers.set(key, handle);
  }

  clear(key: string): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      globalThis.clearTimeout(existing);
      this.timers.delete(key);
    }
  }

  clearAll(): void {
    for (const handle of this.timers.values()) {
      globalThis.clearTimeout(handle);
    }
    this.timers.clear();
  }

  has(key: string): boolean {
    return this.timers.has(key);
  }

  get size(): number {
    return this.timers.size;
  }
}
