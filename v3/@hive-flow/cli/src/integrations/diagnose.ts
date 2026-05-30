// v3/@hive-flow/cli/src/integrations/diagnose.ts
//
// Connector diagnose engine.
//
// Inspects the per-target integration markers written by the connector
// installers and reports the health of each installed adapter. Surfaces the
// data backing `hive-flow integrations doctor` and `setup --diagnose
// connector`.
//
// Phase 5 binding: non-Claude CLIs are wrapper-mode only. Native-plugin tier
// remains a spike-gated future. For wrapper-mode markers we verify the
// generated wrapper script and the real host CLI binary still exist on disk.
// For native-plugin markers we only record install presence — deeper
// inspection of upstream CLI configs is intentionally out of scope until the
// native promotion runbook lands (Phase 18).
//
// Security notes:
// - `readMarker` (parallel module) is the trusted boundary for marker reads.
//   It is responsible for refusing to follow symlinked marker paths
//   (Wave 2.5A / 8.4 guards). This module relies on that contract and never
//   reads markers directly.
// - All disk existence probes here use `lstat`, not `stat`, so a symlinked
//   `scriptPath` or `realCliBin` is not silently followed to a different
//   target. If the marker points at a symlink, the diagnose report records
//   the symlink's own presence rather than chasing its destination.
// - The `issues` strings are deliberately path-free ("wrapper script missing"
//   rather than the resolved path) so the report can be logged or piped
//   without leaking the user's home-directory layout. Callers that need the
//   exact path render it from `entry.scriptPath` / `entry.realCliBin`, both
//   of which originate in the marker (i.e. content Hive Flow itself wrote).

import { lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { platform } from 'node:os';

import type {
  AdapterTarget,
  IntegrationMarker,
} from './integration-marker.js';
import {
  ADAPTER_TARGETS,
  readMarker,
} from './integration-marker.js';

const HOST_BINS: Record<AdapterTarget, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  forgecode: 'forge',
  'cursor-cli': 'cursor-agent',
  qwen: 'qwen',
  opencode: 'opencode',
};

function firstOnPath(bin: string): string | undefined {
  try {
    const cmd = platform() === 'win32' ? 'where' : 'which';
    return execFileSync(cmd, [bin], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

/** Per-target diagnosis row. Immutable view of one adapter's state on disk. */
export interface DiagnoseEntry {
  readonly target: AdapterTarget;
  readonly installed: boolean;
  readonly scope?: 'project' | 'user';
  readonly tier?: 'wrapper-mode' | 'native-plugin';
  readonly scriptPath?: string;
  /** Only populated for wrapper-mode markers that recorded a scriptPath. */
  readonly scriptExists?: boolean;
  readonly realCliBin?: string;
  /** Only populated for wrapper-mode markers that recorded a realCliBin. */
  readonly realCliExists?: boolean;
  /** Human-readable problems detected while inspecting this target. */
  readonly issues: ReadonlyArray<string>;
}

/** Aggregate result for the full connector lineup. */
export interface DiagnoseReport {
  readonly entries: ReadonlyArray<DiagnoseEntry>;
  readonly summary: {
    readonly installed: number;
    readonly healthy: number;
    readonly withIssues: number;
  };
}

/**
 * lstat-based path existence probe. Returns true when the path resolves to
 * something on disk (file, directory, or symlink). Returns false on ENOENT or
 * any other I/O error — diagnose is a best-effort health snapshot and one
 * unreadable entry must not abort the report for the other six adapters.
 *
 * NOTE: we deliberately use `lstat` instead of `stat` so that a symlinked
 * scriptPath or realCliBin is not followed transparently — the marker stores
 * the path Hive Flow wrote, and we check only that path.
 */
async function lstatExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    // ENOENT → not installed. EACCES / EIO / ELOOP → unreachable from our
    // process, which from the user's perspective is just as broken as
    // missing. Either way we report not-present and let the issue list
    // surface the problem to the operator.
    return false;
  }
}

/**
 * Diagnose a single target.
 *
 * Resolution order:
 *   1. Try the project-scope marker. If present, return that.
 *   2. Else try the user-scope marker. If present, return that.
 *   3. Else the target is not installed.
 *
 * Project scope wins ties because per-project Hive Flow installs override
 * the user-global install when both are present.
 */
async function diagnoseTarget(
  projectRoot: string,
  target: AdapterTarget,
): Promise<DiagnoseEntry> {
  let marker: IntegrationMarker | undefined;
  let scope: 'project' | 'user' | undefined;

  // Project first — explicit per-project install beats user-global.
  marker = await readMarker({ projectRoot, target, scope: 'project' });
  if (marker !== undefined) {
    scope = 'project';
  } else {
    marker = await readMarker({ projectRoot, target, scope: 'user' });
    if (marker !== undefined) {
      scope = 'user';
    }
  }

  if (marker === undefined || scope === undefined) {
    return {
      target,
      installed: false,
      issues: [],
    };
  }

  const issues: string[] = [];

  // Wrapper-mode is the only tier with deeper checks in this wave.
  // Native-plugin deeper inspection is a future-work item (see file header).
  if (marker.tier === 'wrapper-mode') {
    let scriptExists: boolean | undefined;
    let realCliExists: boolean | undefined;

    if (marker.scriptPath !== undefined) {
      scriptExists = await lstatExists(marker.scriptPath);
      if (!scriptExists) {
        issues.push('wrapper script missing');
      }
    } else {
      // A wrapper-mode marker without a scriptPath is malformed by definition,
      // but we surface it rather than throw — the user needs to see it.
      issues.push('wrapper script missing');
    }

    if (marker.realCliBin !== undefined) {
      realCliExists = await lstatExists(marker.realCliBin);
      if (!realCliExists) {
        issues.push('real CLI binary missing');
      }
    }

    if (scriptExists && marker.scriptPath && marker.scriptPath.includes('.hive-flow/bin/')) {
      const hostBin = HOST_BINS[target];
      const first = firstOnPath(hostBin);
      if (first === undefined) {
        issues.push('wrapper installed but host command not resolvable on PATH — add wrapper directory to PATH');
      } else if (resolve(first) !== resolve(marker.scriptPath)) {
        issues.push('wrapper installed but not first on PATH — add wrapper directory to PATH');
      }
    }

    return {
      target,
      installed: true,
      scope,
      tier: marker.tier,
      scriptPath: marker.scriptPath,
      scriptExists,
      realCliBin: marker.realCliBin,
      realCliExists,
      issues,
    };
  }

  // native-plugin: install presence only in this wave.
  return {
    target,
    installed: true,
    scope,
    tier: marker.tier,
    issues,
  };
}

/**
 * Full diagnose pass across every known adapter target.
 *
 * Concurrency: targets are independent — we fan out with Promise.all so a
 * stalled I/O on one adapter does not serialize the others. Each
 * `diagnoseTarget` is responsible for swallowing its own filesystem errors.
 */
export async function diagnoseConnectors(opts: {
  projectRoot: string;
}): Promise<DiagnoseReport> {
  const entries = await Promise.all(
    ADAPTER_TARGETS.map((target) => diagnoseTarget(opts.projectRoot, target)),
  );

  let installed = 0;
  let healthy = 0;
  let withIssues = 0;
  for (const entry of entries) {
    if (entry.installed) {
      installed += 1;
      if (entry.issues.length === 0) {
        healthy += 1;
      } else {
        withIssues += 1;
      }
    }
  }

  return {
    entries,
    summary: {
      installed,
      healthy,
      withIssues,
    },
  };
}
