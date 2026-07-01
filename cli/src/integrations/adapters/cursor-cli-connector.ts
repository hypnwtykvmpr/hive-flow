import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'cursor-cli',
  hostCli: 'cursor-cli',
  hostBin: 'cursor-agent',
});

registerAdapter('cursor-cli', () => Promise.resolve(adapter));

export default adapter;
