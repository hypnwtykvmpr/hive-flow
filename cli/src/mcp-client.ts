/**
 * V3 CLI MCP Client
 *
 * Thin wrapper for calling MCP tools from CLI commands.
 * Implements ADR-005: MCP-First API Design - CLI as thin wrapper around MCP tools
 *
 * This provides a simple interface for CLI commands to call MCP tools without
 * containing hardcoded business logic. All business logic lives in MCP tool handlers.
 */

import type { MCPTool } from './mcp-tools/types.js';
import { createHash } from 'node:crypto';

// Import MCP tool handlers from local package
import { agentTools } from './mcp-tools/agent-tools.js';
import { swarmTools } from './mcp-tools/swarm-tools.js';
import { memoryTools } from './mcp-tools/memory-tools.js';
import { configTools } from './mcp-tools/config-tools.js';
import { hooksTools } from './mcp-tools/hooks-tools.js';
import { taskTools } from './mcp-tools/task-tools.js';
import { sessionTools } from './mcp-tools/session-tools.js';
import { hiveMindTools } from './mcp-tools/hive-mind-tools.js';
import { workflowTools } from './mcp-tools/workflow-tools.js';
import { analyzeTools } from './mcp-tools/analyze-tools.js';
import { progressTools } from './mcp-tools/progress-tools.js';
import { embeddingsTools } from './mcp-tools/embeddings-tools.js';
import { claimsTools } from './mcp-tools/claims-tools.js';
import { securityTools } from './mcp-tools/security-tools.js';
import { transferTools } from './mcp-tools/transfer-tools.js';
// V2 Compatibility tools
import { systemTools } from './mcp-tools/system-tools.js';
import { terminalTools } from './mcp-tools/terminal-tools.js';
import { neuralTools } from './mcp-tools/neural-tools.js';
import { performanceTools } from './mcp-tools/performance-tools.js';
import { githubTools } from './mcp-tools/github-tools.js';
import { daaTools } from './mcp-tools/daa-tools.js';
import { coordinationTools } from './mcp-tools/coordination-tools.js';
import { browserTools } from './mcp-tools/browser-tools.js';
// Phase 6: HiveMemory v3 controller tools
import { hivememoryTools } from './mcp-tools/hivememory-tools.js';
// First-class provider tools: Cursor, Codex, Gemini
import { providerTools } from './mcp-tools/provider-tools.js';
import { permissionGuardTools } from './mcp-tools/permission-guard-tools.js';
import { coverageRouterTools } from './hivector/coverage-tools.js';
import { verificationGateTools } from './mcp-tools/verification-gate.js';
import { planningSubflowTools } from './mcp-tools/planning-subflow.js';
import { bugHunterTools } from './mcp-tools/bug-hunter.js';
import { workflowEnforcerTools } from './mcp-tools/workflow-enforcer.js';
import { queenTools } from './mcp-tools/queen-tools.js';
import { advocateTools } from './mcp-tools/advocate-tools.js';
import { checkMCPEnforcement, checkModelEnforcement } from './mcp-tools/mcp-enforcement-gate.js';
import { normalizeClientKind, operatorSessionEnvKeys, resolveClientKindFromEnv } from './mcp-tools/session-id.js';

/**
 * MCP Tool Registry
 * Maps tool names to their handler functions
 */
const TOOL_REGISTRY = new Map<string, MCPTool>();

// SEC-013: Registry freeze flag — prevents runtime tool injection after initialization
let _registryFrozen = false;

// Register all tools
function registerTools(tools: MCPTool[]): void {
  if (_registryFrozen) {
    throw new Error('[SEC-013] TOOL_REGISTRY is frozen — cannot register tools after initialization');
  }
  tools.forEach(tool => {
    TOOL_REGISTRY.set(tool.name, tool);
  });
}

