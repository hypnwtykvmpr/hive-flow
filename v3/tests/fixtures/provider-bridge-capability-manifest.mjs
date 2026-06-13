import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const bridge = await import(pathToFileURL(join(root, 'v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs')).href);

const defaultNames = bridge.bridgeToolDefinitionsForProviderMode('default').map((tool) => tool.function.name);
const strictNames = bridge.bridgeToolDefinitionsForProviderMode('strict-api').map((tool) => tool.function.name);
const manifest = bridge.bridgeToolCapabilityManifest();

console.log(JSON.stringify({
  ok: true,
  defaultNames,
  strictNames,
  registryNames: bridge.bridgeToolRegistryNames(),
  manifestNames: Object.keys(manifest).sort(),
  writeFileStrict: manifest.write_file.exposeStrictApi,
  runCommandStrict: manifest.run_command.exposeStrictApi,
}));
