/**
 * OpenAPI 3.0 Parser for MCP
 * Converts OpenAPI operations to MCP tool definitions
 */

import {
  OpenApiSpec,
  OpenApiOperation,
  OpenApiComponents,
  OpenApiParameter,
  OpenApiSchema,
  OpenApiReference,
  isReference,
} from './openapi-types.js';
import { MCPTool, JSONSchema } from './types.js';

export interface ParsedOperation {
  path: string;
  method: string;
  operation: OpenApiOperation;
  tool: Omit<MCPTool, 'handler'>;
}

export function parseOpenApiSpec(spec: OpenApiSpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const methods = ['get', 'post', 'put', 'delete', 'patch'] as const;

    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      const toolName = operation.operationId || 
        `${method}${path.replace(/\//g, '_').replace(/[{}]/g, '')}`;
      
      const description = operation.summary || operation.description || `Tool for ${method.toUpperCase()} ${path}`;

      // Combine parameters and requestBody into inputSchema
      const inputSchema = buildInputSchema(operation, spec);

      const tool: Omit<MCPTool, 'handler'> = {
        name: toolName,
        description,
        inputSchema,
        timeout: operation['x-timeout'],
        deprecated: operation.deprecated,
        tags: operation['tags'] || [],
      };

      // Handle custom x-annotations as extra tags for now
      if (operation['x-annotations']) {
        if (!tool.tags) tool.tags = [];
        for (const [key, value] of Object.entries(operation['x-annotations'])) {
          tool.tags.push(`${key}:${value}`);
        }
      }

      operations.push({
        path,
        method,
        operation,
        tool,
      });
    }
  }

  return operations;
}

function buildInputSchema(operation: OpenApiOperation, spec: OpenApiSpec): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  // Handle parameters (query, path, header)
  if (operation.parameters) {
    for (const param of operation.parameters) {
      const resolvedParam = resolveReference<OpenApiParameter>(param, spec, 'parameters');
      if (!resolvedParam) continue;

      const schema = resolvedParam.schema ? 
        convertToJSONSchema(resolvedParam.schema, spec) : 
        { type: 'string' };

      properties[resolvedParam.name] = {
        ...schema,
        description: resolvedParam.description || schema.description,
      };

      if (resolvedParam.required) {
        required.push(resolvedParam.name);
      }
    }
  }

  // Handle requestBody
  if (operation.requestBody) {
    const resolvedBody = resolveReference<any>(operation.requestBody, spec, 'requestBodies');
    const content = resolvedBody?.content?.['application/json'];
    if (content?.schema) {
      const bodySchema = convertToJSONSchema(content.schema, spec);
      
      if (operation['x-pass-as-object']) {
        // If x-pass-as-object is true, we might want to nest it or merge it.
        // Usually it means the entire body is passed as the 'body' parameter
        properties['body'] = bodySchema;
        if (resolvedBody.required) required.push('body');
      } else if (bodySchema.type === 'object' && bodySchema.properties) {
        // Merge body properties into top level
        Object.assign(properties, bodySchema.properties);
        if (bodySchema.required) {
          required.push(...bodySchema.required);
        }
      } else {
        properties['body'] = bodySchema;
        if (resolvedBody.required) required.push('body');
      }
    }
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function convertToJSONSchema(schema: OpenApiSchema | OpenApiReference, spec: OpenApiSpec): JSONSchema {
  const resolved = resolveReference<OpenApiSchema>(schema, spec, 'schemas');
  if (!resolved) return { type: 'object' };

  const jsonSchema: JSONSchema = {
    type: resolved.type || 'object',
    description: resolved.description,
    default: resolved.default,
    enum: resolved.enum,
  };

  if (resolved.properties) {
    jsonSchema.properties = {};
    for (const [key, prop] of Object.entries(resolved.properties)) {
      jsonSchema.properties[key] = convertToJSONSchema(prop, spec);
    }
  }

  if (resolved.required) {
    jsonSchema.required = resolved.required;
  }

  if (resolved.items) {
    jsonSchema.items = convertToJSONSchema(resolved.items, spec);
  }

  return jsonSchema;
}

function resolveReference<T>(obj: T | OpenApiReference, spec: OpenApiSpec, type: keyof OpenApiComponents): T | null {
  if (!isReference(obj)) return obj as T;

  const ref = obj.$ref;
  if (ref.startsWith('#/components/')) {
    const parts = ref.split('/');
    const componentType = parts[2] as keyof OpenApiComponents;
    const name = parts[3];
    return (spec.components?.[componentType]?.[name] as unknown as T) || null;
  }

  return null; // Remote refs not supported for now
}
