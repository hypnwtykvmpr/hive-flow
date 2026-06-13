import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const bridgeSource = readFileSync(join(root, 'v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs'), 'utf8');
const configSource = readFileSync(join(root, 'v3/@hive-flow/providers/src/openrouter-model-config.ts'), 'utf8');
const resolverSource = readFileSync(join(root, 'v3/@hive-flow/providers/src/model-alias-resolver.ts'), 'utf8');
const providerSource = readFileSync(join(root, 'v3/@hive-flow/providers/src/openrouter-provider.ts'), 'utf8');

const miniMaxM3 = 'minimax/minimax-m3';
const qwenPlus = 'qwen/qwen3.7-plus';
const qwenMax = 'qwen/qwen3.7-max';
const grok43 = 'x-ai/grok-4.3';
const xiaomiMimo = 'xiaomi/mimo-v2.5-pro';

function assertIncludes(label, source, needle) {
  if (!source.includes(needle)) throw new Error(`${label} missing ${needle}`);
}

function assertNotIncludes(label, source, needle) {
  if (source.includes(needle)) throw new Error(`${label} still contains ${needle}`);
}

assertIncludes('bridge fallback default', bridgeSource, `'openrouter': '${miniMaxM3}'`);
assertIncludes('resolver provider default', resolverSource, `'openrouter': '${miniMaxM3}'`);
assertIncludes('openrouter config opus default', configSource, `opus: ['${miniMaxM3}'`);
assertIncludes('openrouter config grok', configSource, `'${grok43}'`);
assertIncludes('openrouter config qwen plus', configSource, `'${qwenPlus}'`);
assertIncludes('openrouter config xiaomi mimo', configSource, `'${xiaomiMimo}'`);
assertIncludes('model alias resolver xiaomi mimo', resolverSource, `'${xiaomiMimo}'`);
assertIncludes('openrouter provider xiaomi mimo', providerSource, `'${xiaomiMimo}'`);
assertIncludes('openrouter provider qwen plus', providerSource, `'${qwenPlus}'`);
assertNotIncludes('openrouter config', configSource, qwenMax);
assertNotIncludes('model alias resolver', resolverSource, qwenMax);
assertNotIncludes('openrouter provider', providerSource, qwenMax);

console.log(JSON.stringify({ ok: true, miniMaxM3, qwenPlus, grok43, xiaomiMimo }));