// Initialize registry with all available tools
registerTools([
  ...agentTools,
  ...swarmTools,
  ...memoryTools,
  ...configTools,
  ...hooksTools,
  ...taskTools,
  ...sessionTools,
  ...hiveMindTools,
  ...workflowTools,
  ...analyzeTools,
  ...progressTools,
  ...embeddingsTools,
  ...claimsTools,
  ...securityTools,
  ...transferTools,
  // V2 Compatibility tools
  ...systemTools,
  ...terminalTools,
  ...neuralTools,
  ...performanceTools,
  ...githubTools,
  ...daaTools,
  ...coordinationTools,
  ...browserTools,
  // Phase 6: HiveMemory v3 controller tools
  ...hivememoryTools,
  // First-class provider tools: Cursor, Codex, Gemini
  ...providerTools,
  ...permissionGuardTools,
  ...coverageRouterTools,
  // Verification workflow tools
  ...verificationGateTools,
  ...planningSubflowTools,
  ...bugHunterTools,
  // Workflow enforcement tools
  ...workflowEnforcerTools,
  // Queen protocol tools (hive management)
  ...queenTools,
  ...advocateTools,
]);

// SEC-013: Freeze registry after initialization — no further tool registration allowed
_registryFrozen = true;

/**
 * MCP Client Error
 */
export class MCPClientError extends Error {
  constructor(
    message: string,
    public toolName: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'MCPClientError';
  }
}

/**
 * Call an MCP tool by name with input parameters
 *
 * @param toolName - Name of the MCP tool (e.g., 'agent_spawn', 'swarm_init')
 * @param input - Input parameters for the tool
 * @param context - Optional tool context
 * @returns Promise resolving to tool result
 * @throws {MCPClientError} If tool not found or execution fails
 *
 * @example
 * ```typescript
 * // Spawn an agent
 * const result = await callMCPTool('agent_spawn', {
 *   agentType: 'implementer',
 *   task: 'Build the feature behind this issue'
 * });
 *
 * // Initialize swarm
 * const swarm = await callMCPTool('swarm_init', {
 *   topology: 'hierarchical-mesh',
 *   maxAgents: 150
 * });
 * ```
 */
// SEC-014: Input size limits to prevent denial-of-service via oversized payloads
const MAX_FIELD_BYTES = 1 * 1024 * 1024;    // 1MB per field
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;    // 5MB total serialized input

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasSessionIdentity(context: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    operatorSessionEnvKeys().some((key) => nonEmpty(process.env[key]))
    || nonEmpty(context?.session_id)
    || nonEmpty(context?.sessionId)
  );
}

function hasClientKind(context: Record<string, unknown> | null | undefined): boolean {
  return Boolean(
    nonEmpty(process.env.HIVE_FLOW_CLIENT_KIND)
    || nonEmpty(context?.client_kind)
    || nonEmpty(context?.clientKind)
  );
}

function inferClientKind(): string {
  const explicit = normalizeClientKind(process.env.HIVE_FLOW_CLIENT_KIND);
  if (explicit !== 'unknown') return explicit;
  const envKind = resolveClientKindFromEnv(process.env);
  if (envKind !== 'unknown') return envKind;
  // A standalone CLI invocation still needs an owner lane. Claude is the
  // default operator lane for local/global installs when no richer host signal
  // exists, matching the statusboard notification fallback.
  return 'claude';
}

function defaultCliSessionId(): string {
  const root = nonEmpty(process.env.HIVE_FLOW_PROJECT_ROOT)
    || nonEmpty(process.env.CLAUDE_PROJECT_DIR)
    || process.cwd();
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return `cli-${digest}`;
}

export function buildDefaultMCPContext(
  context: Record<string, unknown> | null | undefined = undefined,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...(context ?? {}) };
  if (!hasSessionIdentity(context)) {
    enriched.sessionId = defaultCliSessionId();
  }
  if (!hasClientKind(context)) {
    enriched.clientKind = inferClientKind();
  }
  return enriched;
}

