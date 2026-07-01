import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'codex',
  hostCli: 'codex',
  hostBin: 'codex',
});

registerAdapter('codex', () => Promise.resolve(adapter));

export default adapter;
