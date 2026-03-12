/**
 * OpenAPI Tool Registry for MCP
 * Loads OpenAPI specs and registers them as MCP tools
 */

import { Ajv } from 'ajv';
import { OpenApiSpec, OpenApiSchema, isReference } from './openapi-types.js';
import { parseOpenApiSpec, ParsedOperation } from './openapi-parser.js';
import { MCPTool, ToolHandler, ToolContext, ToolCallResult } from './types.js';
import { buildZodSchema } from './zod-validator.js';

export interface OpenApiRegistryOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  validate?: boolean;
}

export class OpenApiToolRegistry {
  private ajv = new Ajv({ allErrors: true, strict: false });
  private tools: Map<string, ParsedOperation> = new Map();

  constructor(private options: OpenApiRegistryOptions = {}) {}

  /**
   * Load an OpenAPI spec and return tool definitions
   */
  public loadSpec(spec: OpenApiSpec | string): MCPTool[] {
    const specObj = typeof spec === 'string' ? JSON.parse(spec) : spec;
    const operations = parseOpenApiSpec(specObj);
    const mcpTools: MCPTool[] = [];

    for (const op of operations) {
      this.tools.set(op.tool.name, op);

      const handler: ToolHandler = async (input, context) => {
        return this.executeOperation(op, input, context);
      };

      const mcpTool: MCPTool = {
        ...op.tool,
        handler,
      };

      mcpTools.push(mcpTool);
    }

    return mcpTools;
  }

  /**
   * Execute an OpenAPI operation
   */
  private async executeOperation(
    op: ParsedOperation,
    input: any,
    context?: ToolContext
  ): Promise<ToolCallResult> {
    // 1. Validate input if enabled
    if (this.options.validate !== false) {
      const validate = this.ajv.compile(op.tool.inputSchema);
      const valid = validate(input);
      if (!valid) {
        return {
          content: [{
            type: 'text',
            text: `Validation failed: ${this.ajv.errorsText(validate.errors)}`
          }],
          isError: true,
        };
      }
    }

    // 2. Build URL and request options
    const baseUrl = this.options.baseUrl || '';
    let urlPath = op.path;
    const queryParams = new URLSearchParams();
    const headers = { ...this.options.headers };
    let body: any = undefined;

    // Map input to path, query, and body
    for (const param of (op.operation.parameters || [])) {
      // Basic ref resolution for parameters
      const p = isReference(param) ? null : param; // Simplified for now
      if (!p) continue;

      if (input[p.name] !== undefined) {
        if (p.in === 'path') {
          urlPath = urlPath.replace(`{${p.name}}`, String(input[p.name]));
        } else if (p.in === 'query') {
          queryParams.append(p.name, String(input[p.name]));
        } else if (p.in === 'header') {
          headers[p.name] = String(input[p.name]);
        }
      }
    }

    // Handle requestBody
    if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers['Content-Type'] = 'application/json';
    } else {
      // If x-pass-as-object was not used, body properties were merged into top level
      // We need to identify which ones belong to the body.
      // This is simplified: we assume anything not in parameters is for body if requestBody exists.
      const paramNames = new Set((op.operation.parameters || []).map(p => isReference(p) ? '' : p.name));
      const bodyObj: Record<string, any> = {};
      let hasBodyData = false;
      
      for (const [key, value] of Object.entries(input)) {
        if (!paramNames.has(key)) {
          bodyObj[key] = value;
          hasBodyData = true;
        }
      }

      if (hasBodyData) {
        body = JSON.stringify(bodyObj);
        headers['Content-Type'] = 'application/json';
      }
    }

    const queryString = queryParams.toString();
    const fullUrl = `${baseUrl}${urlPath}${queryString ? `?${queryString}` : ''}`;

    // 3. Perform the request
    try {
      const controller = new AbortController();
      const timeout = op.tool.timeout || 30000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(fullUrl, {
        method: op.method.toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }

      if (!response.ok) {
        return {
          content: [{
            type: 'text',
            text: `API request failed with status ${response.status}: ${typeof responseData === 'object' ? JSON.stringify(responseData) : responseData}`
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: typeof responseData === 'object' ? JSON.stringify(responseData, null, 2) : String(responseData)
        }],
        isError: false,
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Request error: ${error.message}`
        }],
        isError: true,
      };
    }
  }

  /**
   * Get a Zod schema for a specific tool
   * (As requested in the prompt)
   */
  public getZodSchema(toolName: string, spec: OpenApiSpec): any {
    const op = this.tools.get(toolName);
    if (!op) throw new Error(`Tool ${toolName} not found`);

    const resolveRef = (ref: string): OpenApiSchema => {
      if (ref.startsWith('#/components/schemas/')) {
        const name = ref.split('/').pop()!;
        return spec.components?.schemas?.[name] as OpenApiSchema;
      }
      throw new Error(`Unsupported reference: ${ref}`);
    };

    // We use the inputSchema (JSON Schema) and build a Zod schema from it
    // Note: buildZodSchema expects OpenApiSchema, but our JSONSchema is compatible enough
    return buildZodSchema(op.tool.inputSchema as unknown as OpenApiSchema, resolveRef);
  }
}
