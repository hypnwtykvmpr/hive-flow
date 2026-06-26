import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const previousEnv = {
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

let bridge;

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  try {
    bridge = await import(`${pathToFileURL(bridgePath).href}?capabilities=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
});

afterAll(() => {
  restoreEnv();
});

const DEFAULT_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'grep',
  'find_file',
  'run_shell',
  'web_fetch',
  'web_search',
];

const STRICT_API_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'grep',
  'find_file',
  'run_shell',
  'run_command',
  'web_fetch',
  'web_search',
];

const EXPECTED_DEFINITIONS = {
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Large files are truncated to a head+tail window; a [FILE TRUNCATED] marker is inserted showing total size. Use offset/limit parameters for specific sections.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed. Supplying empty content truncates the file to 0 bytes — the file is not deleted (the bridge has no delete tool).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          content: { type: 'string', description: 'Full content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact substring in a file with new text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file.' },
          old_string: { type: 'string', description: 'The exact text to find and replace.' },
          new_string: { type: 'string', description: 'The text to replace it with.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the contents of a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list. Defaults to current directory.' },
        },
        required: [],
      },
    },
  },
  grep: {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents for pattern using grep/ripgrep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Pattern to search for (regex).' },
          path: { type: 'string', description: 'Directory path to search. Defaults to project root.' },
          file_glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js"). Requires ripgrep (rg).' },
          max_results: { type: 'number', description: 'Maximum number of results to return. Defaults to 50.' },
        },
        required: ['pattern'],
      },
    },
  },
  find_file: {
    type: 'function',
    function: {
      name: 'find_file',
      description: 'Search for files by glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g., "*.js", "**/*.md").' },
          path: { type: 'string', description: 'Directory path to search. Defaults to current directory.' },
        },
        required: ['pattern'],
      },
    },
  },
  run_shell: {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a simple command in a deny-by-default sandbox. Shell operators, redirects, pipes, env prefixes, launch wrappers, inline code, and network are denied.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Simple command string. No shell operators, redirects, pipes, env prefixes, or command substitution.' },
          argv: {
            type: 'array',
            description: 'Preferred direct argv form. Executed without shell=true after Bash-gate approval.',
            items: { type: 'string' },
          },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped by the bridge.' },
        },
        additionalProperties: false,
      },
    },
  },
  run_command: {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a read-only allowlisted command in the project. Allowed: git status/diff/log/show/rev-parse/ls-files/describe/cat-file, pwd, ls, cat, head, tail, wc. No shell, writes, env exposure, launchers, pipes, or redirects.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Simple read-only command string. No shell operators, redirects, pipes, env prefixes, or command substitution.' },
          argv: {
            type: 'array',
            description: 'Preferred direct argv form. Executed without shell=true after the read-only allowlist and project path jail pass.',
            items: { type: 'string' },
          },
          timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds, capped by the bridge.' },
        },
        additionalProperties: false,
      },
    },
  },
  web_fetch: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a small HTTPS URL through the bridge SSRF guard. Returns metadata only (status, finalUrl, httpStatus, contentType, bytes, truncated, redirectCount) — no body text is delivered. Requires project allowlist; follows redirects manually. truncated:true means the body exceeded the byte cap and was discarded, not delivered.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'HTTPS URL to fetch. No embedded credentials. Host must pass the bridge allowlist and SSRF checks.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web through the bridge-owned guarded HTTPS search endpoint. Returns query, provider, searchUrl, finalUrl, httpStatus, contentType, bytes, truncated, redirectCount, and parsed results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          maxResults: { type: 'number', description: 'Maximum parsed results to return, capped by the bridge.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
};

function namesOf(tools) {
  return tools.map((tool) => tool.function.name);
}

function definitionsByName(tools) {
  return Object.fromEntries(tools.map((tool) => [tool.function.name, tool]));
}

function expectedDefinitionsFor(names) {
  return Object.fromEntries(names.map((name) => [name, EXPECTED_DEFINITIONS[name]]));
}

describe('provider bridge capability manifest', () => {
  it('pins the default provider exposure by name', () => {
    expect(namesOf(bridge.bridgeToolDefinitionsForProviderMode('default'))).toEqual(DEFAULT_TOOL_NAMES);
  });

  it('pins the strict API provider exposure by name', () => {
    expect(namesOf(bridge.bridgeToolDefinitionsForProviderMode('strict-api'))).toEqual(STRICT_API_TOOL_NAMES);
  });

  it('preserves the prior default provider schemas verbatim', () => {
    const definitions = definitionsByName(bridge.bridgeToolDefinitionsForProviderMode('default'));
    expect(definitions).toEqual(expectedDefinitionsFor(DEFAULT_TOOL_NAMES));
  });

  it('preserves the prior strict API provider schemas verbatim', () => {
    const definitions = definitionsByName(bridge.bridgeToolDefinitionsForProviderMode('strict-api'));
    expect(definitions).toEqual(expectedDefinitionsFor(STRICT_API_TOOL_NAMES));
  });

  it('keeps the manifest aligned with the executable bridge registry', () => {
    const manifest = bridge.bridgeToolCapabilityManifest();
    expect(Object.keys(manifest).sort()).toEqual(bridge.bridgeToolRegistryNames());
    expect(bridge.bridgeToolRegistryNames()).toEqual([...new Set([...DEFAULT_TOOL_NAMES, ...STRICT_API_TOOL_NAMES])].sort());
  });

  it('does not expose MCP aliases through any provider mode', () => {
    for (const mode of ['default', 'strict-api', 'unknown-mode']) {
      for (const name of namesOf(bridge.bridgeToolDefinitionsForProviderMode(mode))) {
        expect(name.startsWith('mcp__')).toBe(false);
      }
    }
  });

  it('keeps strict API exposure explicit across write, read, exec, and guarded-network tools', () => {
    const manifest = bridge.bridgeToolCapabilityManifest();
    const strictNames = namesOf(bridge.bridgeToolDefinitionsForProviderMode('strict-api'));
    for (const name of strictNames) {
      expect(manifest[name].exposeStrictApi).toBe(true);
      expect(['write', 'read', 'exec', 'network']).toContain(manifest[name].authority);
      if (manifest[name].authority === 'write') {
        expect(['write_file', 'edit_file']).toContain(name);
        expect(manifest[name].requiresProtectedWriteGate).toBe(true);
        expect(manifest[name].requiresEnforcementWriteGate).toBe(true);
        expect(manifest[name].requiresPathJail).toBe(true);
      } else {
        expect(manifest[name].requiresEnforcementWriteGate).toBe(false);
      }
      if (manifest[name].authority === 'exec') {
        expect(name).toBe('run_shell');
        expect(manifest[name].requiresPermissionGuard).toBe(true);
        expect(manifest[name].requiresSandbox).toBe(true);
        expect(manifest[name].requiresEnforcementExecGate).toBe(true);
      } else {
        expect(manifest[name].requiresEnforcementExecGate).toBe(false);
      }
      if (manifest[name].authority === 'network') {
        expect(['web_fetch', 'web_search']).toContain(name);
        expect(manifest[name].requiresAllowlist).toBe(true);
        expect(manifest[name].requiresSsrfGuard).toBe(true);
        expect(manifest[name].requiresEnforcementFetchGate).toBe(true);
      } else {
        expect(manifest[name].requiresEnforcementFetchGate).toBe(false);
      }
    }
  });

  it('documents capability flags without changing handler policy', () => {
    const manifest = bridge.bridgeToolCapabilityManifest();
    expect(manifest.write_file).toMatchObject({
      authority: 'write',
      exposeDefault: true,
      exposeStrictApi: true,
      requiresProtectedWriteGate: true,
      requiresEnforcementWriteGate: true,
    });
    expect(manifest.edit_file).toMatchObject({
      authority: 'write',
      exposeDefault: true,
      exposeStrictApi: true,
      requiresProtectedWriteGate: true,
      requiresEnforcementWriteGate: true,
    });
    expect(manifest.run_shell).toMatchObject({
      authority: 'exec',
      exposeDefault: true,
      exposeStrictApi: true,
      requiresPermissionGuard: true,
      requiresSandbox: true,
      requiresEnforcementExecGate: true,
    });
    expect(manifest.run_command).toMatchObject({
      authority: 'read',
      exposeDefault: false,
      exposeStrictApi: true,
      requiresReadOnlyAllowlist: true,
    });
    expect(manifest.web_fetch).toMatchObject({
      authority: 'network',
      exposeDefault: true,
      exposeStrictApi: true,
      requiresAllowlist: true,
      requiresSsrfGuard: true,
      requiresEnforcementFetchGate: true,
    });
    expect(manifest.web_search).toMatchObject({
      authority: 'network',
      exposeDefault: true,
      exposeStrictApi: true,
      requiresAllowlist: true,
      requiresSsrfGuard: true,
      requiresEnforcementFetchGate: true,
    });
  });

  it('DO-NOT-REVERT: strict API providers keep write/edit, sandboxed shell, and web grounding tools', () => {
    const strictNames = namesOf(bridge.bridgeToolDefinitionsForProviderMode('strict-api'));
    expect(strictNames).toContain('write_file');
    expect(strictNames).toContain('edit_file');
    expect(strictNames).toContain('run_shell');
    expect(strictNames).toContain('web_fetch');
    expect(strictNames).toContain('web_search');

    fc.assert(
      fc.property(fc.constantFrom('write_file', 'edit_file'), (remoteWriteName) => {
        expect(strictNames).toContain(remoteWriteName);
      }),
      { numRuns: 30 },
    );

    fc.assert(
      fc.property(fc.constantFrom('run_shell'), (sandboxedName) => {
        expect(strictNames).toContain(sandboxedName);
      }),
      { numRuns: 30 },
    );
  });

  it('keeps provider-mode derivation consistent with manifest flags', () => {
    const manifest = bridge.bridgeToolCapabilityManifest();
    const manifestNames = Object.keys(manifest);

    fc.assert(
      fc.property(fc.constantFrom(...manifestNames), (name) => {
        const entry = manifest[name];
        const defaultNames = namesOf(bridge.bridgeToolDefinitionsForProviderMode('default'));
        const strictNames = namesOf(bridge.bridgeToolDefinitionsForProviderMode('strict-api'));

        expect(defaultNames.includes(name)).toBe(entry.exposeDefault);
        expect(strictNames.includes(name)).toBe(entry.exposeStrictApi);
        if (entry.authority === 'write') {
          expect(['write_file', 'edit_file']).toContain(name);
          expect(entry.exposeStrictApi).toBe(true);
          expect(entry.requiresProtectedWriteGate).toBe(true);
          expect(entry.requiresEnforcementWriteGate).toBe(true);
        }
        if (entry.authority === 'exec') {
          expect(entry.exposeStrictApi).toBe(true);
          expect(entry.requiresPermissionGuard).toBe(true);
          expect(entry.requiresSandbox).toBe(true);
        }
        if (entry.authority === 'network') {
          expect(['web_fetch', 'web_search']).toContain(name);
          expect(entry.exposeStrictApi).toBe(true);
          expect(entry.requiresAllowlist).toBe(true);
          expect(entry.requiresSsrfGuard).toBe(true);
          expect(entry.requiresEnforcementFetchGate).toBe(true);
        }
      }),
      { numRuns: 80 },
    );
  });
});
