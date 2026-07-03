// cli/src/integrations/lockfile.ts
import { open } from 'node:fs/promises';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export async function withSetupLock<T>(
  fn: () => Promise<T>,
  opts: { lockPath?: string } = {},
): Promise<{ acquired: true; result: T } | { acquired: false; reason: string }> {
  // Lock path is injectable so tests can use a temp directory. Default: ~/.hive-flow/setup.lock.
  const lockPath = opts.lockPath ?? join(homedir(), '.hive-flow', 'setup.lock');
  await mkdir(dirname(lockPath), { recursive: true });
  let handle: import('node:fs/promises').FileHandle | undefined;
  // Loop up to 2 attempts: first acquire, second after stale-lock reclaim. Bug-fix from Codex
  // pass 2: another process can win the race between unlink and the second open(), so we must
  // catch EEXIST again on the reclaim path and either retry or fail clean.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL: errors if file exists. Race-safe.
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`pid=${process.pid}\nstartedAt=${new Date().toISOString()}\n`);
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if (attempt === 1) {
        // Second EEXIST: someone else won the race after our stale-reclaim. Give up cleanly.
        const stale = await isStaleLock(lockPath);
        return { acquired: false, reason: `setup.lock contention; pid=${stale.heldByPid} held since ${stale.heldSince}.` };
      }
      // First EEXIST: try stale-lock reclaim.
      const stale = await isStaleLock(lockPath);
      if (!stale.isStale) {
        return { acquired: false, reason: `setup.lock held by pid=${stale.heldByPid} since ${stale.heldSince}. If certain that process is gone, run: hive-flow setup unlock --stale` };
      }
      try { await unlink(lockPath); } catch {}
      // Loop will retry the open; if another process raced in, the second attempt's EEXIST exits cleanly.
    }
  }
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    try { await handle?.close(); } catch {}
    try { await unlink(lockPath); } catch {}
  }
}

async function isStaleLock(lockPath: string): Promise<{ isStale: boolean; heldByPid: number; heldSince: string }> {
  const fsp = await import('node:fs/promises');
  const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
  let content = '', stat: any = null;
  try { content = await fsp.readFile(lockPath, 'utf8'); stat = await fsp.stat(lockPath); } catch { return { isStale: true, heldByPid: -1, heldSince: 'unknown' }; }
  const pidMatch = content.match(/pid=(\d+)/);
  const startedMatch = content.match(/startedAt=([\d\-T:.Z]+)/);
  const pid = pidMatch ? Number(pidMatch[1]) : -1;
  const heldSince = startedMatch?.[1] ?? stat.mtime.toISOString();
  const ageMs = Date.now() - new Date(heldSince).getTime();
  // Liveness check: signal 0 throws if process doesn't exist
  let alive = false;
  if (pid > 0) {
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  }
  return { isStale: !alive || ageMs > STALE_THRESHOLD_MS, heldByPid: pid, heldSince };
}
