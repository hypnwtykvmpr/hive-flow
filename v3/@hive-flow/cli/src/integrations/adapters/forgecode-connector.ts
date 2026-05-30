import { registerAdapter } from '../adapter-registry.js';
import { createWrapperModeAdapter } from './wrapper-mode.js';

const adapter = createWrapperModeAdapter({
  target: 'forgecode',
  hostCli: 'forgecode',
  hostBin: 'forge',
});

registerAdapter('forgecode', () => Promise.resolve(adapter));

export default adapter;
