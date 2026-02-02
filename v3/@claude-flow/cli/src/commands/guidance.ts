/**
 * V3 CLI Guidance Command
 * Guidance Control Plane - compile, retrieve, enforce, optimize
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// compile subcommand
const compileCommand: Command = {
  name: 'compile',
  description: 'Compile CLAUDE.md into a policy bundle (constitution + shards + manifest)',
  options: [
    { name: 'root', short: 'r', type: 'string', description: 'Root guidance file path', default: './CLAUDE.md' },
    { name: 'local', short: 'l', type: 'string', description: 'Local guidance overlay file path' },
    { name: 'output', short: 'o', type: 'string', description: 'Output directory for compiled bundle' },
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: 'false' },
  ],
  examples: [
    { command: 'claude-flow guidance compile', description: 'Compile default CLAUDE.md' },
    { command: 'claude-flow guidance compile -r ./CLAUDE.md -l ./CLAUDE.local.md', description: 'Compile with local overlay' },
    { command: 'claude-flow guidance compile --json', description: 'Output compiled bundle as JSON' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const rootPath = ctx.flags.root as string || './CLAUDE.md';
    const localPath = ctx.flags.local as string | undefined;
    const jsonOutput = ctx.flags.json === true;

    output.writeln();
    output.writeln(output.bold('Guidance Compiler'));
    output.writeln(output.dim('─'.repeat(50)));

    try {
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');

      if (!existsSync(rootPath)) {
        output.writeln(output.red(`Root guidance file not found: ${rootPath}`));
        return { success: false, message: `File not found: ${rootPath}` };
      }

      const rootContent = await readFile(rootPath, 'utf-8');
      let localContent: string | undefined;
      if (localPath && existsSync(localPath)) {
        localContent = await readFile(localPath, 'utf-8');
      }

      const { GuidanceCompiler } = await import('@claude-flow/guidance/compiler');
      const compiler = new GuidanceCompiler();
      const bundle = compiler.compile(rootContent, localContent);

      if (jsonOutput) {
        output.writeln(JSON.stringify(bundle, null, 2));
      } else {
        output.writeln(output.green('Compiled successfully'));
        output.writeln();
        output.writeln(`  Constitution rules: ${output.bold(String(bundle.constitution.rules.length))}`);
        output.writeln(`  Constitution hash:  ${output.dim(bundle.constitution.hash)}`);
        output.writeln(`  Shard count:        ${output.bold(String(bundle.shards.length))}`);
        output.writeln(`  Total rules:        ${output.bold(String(bundle.manifest.totalRules))}`);
        output.writeln(`  Compiled at:        ${output.dim(new Date(bundle.manifest.compiledAt).toISOString())}`);

        if (localContent) {
          output.writeln(`  Local overlay:      ${output.green('applied')}`);
        }

        output.writeln();
        output.writeln(output.dim('Rule summary:'));
        for (const rule of bundle.manifest.rules.slice(0, 10)) {
          const risk = rule.riskClass === 'critical' ? output.red(rule.riskClass) :
            rule.riskClass === 'high' ? output.yellow(rule.riskClass) :
              output.dim(rule.riskClass);
          output.writeln(`  ${output.bold(rule.id)} [${risk}] ${rule.text.slice(0, 60)}${rule.text.length > 60 ? '...' : ''}`);
        }
        if (bundle.manifest.rules.length > 10) {
          output.writeln(output.dim(`  ... and ${bundle.manifest.rules.length - 10} more`));
        }
      }

      return { success: true, data: bundle };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output.writeln(output.red(`Compilation failed: ${msg}`));
      return { success: false, message: msg };
    }
  },
};

// retrieve subcommand
const retrieveCommand: Command = {
  name: 'retrieve',
  description: 'Retrieve task-relevant guidance shards for a given task description',
  options: [
    { name: 'task', short: 't', type: 'string', description: 'Task description', required: true },
    { name: 'root', short: 'r', type: 'string', description: 'Root guidance file path', default: './CLAUDE.md' },
    { name: 'local', short: 'l', type: 'string', description: 'Local overlay file path' },
    { name: 'max-shards', short: 'n', type: 'number', description: 'Maximum number of shards to retrieve', default: '5' },
    { name: 'intent', short: 'i', type: 'string', description: 'Override detected intent' },
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: 'false' },
  ],
  examples: [
    { command: 'claude-flow guidance retrieve -t "Fix SQL injection in user search"', description: 'Retrieve guidance for a security task' },
    { command: 'claude-flow guidance retrieve -t "Add unit tests" -n 3', description: 'Retrieve top 3 shards for testing' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const task = ctx.flags.task as string;
    const rootPath = ctx.flags.root as string || './CLAUDE.md';
    const localPath = ctx.flags.local as string | undefined;
    const maxShards = parseInt(ctx.flags['max-shards'] as string || '5', 10);
    const intentOverride = ctx.flags.intent as string | undefined;
    const jsonOutput = ctx.flags.json === true;

    if (!task) {
      output.writeln(output.red('Task description is required (-t "...")'));
      return { success: false, message: 'Missing task description' };
    }

    output.writeln();
    output.writeln(output.bold('Guidance Retriever'));
    output.writeln(output.dim('─'.repeat(50)));

    try {
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { GuidanceCompiler } = await import('@claude-flow/guidance/compiler');
      const { ShardRetriever, HashEmbeddingProvider } = await import('@claude-flow/guidance/retriever');

      if (!existsSync(rootPath)) {
        output.writeln(output.red(`Root guidance file not found: ${rootPath}`));
        return { success: false, message: `File not found: ${rootPath}` };
      }

      const rootContent = await readFile(rootPath, 'utf-8');
      let localContent: string | undefined;
      if (localPath && existsSync(localPath)) {
        localContent = await readFile(localPath, 'utf-8');
      }

      const compiler = new GuidanceCompiler();
      const bundle = compiler.compile(rootContent, localContent);

      const retriever = new ShardRetriever(new HashEmbeddingProvider(128));
      await retriever.loadBundle(bundle);

      const result = await retriever.retrieve({
        taskDescription: task,
        maxShards,
        intent: intentOverride as any,
      });

      if (jsonOutput) {
        output.writeln(JSON.stringify(result, null, 2));
      } else {
        output.writeln(`  Detected intent: ${output.bold(result.detectedIntent)}`);
        output.writeln(`  Retrieval time:  ${output.dim(result.latencyMs + 'ms')}`);
        output.writeln(`  Constitution:    ${output.bold(String(result.constitution.rules.length))} rules`);
        output.writeln(`  Shards:          ${output.bold(String(result.shards.length))} retrieved`);
        output.writeln();

        if (result.shards.length > 0) {
          output.writeln(output.dim('Retrieved shards:'));
          for (const shard of result.shards) {
            output.writeln(`  ${output.bold(shard.rule.id)} [${shard.rule.riskClass}] ${shard.rule.text.slice(0, 60)}`);
          }
        }

        output.writeln();
        output.writeln(output.dim('Policy text preview:'));
        const lines = result.policyText.split('\n').slice(0, 15);
        for (const line of lines) {
          output.writeln(`  ${line}`);
        }
        if (result.policyText.split('\n').length > 15) {
          output.writeln(output.dim('  ...'));
        }
      }

      return { success: true, data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output.writeln(output.red(`Retrieval failed: ${msg}`));
      return { success: false, message: msg };
    }
  },
};

// gates subcommand
const gatesCommand: Command = {
  name: 'gates',
  description: 'Evaluate enforcement gates against a command or content',
  options: [
    { name: 'command', short: 'c', type: 'string', description: 'Command to evaluate' },
    { name: 'content', type: 'string', description: 'Content to check for secrets' },
    { name: 'tool', short: 't', type: 'string', description: 'Tool name to check against allowlist' },
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: 'false' },
  ],
  examples: [
    { command: 'claude-flow guidance gates -c "rm -rf /tmp"', description: 'Check if a command is destructive' },
    { command: 'claude-flow guidance gates --content "api_key=sk-abc123..."', description: 'Check content for secrets' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const command = ctx.flags.command as string | undefined;
    const content = ctx.flags.content as string | undefined;
    const tool = ctx.flags.tool as string | undefined;
    const jsonOutput = ctx.flags.json === true;

    output.writeln();
    output.writeln(output.bold('Enforcement Gates'));
    output.writeln(output.dim('─'.repeat(50)));

    try {
      const { EnforcementGates } = await import('@claude-flow/guidance/gates');
      const gates = new EnforcementGates();

      const results: Array<{ type: string; result: any }> = [];

      if (command) {
        const gateResults = gates.evaluateCommand(command);
        results.push({ type: 'command', result: gateResults });
      }

      if (content) {
        const secretResult = gates.evaluateSecrets(content);
        results.push({ type: 'secrets', result: secretResult });
      }

      if (tool) {
        const toolResult = gates.evaluateToolAllowlist(tool);
        results.push({ type: 'tool-allowlist', result: toolResult });
      }

      if (results.length === 0) {
        output.writeln(output.yellow('No input provided. Use -c, --content, or -t to evaluate.'));
        return { success: false, message: 'No input' };
      }

      if (jsonOutput) {
        output.writeln(JSON.stringify(results, null, 2));
      } else {
        for (const { type, result } of results) {
          output.writeln(`  ${output.bold(type)}:`);
          if (result === null) {
            output.writeln(`    ${output.green('ALLOW')} - No gate triggered`);
          } else if (Array.isArray(result)) {
            if (result.length === 0) {
              output.writeln(`    ${output.green('ALLOW')} - All gates passed`);
            } else {
              for (const r of result) {
                const color = r.decision === 'block' ? output.red :
                  r.decision === 'require-confirmation' ? output.yellow :
                    output.dim;
                output.writeln(`    ${color(r.decision.toUpperCase())} [${r.gateName}] ${r.reason}`);
                if (r.remediation) {
                  output.writeln(`      Remediation: ${output.dim(r.remediation)}`);
                }
              }
            }
          } else {
            const color = result.decision === 'block' ? output.red :
              result.decision === 'require-confirmation' ? output.yellow :
                output.dim;
            output.writeln(`    ${color(result.decision.toUpperCase())} [${result.gateName}] ${result.reason}`);
            if (result.remediation) {
              output.writeln(`      Remediation: ${output.dim(result.remediation)}`);
            }
          }
        }
      }

      return { success: true, data: results };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output.writeln(output.red(`Gate evaluation failed: ${msg}`));
      return { success: false, message: msg };
    }
  },
};

// status subcommand
const statusCommand: Command = {
  name: 'status',
  description: 'Show guidance control plane status and metrics',
  options: [
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: 'false' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const jsonOutput = ctx.flags.json === true;

    output.writeln();
    output.writeln(output.bold('Guidance Control Plane Status'));
    output.writeln(output.dim('─'.repeat(50)));

    try {
      const { existsSync } = await import('node:fs');

      const rootExists = existsSync('./CLAUDE.md');
      const localExists = existsSync('./CLAUDE.local.md');

      const statusData = {
        rootGuidance: rootExists ? 'found' : 'not found',
        localOverlay: localExists ? 'found' : 'not configured',
        dataDir: existsSync('./.claude-flow/guidance') ? 'exists' : 'not created',
      };

      if (jsonOutput) {
        output.writeln(JSON.stringify(statusData, null, 2));
      } else {
        output.writeln(`  Root guidance:  ${rootExists ? output.green('CLAUDE.md found') : output.yellow('CLAUDE.md not found')}`);
        output.writeln(`  Local overlay:  ${localExists ? output.green('CLAUDE.local.md found') : output.dim('not configured')}`);
        output.writeln(`  Data directory: ${statusData.dataDir === 'exists' ? output.green('exists') : output.dim('not created')}`);

        if (rootExists) {
          const { readFile } = await import('node:fs/promises');
          const { GuidanceCompiler } = await import('@claude-flow/guidance/compiler');
          const rootContent = await readFile('./CLAUDE.md', 'utf-8');
          const compiler = new GuidanceCompiler();
          const bundle = compiler.compile(rootContent);

          output.writeln();
          output.writeln(output.dim('Compiled bundle:'));
          output.writeln(`  Constitution rules: ${output.bold(String(bundle.constitution.rules.length))}`);
          output.writeln(`  Shard count:        ${output.bold(String(bundle.shards.length))}`);
          output.writeln(`  Total rules:        ${output.bold(String(bundle.manifest.totalRules))}`);
          output.writeln(`  Hash:               ${output.dim(bundle.constitution.hash)}`);
        }
      }

      return { success: true, data: statusData };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      output.writeln(output.red(`Status check failed: ${msg}`));
      return { success: false, message: msg };
    }
  },
};

// optimize subcommand
const optimizeCommand: Command = {
  name: 'optimize',
  description: 'Run the optimizer loop to evolve guidance rules based on run history',
  options: [
    { name: 'dry-run', type: 'boolean', description: 'Show proposed changes without applying', default: 'false' },
    { name: 'json', type: 'boolean', description: 'Output as JSON', default: 'false' },
  ],
  examples: [
    { command: 'claude-flow guidance optimize', description: 'Run optimization cycle' },
    { command: 'claude-flow guidance optimize --dry-run', description: 'Preview proposed changes' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const dryRun = ctx.flags['dry-run'] === true;
    const jsonOutput = ctx.flags.json === true;

    output.writeln();
    output.writeln(output.bold('Guidance Optimizer'));
    output.writeln(output.dim('─'.repeat(50)));

    if (dryRun) {
      output.writeln(output.yellow('(dry run - no changes will be applied)'));
    }

    output.writeln(output.dim('Optimization requires a populated run ledger.'));
    output.writeln(output.dim('Run tasks with guidance tracking enabled first.'));

    return { success: true, message: 'Optimizer ready' };
  },
};

// Main guidance command
export const guidanceCommand: Command = {
  name: 'guidance',
  description: 'Guidance Control Plane - compile, retrieve, enforce, and optimize guidance rules',
  aliases: ['guide', 'policy'],
  subcommands: [
    compileCommand,
    retrieveCommand,
    gatesCommand,
    statusCommand,
    optimizeCommand,
  ],
  options: [],
  examples: [
    { command: 'claude-flow guidance compile', description: 'Compile CLAUDE.md into policy bundle' },
    { command: 'claude-flow guidance retrieve -t "Fix auth bug"', description: 'Retrieve relevant guidance' },
    { command: 'claude-flow guidance gates -c "rm -rf /"', description: 'Check enforcement gates' },
    { command: 'claude-flow guidance status', description: 'Show control plane status' },
    { command: 'claude-flow guidance optimize', description: 'Run optimization cycle' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Guidance Control Plane'));
    output.writeln(output.dim('─'.repeat(50)));
    output.writeln();
    output.writeln('Available subcommands:');
    output.writeln(`  ${output.bold('compile')}   Compile CLAUDE.md into policy bundle`);
    output.writeln(`  ${output.bold('retrieve')}  Retrieve task-relevant guidance shards`);
    output.writeln(`  ${output.bold('gates')}     Evaluate enforcement gates`);
    output.writeln(`  ${output.bold('status')}    Show control plane status`);
    output.writeln(`  ${output.bold('optimize')}  Run optimization cycle`);
    output.writeln();
    output.writeln(output.dim('Use claude-flow guidance <subcommand> --help for details'));

    return { success: true };
  },
};

export default guidanceCommand;
