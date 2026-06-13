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
  editFileStrict: manifest.edit_file.exposeStrictApi,
  writeFileStrictGuarded: manifest.write_file.requiresProtectedWriteGate && manifest.write_file.requiresEnforcementWriteGate,
  editFileStrictGuarded: manifest.edit_file.requiresProtectedWriteGate && manifest.edit_file.requiresEnforcementWriteGate,
  runCommandStrict: manifest.run_command.exposeStrictApi,
  webFetchStrict: manifest.web_fetch.exposeStrictApi,
  webFetchGuarded: manifest.web_fetch.requiresAllowlist &&
    manifest.web_fetch.requiresSsrfGuard &&
    manifest.web_fetch.requiresEnforcementFetchGate,
  webSearchStrictDenied: manifest.web_search.exposeStrictApi && manifest.web_search.alwaysDenied,
}));
