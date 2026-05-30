// v3/@hive-flow/cli/src/integrations/adapters/claude-code-connector.ts
//
// Wave 11B — Claude Code connector adapter.
//
// Claude Code is the native/statusline exception: it does NOT get a PATH
// wrapper. Session presence is recorded through the Claude Code statusline
// integration (settings.json + statusLine hooks), not through a wrapper
// script. The connector adapter here is a no-op bridge that surfaces a
// clear skipped result when `--features connector --agents claude-code` is
// selected.

import { registerAdapter } from '../adapter-registry.js';
import type {
  ConnectorAdapter,
  AdapterCtx,
  InstallResult,
  UninstallResult,
} from './types.js';

const adapter: ConnectorAdapter = {
  target: 'claude-code',
  tier: 'native-plugin',

  async install(_ctx: AdapterCtx): Promise<InstallResult> {
    return {
      wrote: [],
      skipped: ['claude-code: native statusline bridge — use --features statusline instead'],
    };
  },

  async uninstall(_ctx: AdapterCtx): Promise<UninstallResult> {
    return { removed: [] };
  },
};

registerAdapter('claude-code', () => Promise.resolve(adapter));

export default adapter;