export async function callMCPTool<T = unknown>(
  toolName: string,
  input: Record<string, unknown> = {},
  context?: Record<string, unknown>
): Promise<T> {
  // SEC-014: Input length validation before any processing
  const serialized = JSON.stringify(input);
  if (serialized.length > MAX_TOTAL_BYTES) {
    throw new MCPClientError(
      `Input too large: ${serialized.length} bytes exceeds ${MAX_TOTAL_BYTES} byte limit`,
      toolName
    );
  }
  for (const [fieldKey, fieldValue] of Object.entries(input)) {
    if (typeof fieldValue === 'string' && fieldValue.length > MAX_FIELD_BYTES) {
      throw new MCPClientError(
        `Field '${fieldKey}' too large: ${fieldValue.length} bytes exceeds ${MAX_FIELD_BYTES} byte limit`,
        toolName
      );
    }
  }

  // Enforcement gate: check if tool is allowed at current enforcement level
  const enforcement = checkMCPEnforcement(toolName);
  if (!enforcement.allowed) {
    throw new MCPClientError(
      enforcement.reason || `MCP tool '${toolName}' blocked by enforcement`,
      toolName
    );
  }

  // Model enforcement gate: block prohibited models, apply defaults
  const modelEnforcement = checkModelEnforcement(toolName, input);
  if (!modelEnforcement.allowed) {
    throw new MCPClientError(modelEnforcement.reason || 'Blocked by model enforcement', toolName);
  }
  const effectiveInput = modelEnforcement.correctedInput ?? input;

  // Look up tool in registry
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    throw new MCPClientError(
      `MCP tool not found: ${toolName}`,
      toolName
    );
  }

  try {
    // Call the tool handler
    const result = await tool.handler(effectiveInput, buildDefaultMCPContext(context));
    return result as T;
  } catch (error) {
    // Wrap and re-throw with context
    throw new MCPClientError(
      `Failed to execute MCP tool '${toolName}': ${error instanceof Error ? error.message : String(error)}`,
      toolName,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Get tool metadata by name
 *
 * @param toolName - Name of the MCP tool
 * @returns Tool metadata or undefined if not found
 */
export function getToolMetadata(toolName: string): Omit<MCPTool, 'handler'> | undefined {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return undefined;
  }

  // Return everything except the handler function
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  };
}

/**
 * List all available MCP tools
 *
 * @param category - Optional category filter
 * @returns Array of tool metadata
 */
export function listMCPTools(category?: string): Array<Omit<MCPTool, 'handler'>> {
  const tools = Array.from(TOOL_REGISTRY.values());

  const filtered = category
    ? tools.filter(t => t.category === category)
    : tools;

  return filtered.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    category: tool.category,
    tags: tool.tags,
    version: tool.version,
    cacheable: tool.cacheable,
    cacheTTL: tool.cacheTTL,
  }));
}

/**
 * Check if an MCP tool exists
 *
 * @param toolName - Name of the MCP tool
 * @returns True if tool exists
 */
export function hasTool(toolName: string): boolean {
  return TOOL_REGISTRY.has(toolName);
}

/**
 * Get all tool categories
 *
 * @returns Array of unique categories
 */
export function getToolCategories(): string[] {
  const categories = new Set<string>();

  TOOL_REGISTRY.forEach(tool => {
    if (tool.category) {
      categories.add(tool.category);
    }
  });

  return Array.from(categories).sort();
}

/**
 * Validate tool input against schema
 *
 * @param toolName - Name of the MCP tool
 * @param input - Input to validate
 * @returns Validation result with errors if any
 */
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { valid: boolean; errors?: string[] } {
  const tool = TOOL_REGISTRY.get(toolName);

  if (!tool) {
    return {
      valid: false,
      errors: [`Tool '${toolName}' not found`],
    };
  }

  // Basic validation - check required fields
  const schema = tool.inputSchema;
  const errors: string[] = [];

  if (schema.required && Array.isArray(schema.required)) {
    for (const requiredField of schema.required) {
      if (!(requiredField in input)) {
        errors.push(`Missing required field: ${requiredField}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}

export default {
  callMCPTool,
  getToolMetadata,
  listMCPTools,
  hasTool,
  getToolCategories,
  validateToolInput,
  MCPClientError,
};
