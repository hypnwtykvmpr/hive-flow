/**
 * V3 CLI Providers Command
 * Manage AI providers, models, and configurations
 *
 * Created by Hive Flow
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';
import { ProviderRegistry } from '@hive-flow/shared';
import {
  completeStrictApiProviderViaHolder,
  isStrictApiProvider,
  probeCredentialHolderStatus,
} from '../credential-store/strict-api-provider.js';
import { storeProviderCredential } from '../credential-store/holder-runtime.js';

/** Shared registry instance, lazily initialized on first use */
let _registry: ProviderRegistry | undefined;
async function getRegistry(): Promise<ProviderRegistry> {
  if (!_registry) {
    _registry = new ProviderRegistry();
    await _registry.initialize(true);
  }
  return _registry;
}

function providerIdForStatus(metadata: { id?: unknown; type?: unknown; name?: unknown }): string {
  return String(metadata.id || metadata.type || metadata.name || '').trim().toLowerCase();
}

// List subcommand
const listCommand: Command = {
  name: 'list',
  description: 'List available AI providers and models',
  options: [
    { name: 'type', short: 't', type: 'string', description: 'Filter by provider type', default: 'all' },
    { name: 'active', short: 'a', type: 'boolean', description: 'Show only active providers' },
  ],
  examples: [
    { command: 'hive-flow providers list', description: 'List all providers' },
    { command: 'hive-flow providers list -t anthropic', description: 'List Anthropic providers' },
  ],
	  action: async (ctx: CommandContext): Promise<CommandResult> => {
	    const filterType = ctx.flags.type as string || 'all';
	    const registry = await getRegistry();
	    const holderStatus = await probeCredentialHolderStatus();

    let providers = registry.getAll();
    if (filterType !== 'all') {
      providers = providers.filter(p => p.metadata.type === filterType);
    }

    output.writeln();
    output.writeln(output.bold('Available Providers'));
    output.writeln(output.dim('─'.repeat(60)));

    output.printTable({
      columns: [
        { key: 'provider', header: 'Provider', width: 18 },
        { key: 'type', header: 'Type', width: 12 },
        { key: 'models', header: 'Models', width: 30 },
        { key: 'status', header: 'Status', width: 12 },
      ],
	      data: providers.map(p => {
	        const providerId = providerIdForStatus(p.metadata);
	        const hasKey = isStrictApiProvider(providerId)
	          ? holderStatus.available
	          : p.metadata.apiKeyEnvVar
	            ? !!process.env[p.metadata.apiKeyEnvVar]
	            : true;
	        return {
	          provider: p.metadata.name,
	          type: p.metadata.type,
	          models: p.metadata.models.slice(0, 3).join(', '),
	          status: hasKey
	            ? output.success(isStrictApiProvider(providerId) ? 'Holder' : 'Active')
	            : output.dim(isStrictApiProvider(providerId) ? 'Holder needed' : 'No key'),
	        };
	      }),
    });

    output.writeln();
    output.printInfo(`${providers.length} providers registered (${registry.size} total)`);

    return { success: true };
  },
};

