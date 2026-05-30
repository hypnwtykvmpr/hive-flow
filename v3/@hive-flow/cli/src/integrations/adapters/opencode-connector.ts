import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'opencode',
  hostCli: 'opencode',
  hostBin: 'opencode',
});

registerAdapter('opencode', () => Promise.resolve(adapter));

export default adapter;
