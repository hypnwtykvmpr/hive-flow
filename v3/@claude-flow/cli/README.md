# @claude-flow/cli

[![npm version](https://img.shields.io/npm/v/@claude-flow/cli.svg)](https://www.npmjs.com/package/@claude-flow/cli)
[![npm downloads](https://img.shields.io/npm/dm/@claude-flow/cli.svg)](https://www.npmjs.com/package/@claude-flow/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

> Modern CLI module for Claude Flow V3 - command parsing, interactive prompts, and beautiful output formatting.

## Features

- **Advanced Argument Parsing** - Full support for flags, options, subcommands, and positional arguments
- **Interactive Prompts** - Rich interactive mode with confirmations, selections, and input validation
- **Beautiful Output** - Colored output, tables, progress bars, and multiple format options (text, JSON, table)
- **Type-Safe** - Full TypeScript support with comprehensive type definitions
- **Global Options** - Built-in support for `--help`, `--version`, `--verbose`, `--quiet`, and more
- **Auto-Completion** - Shell completion support for commands and options
- **Migration Tools** - Built-in V2 to V3 migration commands

## Installation

```bash
npm install @claude-flow/cli
```

## Quick Start

```typescript
import { CommandParser, OutputFormatter, text, select, confirm } from '@claude-flow/cli';

// Create a parser instance
const parser = new CommandParser();

// Register a command
parser.registerCommand({
  name: 'swarm',
  description: 'Manage swarm operations',
  options: [
    {
      name: 'topology',
      short: 't',
      description: 'Swarm topology type',
      type: 'string',
      choices: ['mesh', 'hierarchical', 'ring'],
      default: 'mesh'
    }
  ],
  subcommands: [
    { name: 'init', description: 'Initialize a new swarm' },
    { name: 'status', description: 'Show swarm status' }
  ]
});

// Parse arguments
const result = parser.parse(process.argv.slice(2));

// Output formatting
const output = new OutputFormatter();
output.printSuccess('Swarm initialized successfully!');
output.printTable([
  { agent: 'queen', status: 'running' },
  { agent: 'worker-1', status: 'idle' }
]);
```

## API Reference

### CommandParser

```typescript
const parser = new CommandParser(options?: ParserOptions);

// Register commands
parser.registerCommand(command: Command);

// Parse arguments
const result = parser.parse(args: string[]): ParseResult;

// Validate flags
const errors = parser.validateFlags(flags: ParsedFlags, command?: Command): string[];

// Get all registered commands
const commands = parser.getAllCommands(): Command[];
```

### Output Formatting

```typescript
import { OutputFormatter, output } from '@claude-flow/cli';

// Use the singleton instance
output.printSuccess('Operation completed');
output.printError('Something went wrong');
output.printWarning('Proceed with caution');
output.printInfo('FYI: This is informational');

// Or create a custom formatter
const formatter = new OutputFormatter({ color: true });

// Color methods
formatter.success('Green text');
formatter.error('Red text');
formatter.warning('Yellow text');
formatter.bold('Bold text');
formatter.dim('Dimmed text');

// Structured output
output.printTable(data, columns);
output.printJson(object);
output.printList(items);

// Progress indication (via Progress and Spinner classes)
import { Progress, Spinner } from '@claude-flow/cli';
const spinner = new Spinner('Loading...');
const progress = new Progress({ total: 100 });
```

### Interactive Prompts

```typescript
import { text, select, confirm, input, multiSelect } from '@claude-flow/cli';

// Text input
const name = await text('Enter your name:');

// Selection (with options array)
const choice = await select({
  message: 'Choose option:',
  options: [
    { label: 'Option A', value: 'A' },
    { label: 'Option B', value: 'B' },
    { label: 'Option C', value: 'C' },
  ]
});

// Confirmation
const confirmed = await confirm({ message: 'Continue?' });

// General input
const response = await input({ message: 'Enter value:', default: 'default' });

// Multi-select
const selections = await multiSelect({
  message: 'Select features:',
  options: features.map(f => ({ label: f.name, value: f.id }))
});
```

## Global Options

All commands support these global options:

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help information |
| `--version` | `-V` | Show version number |
| `--verbose` | `-v` | Enable verbose output |
| `--quiet` | `-q` | Suppress non-essential output |
| `--config` | `-c` | Path to configuration file |
| `--format` | `-f` | Output format (text, json, table) |
| `--no-color` | - | Disable colored output |
| `--interactive` | `-i` | Enable interactive mode |

## Built-in Commands

```bash
# Migration from V2 to V3
claude-flow migrate --from v2 --dry-run

# Help and version
claude-flow --help
claude-flow --version

# Verbose output
claude-flow swarm status --verbose
```

## TypeScript Types

```typescript
import type {
  Command,
  CommandOption,
  ParseResult,
  ParsedFlags,
  CommandContext,
  V3Config
} from '@claude-flow/cli';
```

## Related Packages

- [@claude-flow/shared](../shared) - Shared types and utilities
- [@claude-flow/swarm](../swarm) - Swarm coordination module

## License

MIT