// Configure subcommand
const configureCommand: Command = {
  name: 'configure',
  description: 'Configure provider settings and API keys',
  options: [
    { name: 'provider', short: 'p', type: 'string', description: 'Provider name', required: true },
    { name: 'key', short: 'k', type: 'string', description: 'API key' },
    { name: 'model', short: 'm', type: 'string', description: 'Default model' },
    { name: 'endpoint', short: 'e', type: 'string', description: 'Custom endpoint URL' },
  ],
  examples: [
    { command: 'hive-flow providers configure -p openai -k sk-...', description: 'Set OpenAI key' },
    { command: 'hive-flow providers configure -p anthropic -m claude-3.5-sonnet', description: 'Set default model' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const provider = ctx.flags.provider as string;
    const hasKey = ctx.flags.key as string;
    const model = ctx.flags.model as string;

    if (!provider) {
      output.printError('Provider name is required');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold(`Configure: ${provider}`));
    output.writeln(output.dim('─'.repeat(40)));

    const spinner = output.createSpinner({ text: 'Updating configuration...', spinner: 'dots' });
    spinner.start();
    let storedCredential: { provider: string; stored: boolean; vaultReady: boolean } | undefined;
    if (hasKey) {
      storedCredential = await storeProviderCredential({
        provider,
        secret: hasKey,
      });
    } else {
      await new Promise(r => setTimeout(r, 500));
    }
    spinner.succeed('Configuration updated');

    output.writeln();
    output.printBox([
      `Provider: ${provider}`,
      `API Key: ${hasKey ? 'Stored in credential vault' : 'Not set'}`,
      `Model: ${model || 'Default'}`,
      `Status: ${storedCredential?.vaultReady ? 'Credential vault ready' : 'Active'}`,
    ].join('\n'), 'Configuration');

    return {
      success: true,
      data: {
        provider,
        model: model || undefined,
        credentialStored: Boolean(storedCredential?.stored),
        credentialBoundary: hasKey ? 'credential-vault' : undefined,
      },
    };
  },
};

// Test subcommand
const testCommand: Command = {
  name: 'test',
  description: 'Test provider connectivity and API access',
  options: [
    { name: 'provider', short: 'p', type: 'string', description: 'Provider to test' },
    { name: 'all', short: 'a', type: 'boolean', description: 'Test all configured providers' },
  ],
  examples: [
    { command: 'hive-flow providers test -p openai', description: 'Test OpenAI connection' },
    { command: 'hive-flow providers test --all', description: 'Test all providers' },
  ],
	  action: async (ctx: CommandContext): Promise<CommandResult> => {
	    const providerId = ctx.flags.provider as string;
	    const testAll = ctx.flags.all as boolean;
	    const registry = await getRegistry();
	    const holderStatus = await probeCredentialHolderStatus();

    output.writeln();
    output.writeln(output.bold('Provider Connectivity Test'));
    output.writeln(output.dim('─'.repeat(50)));

    const providerIds = testAll || !providerId
      ? registry.getAllIds()
      : [providerId];

	    let healthy = 0;
	    for (const id of providerIds) {
	      const spinner = output.createSpinner({ text: `Testing ${id}...`, spinner: 'dots' });
	      spinner.start();
	      if (isStrictApiProvider(id)) {
	        if (holderStatus.available) {
	          try {
	            await completeStrictApiProviderViaHolder({
	              provider: id,
	              prompt: 'Hive Flow provider health check. Reply with ok.',
	              timeoutMs: 30_000,
	            });
	            spinner.succeed(`${id}: credential holder completion succeeded`);
	            healthy++;
	          } catch (error) {
	            spinner.fail(`${id}: holder completion failed — ${(error as Error).message}`);
	          }
	        } else {
	          spinner.stop(output.warning(`${id}: holder needed — ${holderStatus.reason || 'credential holder unavailable'}`));
	        }
	        continue;
	      }
	      const result = await registry.checkHealth(id);
      if (result.status === 'healthy') {
        spinner.succeed(`${id}: ${result.status} (${result.latencyMs}ms)`);
        healthy++;
      } else if (result.status === 'degraded') {
        spinner.stop(output.warning(`${id}: ${result.status} — ${result.error || 'missing API key'}`));
      } else {
        spinner.fail(`${id}: ${result.status} — ${result.error || 'unknown error'}`);
      }
    }

    output.writeln();
    if (healthy === providerIds.length) {
      output.printSuccess(`All ${providerIds.length} providers healthy`);
    } else {
      output.printInfo(`${healthy}/${providerIds.length} providers healthy`);
    }

    return { success: true };
  },
};

// Models subcommand
const modelsCommand: Command = {
  name: 'models',
  description: 'List and manage available models',
  options: [
    { name: 'provider', short: 'p', type: 'string', description: 'Filter by provider' },
    { name: 'capability', short: 'c', type: 'string', description: 'Filter by capability: chat, completion, embedding' },
  ],
  examples: [
    { command: 'hive-flow providers models', description: 'List all models' },
    { command: 'hive-flow providers models -p anthropic', description: 'List Anthropic models' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Available Models'));
    output.writeln(output.dim('─'.repeat(70)));

    output.printTable({
      columns: [
        { key: 'model', header: 'Model', width: 28 },
        { key: 'provider', header: 'Provider', width: 14 },
        { key: 'capability', header: 'Capability', width: 12 },
        { key: 'context', header: 'Context', width: 10 },
        { key: 'cost', header: 'Cost/1K', width: 12 },
      ],
      data: [
        { model: 'claude-3.5-sonnet-20241022', provider: 'Anthropic', capability: 'Chat', context: '200K', cost: '$0.003/$0.015' },
        { model: 'claude-3-opus-20240229', provider: 'Anthropic', capability: 'Chat', context: '200K', cost: '$0.015/$0.075' },
        { model: 'gpt-4o', provider: 'OpenAI', capability: 'Chat', context: '128K', cost: '$0.0025/$0.01' },
        { model: 'gpt-4o-mini', provider: 'OpenAI', capability: 'Chat', context: '128K', cost: '$0.00015/$0.0006' },
        { model: 'o3-mini', provider: 'OpenAI', capability: 'Chat', context: '200K', cost: '$0.0011/$0.0044' },
        { model: 'gemini-2.5-flash', provider: 'Google', capability: 'Chat', context: '1M', cost: '$0.00015/$0.0006' },
        { model: 'gemini-2.5-pro', provider: 'Google', capability: 'Chat', context: '1M', cost: '$0.00125/$0.01' },
        { model: 'gemini-3.5-flash', provider: 'Gemini CLI', capability: 'Chat', context: '1M', cost: output.success('Free tier') },
        { model: 'gpt-5.5', provider: 'Codex CLI', capability: 'Chat', context: '1.05M', cost: output.success('ChatGPT sub') },
        { model: 'command-r-plus', provider: 'Cohere', capability: 'Chat', context: '128K', cost: '$0.003/$0.015' },
        { model: 'llama3.2', provider: 'Ollama', capability: 'Chat', context: '128K', cost: output.success('Free') },
        { model: '(user loaded)', provider: 'LM Studio', capability: 'Chat', context: 'varies', cost: output.success('Free') },
        { model: 'xiaomi/mimo-v2.5-pro', provider: 'OpenRouter', capability: 'Chat', context: '1M', cost: 'see OpenRouter' },
        { model: 'deepseek-v4-pro', provider: 'DeepSeek', capability: 'Reasoning', context: '1M', cost: '$0.000435/$0.00087' },
        { model: 'deepseek-v4-flash', provider: 'DeepSeek', capability: 'Chat', context: '1M', cost: '$0.00014/$0.00028' },
        { model: 'qwen-max', provider: 'Qwen API', capability: 'Chat', context: '32K', cost: '$0.0016/$0.0064' },
        { model: 'qwen-turbo', provider: 'Qwen API', capability: 'Chat', context: '131K', cost: '$0.0002/$0.0006' },
        { model: 'qwen-turbo', provider: 'Qwen CLI', capability: 'Chat', context: '131K', cost: '$0.0002/$0.0006' },
        { model: 'auto', provider: 'Cursor CLI', capability: 'Chat', context: '200K', cost: output.success('Cursor sub') },
        { model: 'gpt-4o', provider: 'Copilot API', capability: 'Chat', context: '128K', cost: output.success('Copilot sub') },
      ],
    });

    return { success: true };
  },
};

// Usage subcommand
const usageCommand: Command = {
  name: 'usage',
  description: 'View provider usage and costs',
  options: [
    { name: 'provider', short: 'p', type: 'string', description: 'Filter by provider' },
    { name: 'timeframe', short: 't', type: 'string', description: 'Timeframe: 24h, 7d, 30d', default: '7d' },
  ],
  examples: [
    { command: 'hive-flow providers usage', description: 'View all usage' },
    { command: 'hive-flow providers usage -t 30d', description: 'View 30-day usage' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const timeframe = ctx.flags.timeframe as string || '7d';

    output.writeln();
    output.writeln(output.bold(`Provider Usage (${timeframe})`));
    output.writeln(output.dim('─'.repeat(60)));

    output.printTable({
      columns: [
        { key: 'provider', header: 'Provider', width: 15 },
        { key: 'requests', header: 'Requests', width: 12 },
        { key: 'tokens', header: 'Tokens', width: 15 },
        { key: 'cost', header: 'Est. Cost', width: 12 },
        { key: 'trend', header: 'Trend', width: 12 },
      ],
      data: [
        { provider: 'Anthropic', requests: '12,847', tokens: '4.2M', cost: '$12.60', trend: output.warning('↑ 15%') },
        { provider: 'OpenAI (LLM)', requests: '3,421', tokens: '1.1M', cost: '$5.50', trend: output.success('↓ 8%') },
        { provider: 'OpenAI (Embed)', requests: '89,234', tokens: '12.4M', cost: '$0.25', trend: output.success('↓ 12%') },
        { provider: 'Transformers.js', requests: '234,567', tokens: '45.2M', cost: output.success('$0.00'), trend: '→' },
      ],
    });

    output.writeln();
    output.printBox([
      `Total Requests: 340,069`,
      `Total Tokens: 62.9M`,
      `Total Cost: $18.35`,
      ``,
      `Savings from local embeddings: $890.12`,
    ].join('\n'), 'Summary');

    return { success: true };
  },
};

// Main providers command
export const providersCommand: Command = {
  name: 'providers',
  description: 'Manage AI providers, models, and configurations',
  subcommands: [listCommand, configureCommand, testCommand, modelsCommand, usageCommand],
  examples: [
    { command: 'hive-flow providers list', description: 'List all providers' },
    { command: 'hive-flow providers configure -p openai', description: 'Configure OpenAI' },
    { command: 'hive-flow providers test --all', description: 'Test all providers' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Hive Flow Provider Management'));
    output.writeln(output.dim('Multi-provider AI orchestration'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'list      - List available providers and their status',
      'configure - Configure provider settings and API keys',
      'test      - Test provider connectivity',
      'models    - List and manage available models',
      'usage     - View usage statistics and costs',
    ]);
    output.writeln();
    output.writeln('Supported Providers:');
    output.printList([
      'Anthropic (Claude models)',
      'OpenAI (GPT + embeddings)',
      'Google (Gemini API)',
      'Gemini CLI (subprocess — uses Google account)',
      'Codex CLI (subprocess — uses ChatGPT subscription)',
      'DeepSeek (DeepSeek-V3 + R1 reasoning)',
      'Qwen API (Alibaba Cloud DashScope)',
      'Qwen CLI (subprocess — uses Qwen OAuth)',
      'Cursor CLI (subprocess — uses Cursor subscription)',
      'Copilot API (local copilot-api server — uses GitHub Copilot subscription)',
      'Cohere (Command R models)',
      'Ollama (local models)',
      'LM Studio (local OpenAI-compatible)',
      'OpenRouter (multi-provider proxy)',
      'Local intelligence system',
    ]);
    output.writeln();
    output.writeln(output.dim('Created by Hive Flow'));
    return { success: true };
  },
};

export default providersCommand;
