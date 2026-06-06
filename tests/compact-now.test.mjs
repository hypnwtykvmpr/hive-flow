import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import fc from 'fast-check';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const helperPath = join(repoRoot, '.claude', 'helpers', 'compact-now.cjs');
const PROPERTY_RUNS = Number(process.env.HIVE_FLOW_PROPERTY_RUNS || process.env.HF_PROPERTY_RUNS || 25);

describe('compact-now helper', () => {
  it('writes a durable recovery note before arming a valid compact request', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    mkdirSync(dataDir, { recursive: true });

    try {
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
    mkdirSync(dataDir, { recursive: true });

    try {
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
      assert.match(result.stderr, /Correct self-compaction command:/);
      assert.match(result.stderr, /node \.claude\/helpers\/compact-now\.cjs --mode headless/);
      assert.match(result.stderr, /--resume "\$CLAUDE_SESSION_ID"/);
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
      assert.match(result.stderr, /Correct self-compaction command:/);
      assert.match(result.stderr, /Do not git checkout or edit \.claude\/helpers/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
