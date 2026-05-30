import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'qwen',
  hostCli: 'qwen',
  hostBin: 'qwen',
});

registerAdapter('qwen', () => Promise.resolve(adapter));

export default adapter;
