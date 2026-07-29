import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

async function loadFastCheck() {
  try {
    return (await import('fast-check')).default;
  } catch (err) {
    try {
      return (await import('../cli/node_modules/fast-check/lib/fast-check.js')).default;
    } catch {
      throw err;
    }
  }
}

const fc = await loadFastCheck();

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const helperPath = join(repoRoot, '.claude', 'helpers', 'compact-now.cjs');
const PROPERTY_RUNS = Number(process.env.HIVE_FLOW_PROPERTY_RUNS || process.env.HF_PROPERTY_RUNS || 25);

function writeMeasuredContext(projectRoot, sessionId, percentage = 0.6) {
  const dataDir = join(projectRoot, '.hive-flow', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'autopilot-state.json'), JSON.stringify({
    sessionId,
    lastPercentage: percentage,
    lastTokenEstimate: Math.round(percentage * 1000000),
    contextWindow: 1000000,
    lastCheck: Date.now(),
  }));
}

describe('compact-now helper', () => {
  it('writes a durable recovery note before arming a valid compact request', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const binDir = join(projectRoot, 'bin');
    const fakeTmux = join(binDir, 'tmux');
    const fakeTmuxLog = join(dataDir, 'fake-tmux.log');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    try {
      writeMeasuredContext(projectRoot, 'session-123', 0.6);
      writeFileSync(fakeTmux, [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$HF_FAKE_TMUX_LOG"',
      ].join('\n'));
      chmodSync(fakeTmux, 0o755);

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'human requested compaction',
        '--mode', 'inplace',
        '--resume', 'session-123',
        '--next-step', 'finish the focused tests, then commit',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_SESSION_ID: 'session-123',
          HF_FAKE_TMUX_LOG: fakeTmuxLog,
          PATH: `${binDir}:${process.env.PATH || ''}`,
          TMUX: 'fake-tmux,1,0',
          TMUX_PANE: '%42',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(handoffPath), true);
      assert.equal(existsSync(requestPath), true);

      const handoff = readFileSync(handoffPath, 'utf8');
      const request = JSON.parse(readFileSync(requestPath, 'utf8'));

      assert.match(handoff, /human requested compaction/);
      assert.match(handoff, /finish the focused tests, then commit/);
      assert.match(handoff, /Preserve/);
      assert.equal(request.reason, 'human requested compaction');
      assert.equal(request.mode, 'inplace');
      assert.equal(request.resume, 'session-123');
      assert.equal(request.handoffPath, handoffPath);
      assert.match(request.preservationPrompt, /finish the focused tests, then commit/);
      assert.ok(new Date(request.handoffWrittenAt).getTime() <= new Date(request.requestedAt).getTime());
      const tmuxLog = readFileSync(fakeTmuxLog, 'utf8');
      assert.match(tmuxLog, /send-keys -t %42 -l \/compact /);
      assert.match(tmuxLog, /send-keys -t %42 Enter/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('blocks compact requests when context usage cannot be measured', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-unmeasured-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    mkdirSync(dataDir, { recursive: true });

    try {
      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'unmeasured should fail closed',
        '--mode', 'headless',
        '--resume', 'session-unmeasured',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /unable to measure current context usage/);
      assert.match(result.stderr, /50% compaction request floor cannot be verified/);
      assert.match(result.stderr, /Request human intervention/);
      assert.match(result.stderr, /context measurement layer must be repaired/);
      assert.equal(existsSync(handoffPath), false);
      assert.equal(existsSync(requestPath), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('launches headless compaction through the configured Claude binary after writing the recovery note', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-headless-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    const fakeClaude = join(projectRoot, 'fake-claude.cjs');
    const argsPath = join(dataDir, 'fake-claude-args.json');
    const statePath = join(dataDir, 'autopilot-state.json');
    mkdirSync(dataDir, { recursive: true });

    try {
      writeFileSync(statePath, JSON.stringify({
        sessionId: 'session-headless',
        lastPercentage: 0.5,
        lastTokenEstimate: 500000,
        contextWindow: 1000000,
        lastCheck: Date.now(),
      }));
      writeFileSync(fakeClaude, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));",
        "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 12345, trigger: 'manual' } }) + '\\n');",
      ].join('\n'));
      chmodSync(fakeClaude, 0o755);

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'headless compaction requested',
        '--mode', 'headless',
        '--resume', 'session-headless',
        '--next-step', 'resume from the handoff after compacting',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_BIN: fakeClaude,
          HF_FAKE_CLAUDE_ARGS: argsPath,
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(handoffPath), true);
      assert.equal(existsSync(requestPath), true);
      assert.equal(existsSync(argsPath), true);
      const args = JSON.parse(readFileSync(argsPath, 'utf8'));
      assert.deepEqual(args.slice(0, 4), ['--output-format', 'stream-json', '--verbose', '-p']);
      assert.match(args[4], /^\/compact /);
      assert.match(args[4], /resume from the handoff after compacting/);
      assert.deepEqual(args.slice(5), ['--resume', 'session-headless']);
      const output = JSON.parse(result.stdout);
      assert.equal(output.headless.compacted, true);
      assert.equal(output.headless.compactBoundary.compact_metadata.pre_tokens, 12345);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('blocks compact requests when measured context is below the 50% floor', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-low-context-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    const statePath = join(dataDir, 'autopilot-state.json');
    mkdirSync(dataDir, { recursive: true });

    try {
      writeFileSync(statePath, JSON.stringify({
        sessionId: 'session-low',
        lastPercentage: 0.2,
        lastTokenEstimate: 200000,
        contextWindow: 1000000,
        lastCheck: Date.now(),
      }));

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'too early',
        '--mode', 'headless',
        '--resume', 'session-low',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /20\.0%/);
      assert.match(result.stderr, /below the 50% compaction request floor/);
      assert.match(result.stderr, /Compaction advice starts at 70%/);
      assert.equal(existsSync(handoffPath), false);
      assert.equal(existsSync(requestPath), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('prefers fresh statusline context over stale old-window autopilot pressure', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-statusline-floor-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-compact-now-home-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statuslineDir = join(home, '.hive-flow', 'statusline', 'projects', '0123456789abcdef');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    const statePath = join(dataDir, 'autopilot-state.json');
    const statuslinePath = join(statuslineDir, 'last-render.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });

    try {
      writeFileSync(statePath, JSON.stringify({
        sessionId: 'session-statusline-low',
        lastPercentage: 0.82,
        lastTokenEstimate: 164000,
        contextWindow: 200000,
        lastCheck: Date.now(),
      }));
      writeFileSync(statuslinePath, JSON.stringify({
        version: 1,
        renderedAt: new Date().toISOString(),
        mode: 'inline-collector',
        projectRoot,
        projectKey: '0123456789abcdef',
        rendered: '\u001b[32m\u{1f4d6} 20% ctx\u001b[0m',
      }));

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'stale autopilot should not win',
        '--mode', 'headless',
        '--resume', 'session-statusline-low',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          HOME: home,
          USERPROFILE: home,
          HIVE_FLOW_HOME: '',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /20\.0%/);
      assert.match(result.stderr, /below the 50% compaction request floor/);
      assert.match(result.stderr, /rendered\.context-percent/);
      assert.equal(existsSync(handoffPath), false);
      assert.equal(existsSync(requestPath), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prefers the visible rendered statusline context over cached snapshot context', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-rendered-wins-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-compact-now-home-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statuslineDir = join(home, '.hive-flow', 'statusline', 'projects', '2222333344445555');
    const requestPath = join(dataDir, 'compact-request.json');
    const statuslinePath = join(statuslineDir, 'last-render.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });

    try {
      writeFileSync(statuslinePath, JSON.stringify({
        version: 1,
        renderedAt: new Date().toISOString(),
        mode: 'snapshot',
        projectRoot,
        projectKey: '2222333344445555',
        rendered: '\u001b[32m\u{1f4d6} 20% ctx\u001b[0m',
        snapshot: {
          context: {
            percentage: 82,
            source: 'autopilot-state',
          },
        },
      }));

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'rendered statusline should win over cached snapshot',
        '--mode', 'headless',
        '--resume', 'session-rendered-wins',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          HOME: home,
          USERPROFILE: home,
          HIVE_FLOW_HOME: '',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /20\.0%/);
      assert.match(result.stderr, /rendered\.context-percent/);
      assert.equal(existsSync(requestPath), false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('records fresh statusline context measurement when the floor allows compaction', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-statusline-allow-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-compact-now-home-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statuslineDir = join(home, '.hive-flow', 'statusline', 'projects', 'fedcba9876543210');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    const fakeClaude = join(projectRoot, 'fake-claude.cjs');
    const argsPath = join(dataDir, 'fake-claude-args.json');
    const statuslinePath = join(statuslineDir, 'last-render.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });

    try {
      writeFileSync(statuslinePath, JSON.stringify({
        version: 1,
        renderedAt: new Date().toISOString(),
        mode: 'header-only',
        projectRoot,
        projectKey: 'fedcba9876543210',
        rendered: 'hive-flow | Opus 4.8 | Working | ctx │███████▋     │',
        context: {
          percentage: 64,
          source: 'stdin',
        },
      }));
      writeFileSync(fakeClaude, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));",
        "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 640000, trigger: 'manual' } }) + '\\n');",
      ].join('\n'));
      chmodSync(fakeClaude, 0o755);

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'statusline allows compaction',
        '--mode', 'headless',
        '--resume', 'session-statusline-allow',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_BIN: fakeClaude,
          HF_FAKE_CLAUDE_ARGS: argsPath,
          HOME: home,
          USERPROFILE: home,
          HIVE_FLOW_HOME: '',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(handoffPath), true);
      assert.equal(existsSync(requestPath), true);
      const request = JSON.parse(readFileSync(requestPath, 'utf8'));
      assert.equal(request.contextMeasurement.percent, 64);
      assert.equal(request.contextMeasurement.detail, 'context.percentage');
      assert.equal(request.contextMeasurement.source, statuslinePath);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads statusline records from HIVE_FLOW_HOME using the writer-compatible path', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-hfhome-floor-'));
    const hiveFlowHome = mkdtempSync(join(tmpdir(), 'hf-compact-now-hfhome-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const statuslineDir = join(hiveFlowHome, '.hive-flow', 'statusline', 'projects', '1111222233334444');
    const statuslinePath = join(statuslineDir, 'last-render.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(statuslineDir, { recursive: true });

    try {
      writeFileSync(statuslinePath, JSON.stringify({
        version: 1,
        renderedAt: new Date().toISOString(),
        mode: 'snapshot',
        projectRoot,
        projectKey: '1111222233334444',
        rendered: 'hive-flow | Opus 4.8 | 19% ctx',
      }));

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'hive flow home statusline floor',
        '--mode', 'headless',
        '--resume', 'session-hfhome-low',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          HIVE_FLOW_HOME: hiveFlowHome,
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /19\.0%/);
      assert.match(result.stderr, /rendered\.context-percent/);
      assert.match(result.stderr, new RegExp(statuslinePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(hiveFlowHome, { recursive: true, force: true });
    }
  });

  it('finds the fresh project statusline record after the project cache cap', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-large-cache-'));
    const home = mkdtempSync(join(tmpdir(), 'hf-compact-now-home-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const projectsDir = join(home, '.hive-flow', 'statusline', 'projects');
    const targetDir = join(projectsDir, 'ffffffffffffffff');
    const targetPath = join(targetDir, 'last-render.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });

    try {
      const staleTime = new Date('2020-01-01T00:00:00.000Z');
      for (let index = 0; index < 530; index += 1) {
        const key = index.toString(16).padStart(16, '0');
        const recordDir = join(projectsDir, key);
        const recordPath = join(recordDir, 'last-render.json');
        mkdirSync(recordDir, { recursive: true });
        writeFileSync(recordPath, JSON.stringify({
          version: 1,
          renderedAt: staleTime.toISOString(),
          projectRoot: join(projectRoot, '..', `other-${index}`),
          projectKey: key,
          rendered: 'hive-flow | Opus 4.8 | 88% ctx',
        }));
        utimesSync(recordPath, staleTime, staleTime);
      }

      writeFileSync(targetPath, JSON.stringify({
        version: 1,
        renderedAt: new Date().toISOString(),
        mode: 'inline-collector',
        projectRoot,
        projectKey: 'ffffffffffffffff',
        rendered: 'hive-flow | Opus 4.8 | 18% ctx',
      }));

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'large statusline cache should still find this project',
        '--mode', 'headless',
        '--resume', 'session-large-cache',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          HOME: home,
          USERPROFILE: home,
          HIVE_FLOW_HOME: '',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /18\.0%/);
      assert.match(result.stderr, /rendered\.context-percent/);
      assert.match(result.stderr, new RegExp(targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('property: headless requests preserve sanitized operator intent and invoke /compact exactly once', () => {
    const textChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 _-/"\'$;|&\\\n\t'.split('');
    const text = fc.array(fc.constantFrom(...textChars), { maxLength: 80 }).map(parts => parts.join(''));
    const sessionChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split('');
    const resumeId = fc.array(fc.constantFrom(...sessionChars), { minLength: 1, maxLength: 40 }).map(parts => parts.join(''));
    fc.assert(
      fc.property(text, resumeId, text, (reason, resume, nextStep) => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-property-'));
        const dataDir = join(projectRoot, '.hive-flow', 'data');
        const handoffPath = join(dataDir, 'compaction-handoff.md');
        const requestPath = join(dataDir, 'compact-request.json');
        const fakeClaude = join(projectRoot, 'fake-claude.cjs');
        const argsPath = join(dataDir, 'fake-claude-args.json');
        mkdirSync(dataDir, { recursive: true });

        try {
          writeMeasuredContext(projectRoot, resume, 0.6);
          writeFileSync(fakeClaude, [
            '#!/usr/bin/env node',
            "const fs = require('fs');",
            "fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));",
            "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 555, trigger: 'manual' } }) + '\\n');",
          ].join('\n'));
          chmodSync(fakeClaude, 0o755);

          const result = spawnSync(process.execPath, [
            helperPath,
            '--reason', reason,
            '--mode', 'headless',
            '--resume', resume,
            '--next-step', nextStep,
          ], {
            cwd: projectRoot,
            env: {
              ...process.env,
              CLAUDE_PROJECT_DIR: projectRoot,
              CLAUDE_BIN: fakeClaude,
              HF_FAKE_CLAUDE_ARGS: argsPath,
            },
            encoding: 'utf8',
          });

          assert.equal(result.status, 0, result.stderr || result.stdout);
          const request = JSON.parse(readFileSync(requestPath, 'utf8'));
          const args = JSON.parse(readFileSync(argsPath, 'utf8'));
          assert.equal(existsSync(handoffPath), true);
          assert.equal(request.mode, 'headless');
          assert.equal(request.type, 'hive-flow.compact-request');
          assert.match(request.preservationPrompt, /Preserve the active task state/);
          assert.doesNotMatch(request.preservationPrompt, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
          assert.deepEqual(args, [
            '--output-format',
            'stream-json',
            '--verbose',
            '-p',
            `/compact ${request.preservationPrompt}`,
            '--resume',
            request.resume,
          ]);
          assert.ok(new Date(request.handoffWrittenAt).getTime() <= new Date(request.requestedAt).getTime());
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });

  it('redirects malformed requests to the correct self-compaction command', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-malformed-'));

    try {
      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'bad mode',
        '--mode', 'automatic',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_SESSION_ID: 'session-malformed',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid --mode/);
      assert.match(result.stderr, /Correct current-session self-compaction command:/);
      assert.match(result.stderr, /node \.claude\/helpers\/compact-now\.cjs --mode inplace/);
      assert.match(result.stderr, /compact-now\.cjs --mode headless launches a separate Claude process/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('redirects headless Claude failures when no compact boundary is emitted', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-no-boundary-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const fakeClaude = join(projectRoot, 'fake-claude.cjs');
    const argsPath = join(dataDir, 'fake-claude-args.json');
    mkdirSync(dataDir, { recursive: true });

    try {
      writeMeasuredContext(projectRoot, 'session-no-boundary', 0.6);
      writeFileSync(fakeClaude, [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.HF_FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));",
        "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');",
      ].join('\n'));
      chmodSync(fakeClaude, 0o755);

      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'needs compaction',
        '--mode', 'headless',
        '--resume', 'session-no-boundary',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_BIN: fakeClaude,
          HF_FAKE_CLAUDE_ARGS: argsPath,
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 1);
      assert.match(result.stderr, /compact_boundary/);
      assert.match(result.stderr, /Correct current-session self-compaction command:/);
      assert.match(result.stderr, /Do not git checkout or edit \.claude\/helpers/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
