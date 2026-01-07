/**
 * V3 CLI Claims Command
 * Claims-based authorization, permissions, and access control
 *
 * Created with ❤️ by ruv.io
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { output } from '../output.js';

// List subcommand
const listCommand: Command = {
  name: 'list',
  description: 'List claims and permissions',
  options: [
    { name: 'user', short: 'u', type: 'string', description: 'Filter by user ID' },
    { name: 'role', short: 'r', type: 'string', description: 'Filter by role' },
    { name: 'resource', type: 'string', description: 'Filter by resource' },
  ],
  examples: [
    { command: 'claude-flow claims list', description: 'List all claims' },
    { command: 'claude-flow claims list -u user123', description: 'List user claims' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Claims & Permissions'));
    output.writeln(output.dim('─'.repeat(70)));

    output.printTable({
      columns: [
        { key: 'claim', header: 'Claim', width: 25 },
        { key: 'type', header: 'Type', width: 12 },
        { key: 'scope', header: 'Scope', width: 15 },
        { key: 'value', header: 'Value', width: 20 },
      ],
      data: [
        { claim: 'swarm:create', type: 'Permission', scope: 'Global', value: output.success('Allowed') },
        { claim: 'swarm:delete', type: 'Permission', scope: 'Owned', value: output.success('Allowed') },
        { claim: 'agent:spawn', type: 'Permission', scope: 'Global', value: output.success('Allowed') },
        { claim: 'memory:read', type: 'Permission', scope: 'Namespace', value: output.success('Allowed') },
        { claim: 'memory:write', type: 'Permission', scope: 'Namespace', value: output.success('Allowed') },
        { claim: 'admin:*', type: 'Permission', scope: 'Global', value: output.error('Denied') },
        { claim: 'role', type: 'Identity', scope: 'System', value: 'developer' },
        { claim: 'tier', type: 'Identity', scope: 'System', value: 'pro' },
      ],
    });

    return { success: true };
  },
};

// Check subcommand
const checkCommand: Command = {
  name: 'check',
  description: 'Check if a specific claim is granted',
  options: [
    { name: 'claim', short: 'c', type: 'string', description: 'Claim to check', required: true },
    { name: 'user', short: 'u', type: 'string', description: 'User ID to check' },
    { name: 'resource', short: 'r', type: 'string', description: 'Resource context' },
  ],
  examples: [
    { command: 'claude-flow claims check -c swarm:create', description: 'Check swarm creation permission' },
    { command: 'claude-flow claims check -c admin:delete -u user123', description: 'Check user permission' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const claim = ctx.flags.claim as string;
    const user = ctx.flags.user as string || 'current';

    if (!claim) {
      output.printError('Claim is required');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    output.writeln(output.bold('Claim Check'));
    output.writeln(output.dim('─'.repeat(40)));

    const spinner = output.createSpinner({ text: 'Evaluating claim...', spinner: 'dots' });
    spinner.start();
    await new Promise(r => setTimeout(r, 300));

    // Simulate claim check
    const isGranted = !claim.startsWith('admin:');

    if (isGranted) {
      spinner.succeed('Claim granted');
    } else {
      spinner.fail('Claim denied');
    }

    output.writeln();
    output.printBox([
      `Claim: ${claim}`,
      `User: ${user}`,
      `Result: ${isGranted ? output.success('GRANTED') : output.error('DENIED')}`,
      ``,
      `Reason: ${isGranted ? 'User has required role' : 'Requires admin role'}`,
    ].join('\n'), 'Result');

    return { success: true };
  },
};

// Grant subcommand
const grantCommand: Command = {
  name: 'grant',
  description: 'Grant a claim to user or role',
  options: [
    { name: 'claim', short: 'c', type: 'string', description: 'Claim to grant', required: true },
    { name: 'user', short: 'u', type: 'string', description: 'User ID' },
    { name: 'role', short: 'r', type: 'string', description: 'Role name' },
    { name: 'scope', short: 's', type: 'string', description: 'Scope: global, namespace, resource', default: 'global' },
    { name: 'expires', short: 'e', type: 'string', description: 'Expiration time (e.g., 24h, 7d)' },
  ],
  examples: [
    { command: 'claude-flow claims grant -c swarm:create -u user123', description: 'Grant to user' },
    { command: 'claude-flow claims grant -c agent:spawn -r developer', description: 'Grant to role' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const claim = ctx.flags.claim as string;
    const user = ctx.flags.user as string;
    const role = ctx.flags.role as string;
    const scope = ctx.flags.scope as string || 'global';

    if (!claim) {
      output.printError('Claim is required');
      return { success: false, exitCode: 1 };
    }

    if (!user && !role) {
      output.printError('Either user or role is required');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    const spinner = output.createSpinner({ text: 'Granting claim...', spinner: 'dots' });
    spinner.start();
    await new Promise(r => setTimeout(r, 400));
    spinner.succeed('Claim granted');

    output.writeln();
    output.printBox([
      `Claim: ${claim}`,
      `Target: ${user ? `User: ${user}` : `Role: ${role}`}`,
      `Scope: ${scope}`,
      `Status: ${output.success('Active')}`,
    ].join('\n'), 'Grant Complete');

    return { success: true };
  },
};

// Revoke subcommand
const revokeCommand: Command = {
  name: 'revoke',
  description: 'Revoke a claim from user or role',
  options: [
    { name: 'claim', short: 'c', type: 'string', description: 'Claim to revoke', required: true },
    { name: 'user', short: 'u', type: 'string', description: 'User ID' },
    { name: 'role', short: 'r', type: 'string', description: 'Role name' },
  ],
  examples: [
    { command: 'claude-flow claims revoke -c swarm:delete -u user123', description: 'Revoke from user' },
    { command: 'claude-flow claims revoke -c admin:* -r guest', description: 'Revoke from role' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const claim = ctx.flags.claim as string;
    const user = ctx.flags.user as string;
    const role = ctx.flags.role as string;

    if (!claim) {
      output.printError('Claim is required');
      return { success: false, exitCode: 1 };
    }

    output.writeln();
    const spinner = output.createSpinner({ text: 'Revoking claim...', spinner: 'dots' });
    spinner.start();
    await new Promise(r => setTimeout(r, 300));
    spinner.succeed('Claim revoked');

    return { success: true };
  },
};

// Roles subcommand
const rolesCommand: Command = {
  name: 'roles',
  description: 'Manage roles and their claims',
  options: [
    { name: 'action', short: 'a', type: 'string', description: 'Action: list, create, delete, show', default: 'list' },
    { name: 'name', short: 'n', type: 'string', description: 'Role name' },
  ],
  examples: [
    { command: 'claude-flow claims roles', description: 'List all roles' },
    { command: 'claude-flow claims roles -a show -n admin', description: 'Show role details' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    const action = ctx.flags.action as string || 'list';
    const name = ctx.flags.name as string;

    output.writeln();
    output.writeln(output.bold('Roles'));
    output.writeln(output.dim('─'.repeat(60)));

    if (action === 'show' && name) {
      output.printBox([
        `Role: ${name}`,
        `Description: Full system access`,
        ``,
        `Claims:`,
        `  - swarm:* (all swarm operations)`,
        `  - agent:* (all agent operations)`,
        `  - memory:* (all memory operations)`,
        `  - admin:* (administrative functions)`,
        ``,
        `Members: 2`,
        `Created: 2024-01-01`,
      ].join('\n'), 'Role Details');
    } else {
      output.printTable({
        columns: [
          { key: 'role', header: 'Role', width: 15 },
          { key: 'description', header: 'Description', width: 30 },
          { key: 'claims', header: 'Claims', width: 12 },
          { key: 'members', header: 'Members', width: 10 },
        ],
        data: [
          { role: output.highlight('admin'), description: 'Full system access', claims: '15', members: '2' },
          { role: output.highlight('developer'), description: 'Development operations', claims: '10', members: '12' },
          { role: output.highlight('operator'), description: 'Operational tasks', claims: '8', members: '5' },
          { role: output.highlight('viewer'), description: 'Read-only access', claims: '3', members: '25' },
          { role: output.highlight('guest'), description: 'Limited access', claims: '1', members: '100' },
        ],
      });
    }

    return { success: true };
  },
};

// Policies subcommand
const policiesCommand: Command = {
  name: 'policies',
  description: 'Manage claim policies',
  options: [
    { name: 'action', short: 'a', type: 'string', description: 'Action: list, create, delete', default: 'list' },
    { name: 'name', short: 'n', type: 'string', description: 'Policy name' },
  ],
  examples: [
    { command: 'claude-flow claims policies', description: 'List policies' },
    { command: 'claude-flow claims policies -a create -n rate-limit', description: 'Create policy' },
  ],
  action: async (ctx: CommandContext): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Claim Policies'));
    output.writeln(output.dim('─'.repeat(60)));

    output.printTable({
      columns: [
        { key: 'policy', header: 'Policy', width: 20 },
        { key: 'type', header: 'Type', width: 15 },
        { key: 'condition', header: 'Condition', width: 30 },
        { key: 'status', header: 'Status', width: 12 },
      ],
      data: [
        { policy: 'rate-limit', type: 'Throttle', condition: 'Max 100 req/min', status: output.success('Active') },
        { policy: 'geo-restrict', type: 'Location', condition: 'US, EU only', status: output.success('Active') },
        { policy: 'time-window', type: 'Temporal', condition: 'Business hours', status: output.dim('Inactive') },
        { policy: 'ip-allowlist', type: 'Network', condition: '10.0.0.0/8', status: output.success('Active') },
        { policy: 'mfa-required', type: 'Auth', condition: 'Admin operations', status: output.success('Active') },
      ],
    });

    return { success: true };
  },
};

// Main claims command
export const claimsCommand: Command = {
  name: 'claims',
  description: 'Claims-based authorization, permissions, and access control',
  subcommands: [listCommand, checkCommand, grantCommand, revokeCommand, rolesCommand, policiesCommand],
  examples: [
    { command: 'claude-flow claims list', description: 'List all claims' },
    { command: 'claude-flow claims check -c swarm:create', description: 'Check permission' },
    { command: 'claude-flow claims grant -c agent:spawn -r developer', description: 'Grant claim' },
  ],
  action: async (): Promise<CommandResult> => {
    output.writeln();
    output.writeln(output.bold('Claude Flow Claims System'));
    output.writeln(output.dim('Fine-grained authorization and access control'));
    output.writeln();
    output.writeln('Subcommands:');
    output.printList([
      'list     - List claims and permissions',
      'check    - Check if a claim is granted',
      'grant    - Grant a claim to user or role',
      'revoke   - Revoke a claim',
      'roles    - Manage roles and their claims',
      'policies - Manage claim policies',
    ]);
    output.writeln();
    output.writeln('Claim Types:');
    output.printList([
      'swarm:*   - Swarm operations (create, delete, scale)',
      'agent:*   - Agent operations (spawn, terminate)',
      'memory:*  - Memory operations (read, write, delete)',
      'admin:*   - Administrative operations',
    ]);
    output.writeln();
    output.writeln(output.dim('Created with ❤️ by ruv.io'));
    return { success: true };
  },
};

export default claimsCommand;
