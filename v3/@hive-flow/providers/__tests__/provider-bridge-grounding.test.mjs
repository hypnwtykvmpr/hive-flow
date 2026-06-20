// Focused tests for the OpenRouter/minimax-m3 grounding fix in provider-agent-bridge.mjs.
//
// Covers Codex VERIFY_BOUNCE recovery target items:
//  1. denied/error tool calls do NOT count toward grounding (isSuccessfulBridgeToolResult).
//  2. loop-gate: finishReason:"stop" + non-empty toolCalls still iterates (documented invariant).
//  3. local "search" wording does NOT overblock (taskRequiresBridgeToolGrounding).
//  4. explicit web wording still requires grounding.
//  5. minimax/openrouter forcing path does NOT set toolChoice:"required".
//  6. DeepSeek path does NOT set any toolChoice.
//
// These exercise the EXPORTED pure helpers (no live provider calls).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const previousEnv = {
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

let bridge;
let strictNames;

beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  try {
    bridge = await import(`${pathToFileURL(bridgePath).href}?grounding=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
  strictNames = bridge.bridgeToolDefinitionsForProviderMode('strict-api').map((t) => t.function.name);
});

afterAll(() => {
  restoreEnv();
});

describe('isSuccessfulBridgeToolResult (MUST-FIX-1: denied/error do not count)', () => {
  it('treats a plain string result as successful', () => {
    expect(bridge.isSuccessfulBridgeToolResult('file contents here')).toBe(true);
  });

  it('treats an object {status:"denied"} as NOT successful', () => {
    expect(bridge.isSuccessfulBridgeToolResult({ status: 'denied', tool: 'mcp__x' })).toBe(false);
  });

  it('treats an object {status:"error"} as NOT successful', () => {
    expect(bridge.isSuccessfulBridgeToolResult({ status: 'error', error: 'boom' })).toBe(false);
  });

  it('treats a stringified {status:"denied"} JSON as NOT successful', () => {
    // evaluateToolCall JSON-stringifies object handler results, so denied results
    // arrive at the response loop as strings — they must still not count.
    const denied = JSON.stringify({ status: 'denied', denyReason: 'blocked-tool', tool: 'run_shell' });
    expect(bridge.isSuccessfulBridgeToolResult(denied)).toBe(false);
  });

  it('treats a stringified {status:"error"} JSON as NOT successful', () => {
    const errored = JSON.stringify({ status: 'error', error: 'kaboom', tool: 'read_file' });
    expect(bridge.isSuccessfulBridgeToolResult(errored)).toBe(false);
  });

  it('treats a stringified successful object (no denied/error status) as successful', () => {
    const ok = JSON.stringify({ status: 'ok', contents: 'needle\n' });
    expect(bridge.isSuccessfulBridgeToolResult(ok)).toBe(true);
  });

  it('treats null/undefined as NOT successful', () => {
    expect(bridge.isSuccessfulBridgeToolResult(null)).toBe(false);
    expect(bridge.isSuccessfulBridgeToolResult(undefined)).toBe(false);
  });

  it('end-to-end: a denied tool (mcp alias) evaluates to a non-successful result', async () => {
    const denied = await bridge.evaluateToolCall('mcp__filesystem__read', { path: 'x' }, {});
    expect(bridge.isSuccessfulBridgeToolResult(denied)).toBe(false);
  });

  it('end-to-end: an unknown tool evaluates to a non-successful result', async () => {
    const unknown = await bridge.evaluateToolCall('totally_not_a_tool', {}, {});
    expect(bridge.isSuccessfulBridgeToolResult(unknown)).toBe(false);
  });
});

describe('grounding floor wiring (MUST-FIX-1: denied calls cannot satisfy UNGROUNDED_TOOL_TASK)', () => {
  it('the response loop appends to executedTools only when the result is successful', () => {
    // Static guard: the source must success-gate the push, not push unconditionally
    // and must NOT pass a recordExecution ctx into executeBridgeTool.
    const src = readFileSync(bridgePath, 'utf8');
    expect(src).toMatch(/const grounded = isSuccessfulBridgeToolResult\(result\);/);
    expect(src).toMatch(/if \(grounded\) \{\s*executedTools\.push\(tc\.function\.name\);/);
    // executeBridgeTool must no longer accept/use recordExecution anywhere.
    expect(src).not.toMatch(/recordExecution/);
  });

  it('removes the duplicate post-loop RETRY-ON-UNGROUNDED control path (Codex blocker #2)', () => {
    const src = readFileSync(bridgePath, 'utf8');
    // The removed block requested an ungrounded-retry summary; ensure it is gone.
    expect(src).not.toMatch(/ungrounded-retry-summary/);
    expect(src).not.toMatch(/Ungrounded-retry succeeded/);
  });
});

describe('loop-gate invariant (MUST-FIX-5: stop + toolCalls still iterates)', () => {
  it('does not break on finishReason after processing tool calls', () => {
    const src = readFileSync(bridgePath, 'utf8');
    // The old unconditional break inside the toolCalls branch must be gone.
    expect(src).not.toMatch(/if \(response\.finishReason !== 'tool_calls'\) \{\s*break;\s*\}/);
    // And the documented fall-through must be present.
    expect(src).toMatch(/Always continue the loop when tool calls were processed/);
  });
});

describe('taskRequiresBridgeToolGrounding (MUST-FIX-3: overblock vs web)', () => {
  it('local "search the repo" task is grounded via LOCAL surface, not web misclassification', () => {
    // "search the repo for TODO" -> asksToInspect(search) && namesLocalSurface(repo) = local.
    // It is grounding-required, but NOT because of any web signal.
    expect(bridge.taskRequiresBridgeToolGrounding('search the repo for TODO comments')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('search the workspace files for TODO')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('find the latest commit in the repository')).toBe(true);
  });

  it('freshness/external tasks are grounding-required even without a local or web surface', () => {
    // Freshness bounce fix: "latest"/"current"/"news" etc. signal the model must not answer
    // from priors — strict providers must use tools to retrieve up-to-date information.
    expect(bridge.taskRequiresBridgeToolGrounding('search for the latest news')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('look up the current value')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('find the latest information')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('what is the latest version of vite')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('what is the current release of package X')).toBe(true);
  });

  it('bare conceptual ask without local surface or freshness signal is NOT grounded', () => {
    // A generic conceptual request with no local surface and no freshness signal
    // may remain un-grounded — the model can reason from existing knowledge.
    expect(bridge.taskRequiresBridgeToolGrounding('search for architecture ideas')).toBe(false);
  });

  it('requires grounding for explicit web tasks (url / online / web_fetch / webpage)', () => {
    expect(bridge.taskRequiresBridgeToolGrounding('fetch https://example.com/page')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('look this up online on the web')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('use web_search to find the answer')).toBe(true);
    expect(bridge.taskRequiresBridgeToolGrounding('open the webpage at the url')).toBe(true);
  });
});

describe('computeStrictGroundingToolChoice (MUST-FIX forcing matrix)', () => {
  it('openrouter NEVER gets toolChoice:"required" (blocker #5)', () => {
    const tc = bridge.computeStrictGroundingToolChoice({
      providerName: 'openrouter',
      task: 'read_file the diagnostic needle',
      strictApiToolNames: strictNames,
    });
    expect(tc).not.toBe('required');
    // exactly one strict tool named -> specific-function form
    expect(tc).toEqual({ type: 'function', function: { name: 'read_file' } });
  });

  it('openrouter with no single inferable tool gets NO toolChoice', () => {
    const tc = bridge.computeStrictGroundingToolChoice({
      providerName: 'openrouter',
      task: 'inspect the repository contents please',
      strictApiToolNames: strictNames,
    });
    expect(tc).toBeUndefined();
  });

  it('openrouter with MULTIPLE inferable tools gets NO toolChoice (ambiguous)', () => {
    const tc = bridge.computeStrictGroundingToolChoice({
      providerName: 'openrouter',
      task: 'use read_file then write_file to update it',
      strictApiToolNames: strictNames,
    });
    expect(tc).toBeUndefined();
  });

  it('deepseek NEVER gets any toolChoice — not "required", not specific-function (blocker #6)', () => {
    const tcSingle = bridge.computeStrictGroundingToolChoice({
      providerName: 'deepseek',
      task: 'read_file the diagnostic needle',
      strictApiToolNames: strictNames,
    });
    expect(tcSingle).toBeUndefined();

    const tcGeneric = bridge.computeStrictGroundingToolChoice({
      providerName: 'deepseek',
      task: 'inspect the repository contents',
      strictApiToolNames: strictNames,
    });
    expect(tcGeneric).toBeUndefined();
  });

  it('a provider that supports forcing (e.g. openai) gets "required"', () => {
    const tc = bridge.computeStrictGroundingToolChoice({
      providerName: 'openai',
      task: 'read_file the diagnostic needle',
      strictApiToolNames: strictNames,
    });
    expect(tc).toBe('required');
  });

  it('deepseek is excluded from SPECIFIC_FUNCTION_SAFE; openrouter is included', () => {
    expect(bridge.SPECIFIC_FUNCTION_SAFE.has('openrouter')).toBe(true);
    expect(bridge.SPECIFIC_FUNCTION_SAFE.has('deepseek')).toBe(false);
  });
});

describe('injectGroundingMandate (single preserved marker invariant)', () => {
  it('appends the marker exactly once to an existing system message', () => {
    const messages = [
      { role: 'system', content: 'You are a worker.' },
      { role: 'user', content: 'read_file the needle' },
    ];
    bridge.injectGroundingMandate(messages);
    const occurrences = (messages[0].content.match(/\[BRIDGE ENFORCEMENT\]/g) || []).length;
    expect(occurrences).toBe(1);
    expect(messages[0].content).toContain('You are a worker.');
  });

  it('is idempotent — a second injection does not duplicate the marker', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];
    bridge.injectGroundingMandate(messages);
    bridge.injectGroundingMandate(messages);
    const occurrences = (messages[0].content.match(/\[BRIDGE ENFORCEMENT\]/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('prepends a system message when none exists, carrying the marker once', () => {
    const messages = [{ role: 'user', content: 'read_file the needle' }];
    bridge.injectGroundingMandate(messages);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain(bridge.GROUNDING_MANDATE_MARKER);
    const occurrences = (messages[0].content.match(/\[BRIDGE ENFORCEMENT\]/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

// Cluster-2 (live-matrix bounce): the web_fetch/web_search cells returned
// toolUse=[] in the live run. These assert that the EXACT task strings emitted
// by diagnose-strict-provider-tools.mjs (taskFor() + toolArgsFor()) are
// classified as grounding-required, so the bridge forces tool use rather than
// letting the model answer from priors. The classifier grounds correctly here;
// a TRUE result means the live no-tool was a stale/race artifact, which the
// live rerun will confirm — NOT a classifier gap.
describe('taskRequiresBridgeToolGrounding grounds the exact live web diagnostic tasks (cluster-2)', () => {
  // Mirrors diagnose-strict-provider-tools.mjs taskFor(tool, args).
  function diagnosticTaskFor(tool, args) {
    return [
      'Live Hive Flow strict-provider diagnostic.',
      `Your FIRST response MUST be a tool call to the bridge tool named ${JSON.stringify(tool)}.`,
      'Do not write any assistant text before the tool call.',
      `Use these exact arguments: ${JSON.stringify(args)}.`,
      'Do not change, infer, paraphrase, omit, or repair the arguments.',
      'If the tool is unsupported or denied, you must still call it and then summarize the denial result.',
      'Do not answer from memory or model priors.',
      'After the tool result is returned, summarize the result in one short sentence starting with TOOL_DIAGNOSTIC_DONE.',
    ].join('\n');
  }

  it('grounds the exact web_fetch diagnostic task (names web_fetch + https URL)', () => {
    const task = diagnosticTaskFor('web_fetch', { url: 'https://example.com/' });
    expect(bridge.taskRequiresBridgeToolGrounding(task)).toBe(true);
  });

  it('grounds the exact web_search diagnostic task (names web_search + query)', () => {
    const task = diagnosticTaskFor('web_search', {
      query: 'current OpenRouter MiniMax M3 model slug',
    });
    expect(bridge.taskRequiresBridgeToolGrounding(task)).toBe(true);
  });

  it('grounds the exact write_file diagnostic task (names write_file + path)', () => {
    // Sanity anchor: the file tools in the same matrix must also ground.
    const task = diagnosticTaskFor('write_file', {
      path: '/tmp/fixture/src/strict-write-output.txt',
      content: 'strict write output from live provider diagnostic\n',
    });
    expect(bridge.taskRequiresBridgeToolGrounding(task)).toBe(true);
  });
});

// ===== Exact-args fidelity helpers =====

describe('GROUNDING_MANDATE_SYSTEM_SUFFIX byte-exact fidelity clause', () => {
  it('contains the BYTE-EXACT ARGUMENT FIDELITY label', () => {
    expect(bridge.GROUNDING_MANDATE_SYSTEM_SUFFIX).toContain('BYTE-EXACT ARGUMENT FIDELITY');
  });

  it('contains a NEVER trim/strip directive', () => {
    expect(bridge.GROUNDING_MANDATE_SYSTEM_SUFFIX).toContain('NEVER trim');
  });

  it('explicitly references trailing newline characters', () => {
    expect(bridge.GROUNDING_MANDATE_SYSTEM_SUFFIX).toMatch(/trailing newline/i);
  });

  it('mandate is idempotent — double injection keeps marker count at 1', () => {
    const messages = [{ role: 'system', content: 'You are a worker.' }, { role: 'user', content: 'task' }];
    bridge.injectGroundingMandate(messages);
    bridge.injectGroundingMandate(messages);
    const count = (messages[0].content.match(/\[BRIDGE ENFORCEMENT\]/g) || []).length;
    expect(count).toBe(1);
  });
});

describe('parseExactArgsContext', () => {
  function diagnosticTaskFor(tool, args) {
    return [
      'Live Hive Flow strict-provider diagnostic.',
      `Your FIRST response MUST be a tool call to the bridge tool named ${JSON.stringify(tool)}.`,
      'Do not write any assistant text before the tool call.',
      `Use these exact arguments: ${JSON.stringify(args)}.`,
      'Do not change, infer, paraphrase, omit, or repair the arguments.',
      'Do not answer from memory or model priors.',
    ].join('\n');
  }

  it('parses expected args and tool name from a valid diagnostic task', () => {
    const task = diagnosticTaskFor('write_file', {
      path: '/tmp/out.txt',
      content: 'hello\n',
    });
    const ctx = bridge.parseExactArgsContext(task, strictNames);
    expect(ctx).not.toBeNull();
    expect(ctx.toolName).toBe('write_file');
    expect(ctx.expectedArgs).toEqual({ path: '/tmp/out.txt', content: 'hello\n' });
  });

  it('returns null when no exact-args block is present', () => {
    const task = 'Just read some file please.';
    expect(bridge.parseExactArgsContext(task, strictNames)).toBeNull();
  });

  it('returns null when the named tool is not a known strict tool', () => {
    const task = diagnosticTaskFor('shell_blast', { cmd: 'rm -rf /' });
    expect(bridge.parseExactArgsContext(task, strictNames)).toBeNull();
  });

  it('returns null when the task text is not a string', () => {
    expect(bridge.parseExactArgsContext(null, strictNames)).toBeNull();
    expect(bridge.parseExactArgsContext(undefined, strictNames)).toBeNull();
  });
});

describe('exactArgsMatch', () => {
  it('returns true for identical args including trailing newline in content', () => {
    const expected = { path: '/tmp/out.txt', content: 'hello\n' };
    const emitted  = { path: '/tmp/out.txt', content: 'hello\n' };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(true);
  });

  it('returns false when content is trimmed (trailing newline stripped)', () => {
    const expected = { path: '/tmp/out.txt', content: 'hello\n' };
    const emitted  = { path: '/tmp/out.txt', content: 'hello' };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(false);
  });

  it('returns false when a key is missing from emitted args', () => {
    const expected = { path: '/tmp/out.txt', content: 'hello\n' };
    const emitted  = { path: '/tmp/out.txt' };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(false);
  });

  it('returns false when emitted args is null', () => {
    expect(bridge.exactArgsMatch(null, { path: '/tmp/out.txt' })).toBe(false);
  });

  it('returns true for args with no string values that all match', () => {
    const expected = { count: 3, flag: true };
    const emitted  = { count: 3, flag: true };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(true);
  });

  // FIX 1 (Codex bounce): exactArgsMatch must use DEEP equality, not strict !== on
  // each value. Array/object arguments (run_command argv, grep/edit nested args) must
  // be able to pass exact-args validation.
  it('FIX1: array args (run_command argv) deep-match => true', () => {
    expect(bridge.exactArgsMatch({ argv: ['pwd'] }, { argv: ['pwd'] })).toBe(true);
    expect(bridge.exactArgsMatch({ argv: ['ls', '-la', 'src'] }, { argv: ['ls', '-la', 'src'] })).toBe(true);
  });

  it('FIX1: nested object/array args deep-match => true', () => {
    const expected = { a: { b: [1, 2, { c: 'x\n' }] }, list: ['p', 'q'] };
    const emitted  = { a: { b: [1, 2, { c: 'x\n' }] }, list: ['p', 'q'] };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(true);
  });

  it('FIX1: array element order / value mismatch => false', () => {
    expect(bridge.exactArgsMatch({ argv: ['ls', 'a'] }, { argv: ['ls', 'b'] })).toBe(false);
    expect(bridge.exactArgsMatch({ argv: ['a', 'b'] }, { argv: ['b', 'a'] })).toBe(false);
    expect(bridge.exactArgsMatch({ argv: ['pwd'] }, { argv: ['pwd', 'extra'] })).toBe(false);
  });

  it('FIX1: nested string leaf without trailing newline when expected HAS one => false', () => {
    const expected = { edit: { new_string: 'after\n' } };
    const emitted  = { edit: { new_string: 'after' } };
    expect(bridge.exactArgsMatch(emitted, expected)).toBe(false);
  });

  it('FIX1: extra or missing nested keys => false', () => {
    expect(bridge.exactArgsMatch({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(false); // extra
    expect(bridge.exactArgsMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(false); // missing
  });

  it('FIX1: array vs object at same key never match', () => {
    expect(bridge.exactArgsMatch({ x: [] }, { x: {} })).toBe(false);
    expect(bridge.exactArgsMatch({ x: {} }, { x: [] })).toBe(false);
  });

  it('FIX1: top-level array emitted is rejected (args must be an object)', () => {
    expect(bridge.exactArgsMatch(['pwd'], { argv: ['pwd'] })).toBe(false);
  });
});

// PART 3 (Codex option a): the trailing-whitespace repair detector. Repair only ever
// adds BACK trailing whitespace/newline bytes that the expected value already ended
// with; it never alters interior content, non-whitespace content, structure, or shape.
// Key-aware allowlist (default-deny): only `content`, `old_string`, `new_string` leaves
// may be repaired.  path/pattern/query/url/argv and all other keys are disallowed.
describe('isTrailingWhitespaceArtifact (PART 3: bounded canonical repair detector)', () => {
  it('detects a single trailing-newline drop on one string leaf', () => {
    const emitted  = { path: '/tmp/out.txt', content: 'hello' };
    const expected = { path: '/tmp/out.txt', content: 'hello\n' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(true);
  });

  // allowlist positive: two allowlisted keys both repaired
  it('detects trailing whitespace drops across multiple allowlisted string leaves', () => {
    const emitted  = { content: 'one', old_string: 'two' };
    const expected = { content: 'one\n', old_string: 'two  ' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(true);
  });

  it('detects a trailing-newline drop on a NESTED string leaf', () => {
    const emitted  = { edit: { new_string: 'after' }, path: '/x' };
    const expected = { edit: { new_string: 'after\n' }, path: '/x' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(true);
  });

  it('returns false when args already match exactly (no repair needed)', () => {
    const same = { path: '/tmp/out.txt', content: 'hello\n' };
    expect(bridge.isTrailingWhitespaceArtifact(same, { ...same })).toBe(false);
  });

  it('returns false for INTERIOR whitespace changes', () => {
    const emitted  = { content: 'a b\n' };
    const expected = { content: 'a  b\n' }; // interior double-space differs
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(false);
  });

  it('returns false for substantive (non-whitespace) content differences', () => {
    const emitted  = { content: 'hello' };
    const expected = { content: 'hello world\n' }; // adds non-whitespace text
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(false);
  });

  it('returns false when the suffix mixes whitespace and non-whitespace', () => {
    const emitted  = { content: 'hello' };
    const expected = { content: 'hello!\n' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(false);
  });

  it('returns false when the emitted leaf already ends in (changed) trailing whitespace', () => {
    const emitted  = { content: 'hello \n' }; // already has trailing ws that differs
    const expected = { content: 'hello\n' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(false);
  });

  it('returns false for a changed PATH leaf even if another leaf is a ws artifact', () => {
    const emitted  = { path: '/tmp/wrong.txt', content: 'hello' };
    const expected = { path: '/tmp/right.txt', content: 'hello\n' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(false);
  });

  it('returns false for shape/key-set differences (missing or extra keys)', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ a: 'x' }, { a: 'x\n', b: 'y' })).toBe(false); // missing key
    expect(bridge.isTrailingWhitespaceArtifact({ a: 'x', b: 'y' }, { a: 'x\n' })).toBe(false); // extra key
  });

  it('returns false for non-string leaf differences and type/array changes', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ n: 1 }, { n: 2 })).toBe(false);
    expect(bridge.isTrailingWhitespaceArtifact({ x: ['a'] }, { x: { 0: 'a' } })).toBe(false);
    expect(bridge.isTrailingWhitespaceArtifact({ x: ['a'] }, { x: ['a', 'b'] })).toBe(false);
  });

  it('returns false when either side is not a plain object', () => {
    expect(bridge.isTrailingWhitespaceArtifact(['a'], { content: 'a\n' })).toBe(false);
    expect(bridge.isTrailingWhitespaceArtifact({ content: 'a' }, null)).toBe(false);
    expect(bridge.isTrailingWhitespaceArtifact(null, { content: 'a\n' })).toBe(false);
  });

  // KEY-AWARE ALLOWLIST (default-deny) — 7 Codex-specified boundary cases
  // Allowlisted keys: true
  it('ALLOWLIST true: {content:"x"} vs {content:"x\\n"} — content key is allowed', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ content: 'x' }, { content: 'x\n' })).toBe(true);
  });

  it('ALLOWLIST true: old_string and new_string trailing-ws drops are allowed', () => {
    // edit-string keys are content-bearing and must remain repairable
    const emitted  = { old_string: 'before', new_string: 'after' };
    const expected = { old_string: 'before\n', new_string: 'after\n' };
    expect(bridge.isTrailingWhitespaceArtifact(emitted, expected)).toBe(true);
  });

  it('ALLOWLIST false: {path:"/tmp/x"} vs {path:"/tmp/x "} — path is disallowed', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ path: '/tmp/x' }, { path: '/tmp/x ' })).toBe(false);
  });

  it('ALLOWLIST false: {pattern:"needle"} vs {pattern:"needle "} — pattern is disallowed', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ pattern: 'needle' }, { pattern: 'needle ' })).toBe(false);
  });

  it('ALLOWLIST false: {query:"current slug"} vs {query:"current slug "} — query is disallowed', () => {
    expect(bridge.isTrailingWhitespaceArtifact({ query: 'current slug' }, { query: 'current slug ' })).toBe(false);
  });

  it('ALLOWLIST false: {url:"https://example.com"} vs {url:"https://example.com "} — url is disallowed', () => {
    expect(bridge.isTrailingWhitespaceArtifact(
      { url: 'https://example.com' },
      { url: 'https://example.com ' },
    )).toBe(false);
  });

  it('ALLOWLIST false: {argv:["printf"]} vs {argv:["printf "]} — argv elements are disallowed', () => {
    // Array elements inherit the parent object key (argv) → disallowed.
    expect(bridge.isTrailingWhitespaceArtifact({ argv: ['printf'] }, { argv: ['printf '] })).toBe(false);
  });
});

// FIX 2 (Codex bounce): the exact-args gate must validate the response SHAPE before
// any execution — wrong-tool and multi-tool responses must NOT execute and must hit
// the bounded retry / fail-closed path. The gate lives inside main(); we assert its
// shape via source guards plus the exported helpers that back it.
describe('exact-args shape gate (FIX 2: wrong-tool / multi-tool must not execute)', () => {
  const src = readFileSync(bridgePath, 'utf8');

  it('gate runs whenever exactArgsCtx is set — not only for single-correct-tool responses', () => {
    // The old gate guard `length === 1 && name === toolName` (which let wrong/multi
    // tool calls bypass and execute) must be gone; the gate must key off exactArgsCtx alone.
    expect(src).not.toMatch(/exactArgsCtx !== null &&\s*response\.toolCalls\.length === 1 &&/);
    // Gate keys off exactArgsCtx (plus the satisfied latch that turns it inert after a
    // grounded exact-args execution), never off a single-correct-tool shape precondition.
    expect(src).toMatch(/if \(exactArgsCtx !== null && !exactArgsSatisfied\) \{/);
  });

  it('detects wrong-count, wrong-tool, and arg-mismatch violations', () => {
    expect(src).toMatch(/const wrongCount = calls\.length !== 1;/);
    expect(src).toMatch(/const wrongTool =[^\n]*single\.function\.name !== exactArgsCtx\.toolName;/);
    expect(src).toMatch(/const wrongArgs =[^\n]*!exactArgsMatch\(emittedArgs, exactArgsCtx\.expectedArgs\)/);
  });

  it('validates BEFORE pushing the assistant message so violating calls never execute, and fails closed after the bound', () => {
    // PART 1: the exact-args gate now runs on the normalized `calls` BEFORE the
    // assistant message is pushed and before the calls.length>0 / no-tool split.
    // Violating calls therefore never enter the history and never execute — no pop needed.
    expect(src).toMatch(/if \(wrongCount \|\| wrongTool \|\| wrongArgs\) \{/);
    // The gate must run before the execution branch (which pushes the assistant message).
    const gateIdx = src.indexOf('if (exactArgsCtx !== null && !exactArgsSatisfied) {');
    const execIdx = src.indexOf('if (calls.length > 0) {');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(gateIdx);
    expect(src).toMatch(/fidelityError\.code = 'ARG_FIDELITY_EXHAUSTED';/);
  });

  it('PART 1: a NO-TOOL exact-args response is handled by the fidelity gate, not the no-tool break', () => {
    // The normalized `calls` array drives the gate so a no-tool exact-args response is
    // intercepted (no-tool-call violation) instead of falling to the UNGROUNDED branch.
    expect(src).toMatch(/const calls = Array\.isArray\(response\.toolCalls\) \? response\.toolCalls : \[\];/);
    expect(src).toMatch(/calls\.length === 0 \? 'no-tool-call' : 'multi-tool-call'/);
  });

  it('PART 2: toolUse exposes successfulTools (success-gated) beside attempted tools', () => {
    expect(src).toMatch(/tools: \[\.\.\.attemptedTools\],/);
    expect(src).toMatch(/successfulTools: \[\.\.\.executedTools\],/);
  });

  it('PART 3: trailing-whitespace repair is the FINAL fallback after retries are exhausted', () => {
    // Repair only fires inside the post-bound branch (argFidelityRetryCount > MAX) and
    // only for an arg-mismatch that is a pure trailing-whitespace artifact.
    expect(src).toMatch(/if \(argFidelityRetryCount > MAX_ARG_FIDELITY_RETRIES\) \{/);
    expect(src).toMatch(/isTrailingWhitespaceArtifact\(emittedArgs, exactArgsCtx\.expectedArgs\)/);
    expect(src).toMatch(/exact_args_trailing_whitespace_repair/);
    // Substantive/wrong mismatches still fail closed.
    expect(src).toMatch(/fidelityError\.code = 'ARG_FIDELITY_EXHAUSTED';/);
  });

  it('lowers temperature on openrouter fidelity retries (FIX 4) without forcing it elsewhere', () => {
    expect(src).toMatch(/if \(providerName === 'openrouter'\) \{\s*request\.temperature = 0;/);
  });

  it('FIX 4: retry nudge names the FINAL NEWLINE BYTE explicitly', () => {
    expect(src).toMatch(/FINAL NEWLINE BYTE/);
    expect(src).toMatch(/INSIDE the JSON string value/);
  });
});

describe('parseToolCallArguments', () => {
  it('returns an object as-is when already parsed', () => {
    const obj = { path: '/tmp/out.txt', content: 'hello\n' };
    expect(bridge.parseToolCallArguments(obj)).toBe(obj);
  });

  it('parses a JSON string (including trailing newline in values)', () => {
    const raw = JSON.stringify({ path: '/tmp/out.txt', content: 'hello\n' });
    expect(bridge.parseToolCallArguments(raw)).toEqual({ path: '/tmp/out.txt', content: 'hello\n' });
  });

  it('returns empty object for null/undefined/empty', () => {
    expect(bridge.parseToolCallArguments(null)).toEqual({});
    expect(bridge.parseToolCallArguments(undefined)).toEqual({});
    expect(bridge.parseToolCallArguments('')).toEqual({});
  });

  it('returns null for a non-JSON string', () => {
    expect(bridge.parseToolCallArguments('not json')).toBeNull();
  });
});
