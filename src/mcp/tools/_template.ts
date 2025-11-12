/**
 * Tool Template for Filesystem-Based Tool Discovery
 *
 * This template provides the structure for individual MCP tools
 * following the progressive disclosure pattern.
 *
 * Usage:
 * 1. Copy this file to appropriate category directory
 * 2. Rename to match tool name (e.g., spawn.ts for agents/spawn)
 * 3. Update all [PLACEHOLDER] values
 * 4. Implement handler logic
 */

import type { MCPTool, ClaudeFlowToolContext } from '../types.js';
import type { ILogger } from '../../interfaces/logger.js';

/**
 * Input interface for this tool
 * Define strongly-typed input parameters
 */
interface [ToolName]Input {
  // Define input properties with types
  // Example:
  // name: string;
  // config?: Record<string, unknown>;
}

/**
 * Result interface for this tool
 * Define strongly-typed return value
 */
interface [ToolName]Result {
  success: boolean;
  // Define result properties
  // Example:
  // resourceId: string;
  // status: string;
}

/**
 * Create [Tool Description] tool
 *
 * @param logger - Logger instance for structured logging
 * @returns MCPTool definition
 */
export function create[ToolName]Tool(logger: ILogger): MCPTool {
  return {
    name: '[namespace]/[toolname]',
    description: '[Detailed description of what this tool does and when to use it]',

    inputSchema: {
      type: 'object',
      properties: {
        // Define JSON schema for input validation
        // Example:
        // name: {
        //   type: 'string',
        //   description: 'Resource name',
        //   minLength: 1,
        //   maxLength: 100,
        // },
      },
      required: [], // List required properties
    },

    // Optional: Metadata for progressive disclosure
    metadata: {
      category: '[category]', // agents, tasks, memory, system, etc.
      tags: ['tag1', 'tag2'], // Searchable tags
      examples: [
        {
          description: 'Example usage scenario',
          input: {
            // Example input object
          },
          expectedOutput: {
            // Expected result object
          },
        },
      ],
      detailLevel: 'standard', // 'basic' | 'standard' | 'full'
    },

    /**
     * Tool execution handler
     *
     * @param input - Validated input parameters
     * @param context - Tool execution context with orchestrator, etc.
     * @returns Tool result
     */
    handler: async (
      input: any,
      context?: ClaudeFlowToolContext
    ): Promise<[ToolName]Result> => {
      // Validate context availability
      if (!context?.orchestrator) {
        throw new Error('Orchestrator not available in tool context');
      }

      // Cast input to typed interface
      const validatedInput = input as [ToolName]Input;

      // Log tool invocation
      logger.info('[namespace]/[toolname] invoked', {
        input: validatedInput,
        sessionId: context.sessionId,
      });

      try {
        // ============================================
        // IMPLEMENT TOOL LOGIC HERE
        // ============================================

        // Example:
        // const result = await context.orchestrator.someMethod(validatedInput);

        // ============================================
        // END TOOL LOGIC
        // ============================================

        // Log success
        logger.info('[namespace]/[toolname] completed successfully', {
          input: validatedInput,
        });

        return {
          success: true,
          // Include result data
        };
      } catch (error) {
        // Log error
        logger.error('[namespace]/[toolname] failed', {
          error,
          input: validatedInput,
        });

        // Re-throw for MCP error handling
        throw error;
      }
    },
  };
}

/**
 * Export lightweight metadata for tool discovery
 * This is loaded without executing the full tool definition
 */
export const toolMetadata = {
  name: '[namespace]/[toolname]',
  description: '[Brief one-line description]',
  category: '[category]',
  detailLevel: 'standard' as const,
};
