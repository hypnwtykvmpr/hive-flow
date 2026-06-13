import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const sourcePath = join(repoRoot, 'v3/@hive-flow/cli/src/progress/progress-authority-classifier.ts');
const testPath = join(repoRoot, 'v3/@hive-flow/cli/src/progress/__tests__/progress-authority-classifier.test.ts');

const source = readFileSync(sourcePath, 'utf8');
const test = readFileSync(testPath, 'utf8');

const requirements = [
  ['pure-clock', 'nowMs: number', source],
  ['observed-at', 'observedAt: string', source],
  ['git-status-readonly', "spawnSync('git', ['status', '--short', '--branch']", source],
  ['git-head-readonly', "spawnSync('git', ['rev-parse', 'HEAD']", source],
  ['no-write-api', /\b(?:writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|rmdirSync|createWriteStream)\b/, source, true],
  ['no-bd-command', /\b(?:bd|beads)\s+(?:ready|update|close|create|claim|sync|dolt)\b/, source, true],
  ['missing-authority-property', 'never classifies missing authority as progressing', test],
  ['idempotency-property', 'is idempotent for identical snapshots because now is injected', test],
  ['secret-redaction-property', 'redacts secret-like values from classifier output', test],
  ['live-continuation-test', 'treats live execution after a human gate as newer continuation', test],
  ['read-only-guard-test', 'documents and tests the read-only source contract', test],
];

const failures = [];
for (const [name, needle, haystack, inverted] of requirements) {
  const found = needle instanceof RegExp ? needle.test(haystack) : haystack.includes(needle);
  if (Boolean(inverted) ? found : !found) failures.push(name);
}

const result = {
  ok: failures.length === 0,
  fixture: 'progress-authority-classifier',
  invariants: requirements.map(([name]) => name),
  failures,
};

console.log(JSON.stringify(result));
if (failures.length > 0) process.exit(1);
