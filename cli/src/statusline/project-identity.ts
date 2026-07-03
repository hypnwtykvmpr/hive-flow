// cli/src/statusline/project-identity.ts
import { readFile, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProjectIdentityInput {
  stdinData?: any;
  env?: NodeJS.ProcessEnv;
  cwd: string;
  /** Optional pre-resolved stdin root (overrides stdinData extraction). */
  stdinRoot?: string;
  /** Optional pre-resolved env root (overrides env.CLAUDE_PROJECT_DIR). */
  envRoot?: string;
}

export interface ProjectIdentity {
  value: {
    displayName: string;
    source: 'stdin' | 'env' | 'config' | 'package-json' | 'git-remote' | 'cwd';
  };
  freshness: 'live' | 'stale' | 'absent';
  confidence: 'direct' | 'inferred';
}

export async function resolveProjectIdentity(input: ProjectIdentityInput): Promise<ProjectIdentity> {
  const env = input.env ?? process.env;

  // Priority 1: stdin workspace root (the agent knows)
  const stdinRoot =
    input.stdinRoot ??
    getString(input.stdinData, ['workspace', 'current_dir']) ??
    getString(input.stdinData, ['workspace', 'project_dir']) ??
    getString(input.stdinData, ['workspace', 'root']) ??
    getString(input.stdinData, ['cwd']);

  // Priority 2: CLAUDE_PROJECT_DIR or HIVE_FLOW_PROJECT_NAME env override
  const envOverride = env['HIVE_FLOW_PROJECT_NAME'];
  const envRoot = input.envRoot ?? env['CLAUDE_PROJECT_DIR'];

  // Bug-fix: bound is derived from `root` (stdinRoot ?? envRoot ?? gitRoot(cwd) ?? cwd),
  // NOT from input.cwd, so that stdin-supplied roots outside cwd's git tree don't walk to /
  const root = resolve(stdinRoot ?? envRoot ?? (await gitRoot(input.cwd)) ?? input.cwd);

  // Short-circuit: when the agent supplies the workspace root via stdin, return source:'stdin'
  // immediately so callers can distinguish a live agent-provided path from a fallback.
  if (stdinRoot && !input.stdinRoot) {
    return {
      value: { displayName: normalize(basename(stdinRoot)), source: 'stdin' },
      freshness: 'live',
      confidence: 'direct',
    };
  }

  if (envOverride) {
    return {
      value: { displayName: normalize(envOverride), source: 'env' },
      freshness: 'live',
      confidence: 'direct',
    };
  }

  // Hive Flow config override
  const hf = await readJsonSafe(join(root, '.hive-flow', 'config.json'));
  if (hf?.projectName) {
    return {
      value: { displayName: normalize(hf.projectName), source: 'config' },
      freshness: 'live',
      confidence: 'direct',
    };
  }

  // package.json — bounded walk: stop at git root of the resolved root (NOT input.cwd).
  // Bug-fix from Codex pass 2: previously bounded by gitRoot(input.cwd), so when the resolved
  // root came from stdin and lived outside cwd's git ancestry, the bound was not an ancestor
  // of start and findPackageJsonBounded would walk to filesystem root. Now bound by gitRoot(root).
  const gitTop = (await gitRoot(root)) ?? root;
  const pkg = await findPackageJsonBounded(root, gitTop);
  if (pkg) {
    const candidate =
      pkg.hiveFlow?.displayName ??
      pkg.displayName ??
      (pkg.name ? stripScope(pkg.name) : undefined);
    if (candidate) {
      return {
        value: { displayName: normalize(candidate), source: 'package-json' },
        freshness: 'live',
        confidence: 'direct',
      };
    }
  }

  // git remote slug as a weaker fallback
  const remote = safeExec('git', ['config', '--get', 'remote.origin.url'], { cwd: root });
  if (remote) {
    const slug = parseRemoteSlug(remote);
    if (slug) {
      return {
        value: { displayName: normalize(slug), source: 'git-remote' },
        freshness: 'live',
        confidence: 'inferred',
      };
    }
  }

  // Final fallback: cwd basename
  return {
    value: { displayName: normalize(basename(root)), source: 'cwd' },
    freshness: 'live',
    confidence: 'inferred',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getString(obj: unknown, path: string[]): string | undefined {
  let cur: any = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return typeof cur === 'string' && cur.trim() ? cur.trim() : undefined;
}

/** Collapse whitespace/underscore/hyphen runs to a single space.
 *  MUST use /[\s_-]+/ — NOT /[ -]+/ which is the ASCII range bug (matches chars 32-45). */
export function normalize(s: string): string {
  return s.replace(/[\s_-]+/g, ' ').trim().slice(0, 64);
}

function stripScope(n: string): string {
  return n.replace(/^@[^/]+\//, '');
}

function parseRemoteSlug(remote: string): string | undefined {
  // Cap input length to prevent ReDoS
  const r = remote.slice(0, 256);
  const m = r.match(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1].split('/').pop() : undefined;
}

/** Runs `git rev-parse --show-toplevel` in `p`; returns trimmed string or undefined. */
export async function gitRoot(p: string): Promise<string | undefined> {
  const out = safeExec('git', ['rev-parse', '--show-toplevel'], { cwd: p });
  return out || undefined;
}

/** Walks upward from `start` looking for package.json, stopping at `stopAt`.
 *  Guard: if `stopAt` is NOT an ancestor of `start`, use `start` as the bound to
 *  prevent climbing to filesystem root when the two paths are in different trees. */
export async function findPackageJsonBounded(
  start: string,
  stopAt: string,
): Promise<any | undefined> {
  let cur = resolve(start);
  const stop = resolve(stopAt);

  // Guard: stop the walk if the next parent would leave stopAt
  const isAncestor = (cur + '/').startsWith(stop + '/') || cur === stop;
  const bound = isAncestor ? stop : cur;

  while (true) {
    const p = join(cur, 'package.json');
    try {
      await access(p);
      return JSON.parse(await readFile(p, 'utf8'));
    } catch {
      // not found or unreadable — continue walking
    }
    if (cur === bound || cur === dirname(cur)) return undefined;
    cur = dirname(cur);
  }
}

async function readJsonSafe(p: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function safeExec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() },
): string | undefined {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 2000,
  });
  if (r.status === 0) return r.stdout.trim() || undefined;
  // Timeout / non-zero / missing binary → undefined. Caller falls through.
  return undefined;
}
