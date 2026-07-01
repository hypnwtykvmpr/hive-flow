import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const fakeRgSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('ripgrep 14.1.0');
  process.exit(0);
}

const dashDash = args.indexOf('--');
const optionArgs = dashDash === -1 ? args : args.slice(0, dashDash);
const positionalArgs = dashDash === -1 ? [] : args.slice(dashDash + 1);
const globs = [];
for (let i = 0; i < optionArgs.length; i += 1) {
  if (optionArgs[i] === '--glob') {
    globs.push(optionArgs[i + 1] || '');
    i += 1;
  }
}

const pattern = positionalArgs[0] || '';
const searchRoot = path.resolve(positionalArgs[1] || '.');
const cwd = process.cwd();

function globToRegExp(glob) {
  const special = new Set(['\\\\', '^', '$', '.', '+', '(', ')', '[', ']', '{', '}', '|']);
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += special.has(char) ? '\\\\' + char : char;
    }
  }
  return new RegExp('^' + source + '$');
}

const negativeGlobs = globs
  .filter((glob) => glob.startsWith('!'))
  .map((glob) => glob.slice(1))
  .map(globToRegExp);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    if (entry.isFile()) files.push(full);
  }
  return files;
}

function normalizedRelative(from, file) {
  return path.relative(from, file).split(path.sep).join('/');
}

const matches = [];
for (const file of walk(searchRoot)) {
  const candidates = [
    normalizedRelative(cwd, file),
    normalizedRelative(searchRoot, file),
  ];
  if (negativeGlobs.some((glob) => candidates.some((candidate) => glob.test(candidate)))) {
    continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(pattern)) {
    matches.push(candidates[0] + ':1:' + text.trim());
  }
}

if (matches.length === 0) process.exit(1);
console.log(matches.join('\\n'));
`;

function makeFixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-bridge-grep-'));
  const fakeBin = join(projectRoot, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  const rgPath = join(fakeBin, 'rg');
  writeFileSync(rgPath, fakeRgSource, 'utf8');
  chmodSync(rgPath, 0o755);

  mkdirSync(join(projectRoot, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  const sentinel = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  writeFileSync(join(projectRoot, '.hive-flow', 'enforcement', '.hmac-key'), sentinel + '\n', 'utf8');
  writeFileSync(join(projectRoot, 'src', 'public.txt'), 'ordinary searchable content\n', 'utf8');
  return { projectRoot, fakeBin, sentinel };
}

function runBridgeGrep(projectRoot, fakeBin, args) {
  const bridgeUrl = pathToFileURL(bridgePath).href;
  const script = `
    const bridge = await import(${JSON.stringify(bridgeUrl)});
    const result = await bridge.executeBridgeFilesystemTool('grep', ${JSON.stringify(args)});
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: fakeBin + delimiter + process.env.PATH,
      CLAUDE_PROJECT_DIR: projectRoot,
    },
    encoding: 'utf8',
  }).trim();
}

describe('provider bridge grep protected-read filtering', () => {
  it('excludes protected read paths from a no-path project-root grep', () => {
    const { projectRoot, fakeBin, sentinel } = makeFixture();

    expect(runBridgeGrep(projectRoot, fakeBin, { pattern: sentinel })).toBe('No matches found');
  });

  it('excludes protected read paths when the explicit search path contains the protected subtree', () => {
    const { projectRoot, fakeBin, sentinel } = makeFixture();

    expect(runBridgeGrep(projectRoot, fakeBin, {
      pattern: sentinel,
      path: '.hive-flow',
    })).toBe('No matches found');
  });
});
