#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.argv[2] || process.cwd();

const gateModule = await import(pathToFileURL(join(
  repoRoot,
  'v3',
  '@hive-flow',
  'cli',
  'dist',
  'src',
  'permission-guard',
  'gate.js',
)).href);
const resolverModule = await import(pathToFileURL(join(
  repoRoot,
  'v3',
  '@hive-flow',
  'cli',
  'dist',
  'src',
  'permission-guard',
  'permission-resolver.js',
)).href);

const { evaluateHookInput, resetConfigCache } = gateModule;
const { resolvePermissionLayerPaths } = resolverModule;

function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'permission-resolver-bats-'));
  const previous = {
    home: process.env.HIVE_FLOW_HOME,
    projectRoot: process.env.HIVE_FLOW_PROJECT_ROOT,
    sessionId: process.env.CLAUDE_SESSION_ID,
  };

  try {
    const hiveHome = join(root, 'home', '.hive-flow');
    const projectRoot = join(root, 'target-project');
    const launcherCwd = join(root, 'launcher');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(launcherCwd, { recursive: true });

    process.env.HIVE_FLOW_HOME = hiveHome;
    process.env.HIVE_FLOW_PROJECT_ROOT = projectRoot;
    process.env.CLAUDE_SESSION_ID = 'permission-resolver-bats-session';

    const sessionInput = {
      tool_name: 'SessionFixtureTool',
      tool_input: {},
      cwd: launcherCwd,
      session_id: process.env.CLAUDE_SESSION_ID,
    };
    const paths = resolvePermissionLayerPaths({
      cwd: launcherCwd,
      sessionInput,
      env: process.env,
    });

    writeJson(paths.globalConfigPath, {
      always_allow_tools: ['GlobalFixtureTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/global-grant'],
      mcp_default_policy: 'deny',
    });
    writeJson(paths.projectConfigPath, {
      always_allow_tools: ['ProjectFixtureTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/project-grant'],
      mcp_default_policy: 'escalate',
    });
    writeJson(paths.sessionGrantsPath, {
      always_allow_tools: ['SessionFixtureTool'],
      allowed_write_paths: ['${PROJECT_ROOT}/session-grant'],
      mcp_default_policy: 'allow',
    });

    resetConfigCache();

    const checks = [];
    checks.push({
      name: 'session tool grant',
      result: await evaluateHookInput(sessionInput),
      expect: 'allow',
    });
    checks.push({
      name: 'global tool grant',
      result: await evaluateHookInput({
        tool_name: 'GlobalFixtureTool',
        tool_input: {},
        cwd: launcherCwd,
        session_id: process.env.CLAUDE_SESSION_ID,
      }),
      expect: 'allow',
    });
    checks.push({
      name: 'project write baseline survives configured grants',
      result: await evaluateHookInput({
        tool_name: 'Write',
        tool_input: {
          file_path: join(projectRoot, 'v3', 'docs', 'design', 'phase3.md'),
          content: '# phase3\n',
        },
        cwd: launcherCwd,
        session_id: process.env.CLAUDE_SESSION_ID,
      }),
      expect: 'allow',
    });
    checks.push({
      name: 'protected control-plane write remains denied',
      result: await evaluateHookInput({
        tool_name: 'Write',
        tool_input: {
          file_path: join(projectRoot, '.claude', 'settings.json'),
          content: '{}',
        },
        cwd: launcherCwd,
        session_id: process.env.CLAUDE_SESSION_ID,
      }),
      expect: 'deny',
    });

    const failures = checks
      .filter(check => check.result.decision !== check.expect)
      .map(check => ({
        name: check.name,
        expected: check.expect,
        actual: check.result.decision,
        reason: check.result.reason || '',
      }));

    const summary = {
      ok: failures.length === 0,
      counts: {
        total: checks.length,
        allow: checks.filter(check => check.result.decision === 'allow').length,
        deny: checks.filter(check => check.result.decision === 'deny').length,
      },
      layerPaths: {
        hiveHome: paths.hiveHome,
        projectRoot: paths.projectRoot,
        sessionGrantsUnderHiveHome: paths.sessionGrantsPath.startsWith(hiveHome),
      },
      failures,
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    if (previous.home === undefined) {
      delete process.env.HIVE_FLOW_HOME;
    } else {
      process.env.HIVE_FLOW_HOME = previous.home;
    }
    if (previous.projectRoot === undefined) {
      delete process.env.HIVE_FLOW_PROJECT_ROOT;
    } else {
      process.env.HIVE_FLOW_PROJECT_ROOT = previous.projectRoot;
    }
    if (previous.sessionId === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = previous.sessionId;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
