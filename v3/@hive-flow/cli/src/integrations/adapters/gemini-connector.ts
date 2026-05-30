import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'gemini',
  hostCli: 'gemini',
  hostBin: 'gemini',
});

registerAdapter('gemini', () => Promise.resolve(adapter));

export default adapter;
