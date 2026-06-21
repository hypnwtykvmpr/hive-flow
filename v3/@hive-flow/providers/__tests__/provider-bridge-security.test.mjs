import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(resolve(here, '../scripts/provider-agent-bridge.mjs'), 'utf8');

describe('provider-agent bridge security wiring', () => {
  it('forces MCP filesystem aliases through the bridge policy instead of direct MCP routing', () => {
    for (const toolName of [
      'mcp__filesystem__write_file',
      'mcp__filesystem__edit_file',
      'mcp__filesystem__move_file',
      'mcp__filesystem__rename_file',
      'mcp__filesystem__copy_file',
      'mcp__filesystem__create_directory',
      'mcp__filesystem__delete_file',
      'mcp__filesystem__read_file',
      'mcp__filesystem__read_text_file',
      'mcp__filesystem__read_media_file',
      'mcp__filesystem__read_multiple_files',
      'mcp__filesystem__list_directory',
      'mcp__filesystem__directory_tree',
      'mcp__filesystem__search_files',
    ]) {
      expect(bridgeSource).toContain(`'${toolName}'`);
    }
  });

  it('guards built-in read handlers before file reads or recursive search results are returned', () => {
    expect(bridgeSource).toMatch(/'read_file': \(\{ path: filePath \}\) => \{\n\s+const safePath = validateFilePath\(filePath\);\n\s+assertReadableByBridge\(safePath, 'read_file'\);/);
    expect(bridgeSource).toMatch(/'list_directory': \(\{ path: dirPath \}\) => \{\n\s+const safePath = validateFilePath\(dirPath \|\| '\.'\);\n\s+assertReadableByBridge\(safePath, 'list_directory'\);/);
    expect(bridgeSource).toContain('if (isProtectedReadPath(searchPath))');
    expect(bridgeSource).toContain('if (needsProtectedFilter)');
    expect(bridgeSource).toContain('if (isProtectedReadPath(fullPath))');
  });

  it('fails closed when signed enforcement state cannot be verified', () => {
    expect(bridgeSource).toContain('const FAIL_CLOSED_ENFORCEMENT_LEVEL = 2');
    expect(bridgeSource).toContain('readVerifiedEnforcementLevel');
    expect(bridgeSource).toContain('timingSafeEqual');
    expect(bridgeSource).toContain('envelope.state.level');
    expect(bridgeSource).not.toContain('return 0; }');
  });

  it('scrubs root dev-override material from the bridge process environment', () => {
    expect(bridgeSource).toContain('delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN');
    expect(bridgeSource).toContain('delete process.env.HIVE_FLOW_DEV_OVERRIDE');
  });

  it('routes bridge logs and result JSON through the credential redactor', () => {
    expect(bridgeSource).toContain('function redactBridgeCredentialMaterial');
    expect(bridgeSource).toContain('function safeBridgeJsonStringify');
    expect(bridgeSource).toContain('appendFileSync(getBridgeLogPath(), safeBridgeJsonStringify(entry) +');
    expect(bridgeSource).toContain('const payload = safeBridgeJsonStringify(errorResponse, 2) +');
    expect(bridgeSource).toContain('writeFileSync(tmpResult, payload);');
    expect(bridgeSource).toContain('process.stdout.write(safeBridgeJsonStringify(errorResponse, 2) +');
    expect(bridgeSource).toContain("return typeof result === 'string' ? redactBridgeString(result) : safeBridgeJsonStringify(result)");
    expect(bridgeSource).toContain("const rawContent = typeof tr.result === 'string' ? redactBridgeString(tr.result) : safeBridgeJsonStringify(tr.result)");
    expect(bridgeSource).not.toContain('JSON.stringify(errorResponse, null, 2) +');
    expect(bridgeSource).not.toContain("return typeof result === 'string' ? result : JSON.stringify(result)");
  });

  it('emits task completion notifications from every result-file write path', () => {
    expect(bridgeSource).toContain('function notifyTaskCompletionFromResultFile');
    const resultWriteCount = (bridgeSource.match(/event: 'result_written'/g) || []).length;
    const notificationCallCount = (bridgeSource.match(/notifyTaskCompletionFromResultFile\(/g) || []).length - 1;
    expect(notificationCallCount).toBe(resultWriteCount);
  });

  it('routes run_shell permission guard context through the Codex-first bridge session helper', () => {
    expect(bridgeSource).toContain("session_id: bridgeSessionValue(process.env) || 'provider-bridge-run-shell'");
    expect(bridgeSource).not.toContain("session_id: process.env.CLAUDE_SESSION_ID || 'provider-bridge-run-shell'");
  });
});
