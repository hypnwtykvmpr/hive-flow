import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
};
`,
    context,
    { filename: watcherPath },
  );

  return module.exports as {
    getPaths: (projectDir: string) => Record<string, string | ((hiveId: string) => string) | undefined> & {
      dataDir: string;
    };
  };
}

function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'hive-flow-pane-registry-'));
}

describe('legacy tmux pane registry is not used by the watcher', () => {
  it('omits tmux pane paths and execution helpers from the watcher runtime module', () => {
    const project = makeProject();
    try {
      const watcher = loadWatcherModule();
      const paths = watcher.getPaths(project);

      expect(paths.tmuxPaneFile).toBeUndefined();
      expect(paths.tmuxPaneDir).toBeUndefined();
      expect('resolveTmuxPane' in watcher).toBe(false);
      expect('tmuxSendKeys' in watcher).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('committed SessionStart hooks do not capture or persist tmux panes', () => {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const commands = (settings.hooks?.SessionStart || [])
      .flatMap(group => group.hooks || [])
      .map(hook => hook.command || '');

    expect(commands.some(command => command.includes('tmux-pane.txt'))).toBe(false);
    expect(commands.some(command => command.includes('display-message'))).toBe(false);
    expect(commands.some(command => command.includes('TMUX_PANE'))).toBe(false);
  });
});
