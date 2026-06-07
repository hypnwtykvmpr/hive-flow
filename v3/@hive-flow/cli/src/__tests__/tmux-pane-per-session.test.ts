import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../../');
const watcherPath = resolve(root, 'scripts', 'hive-watcher.cjs');
const settingsPath = resolve(root, '.claude', 'settings.json');

function loadWatcherModule() {
  const source = readFileSync(watcherPath, 'utf8').replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
  const module = { exports: {} as Record<string, unknown> };
  const context = {
    require: createRequire(pathToFileURL(watcherPath)),
    module,
    exports: module.exports,
    __filename: watcherPath,
    __dirname: dirname(watcherPath),
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  };

  vm.runInNewContext(
    `${source}
module.exports = {
  getPaths,
  resolveTmuxPane,
  tmuxSendKeys,
};
`,
    context,
    { filename: watcherPath },
  );

  return module.exports as {
    getPaths: (projectDir: string) => {
      dataDir: string;
      tmuxPaneFile: string;
      tmuxPaneDir?: string;
    };
    resolveTmuxPane: (
      explicitPane: string | null,
      paths: { tmuxPaneFile: string; tmuxPaneDir?: string },
      sessionId?: string | null,
    ) => string | null;
    tmuxSendKeys: (tmuxBin: string, pane: string, message: string) => boolean;
  };
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'hive-flow-pane-registry-'));
}

describe('R1 per-session tmux pane registry', () => {
  it('resolves owner session pane before the legacy last-writer pane', () => {
    const project = makeProject();
    try {
      const watcher = loadWatcherModule();
      const paths = watcher.getPaths(project);
      mkdirSync(join(paths.dataDir, 'panes'), { recursive: true });
      writeFileSync(join(paths.dataDir, 'panes', 'sidA.txt'), '%1', 'utf8');
      writeFileSync(join(paths.dataDir, 'panes', 'sidB.txt'), '%2', 'utf8');
      writeFileSync(paths.tmuxPaneFile, '%2', 'utf8');

      expect(watcher.resolveTmuxPane(null, paths, 'sidA')).toBe('%1');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('sends wake messages to the owner session pane rather than the last writer', () => {
    const project = makeProject();
    try {
      const watcher = loadWatcherModule();
      const paths = watcher.getPaths(project);
      mkdirSync(join(paths.dataDir, 'panes'), { recursive: true });
      writeFileSync(join(paths.dataDir, 'panes', 'sidA.txt'), '%1', 'utf8');
      writeFileSync(join(paths.dataDir, 'panes', 'sidB.txt'), '%2', 'utf8');
      writeFileSync(paths.tmuxPaneFile, '%2', 'utf8');

      const fakeTmux = join(project, 'fake-tmux.sh');
      const argsPath = join(project, 'tmux-args.txt');
      writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsPath}"\n`, 'utf8');
      chmodSync(fakeTmux, 0o755);

      const pane = watcher.resolveTmuxPane(null, paths, 'sidA');
      expect(pane).toBe('%1');
      expect(watcher.tmuxSendKeys(fakeTmux, pane!, '[HIVE COMPLETE: hive-owned] done')).toBe(true);
      expect(readFileSync(argsPath, 'utf8')).toContain('-t\n%1\n');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps explicit snapshot and legacy fallback priority', () => {
    const project = makeProject();
    try {
      const watcher = loadWatcherModule();
      const paths = watcher.getPaths(project);
      mkdirSync(join(paths.dataDir, 'panes'), { recursive: true });
      writeFileSync(join(paths.dataDir, 'panes', 'sidA.txt'), '%1', 'utf8');
      writeFileSync(paths.tmuxPaneFile, '%legacy', 'utf8');

      expect(watcher.resolveTmuxPane('%snapshot', paths, 'sidA')).toBe('%snapshot');
      expect(watcher.resolveTmuxPane(null, paths, null)).toBe('%legacy');
      expect(watcher.resolveTmuxPane(null, paths, 'missing-session')).toBe('%legacy');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('committed SessionStart pane capture writes both per-session and legacy pane files', () => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const commands = (settings.hooks?.SessionStart || [])
      .flatMap(group => group.hooks || [])
      .map(hook => hook.command || '');
    const paneCommand = commands.find(command => command.includes('tmux-pane.txt'));

    expect(paneCommand).toContain('/panes/');
    expect(paneCommand).toContain('CLAUDE_SESSION_ID');
    expect(paneCommand).toContain('tmux-pane.txt');
  });
});
