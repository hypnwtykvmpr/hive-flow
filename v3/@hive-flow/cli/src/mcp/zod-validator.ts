/**
 * Zod Schema Generator from OpenAPI Schema
 * Implements strict typing for MCP tool inputs
 */

import { z } from 'zod';
import { OpenApiSchema, OpenApiReference, isReference } from './openapi-types.js';

export type ReferenceResolver = (ref: string) => OpenApiSchema;

export function buildZodSchema(
  schema: OpenApiSchema | OpenApiReference,
  resolveRef: ReferenceResolver,
  depth: number = 0
): z.ZodType<any> {
  // Prevent infinite recursion
  if (depth > 20) {
    throw new Error('Maximum recursion depth reached for OpenAPI schema');
  }

  // Handle references
  if (isReference(schema)) {
    const resolvedSchema = resolveRef(schema.$ref);
    return buildZodSchema(resolvedSchema, resolveRef, depth + 1);
  }

  const { type, properties, items, required, enum: enumValues, oneOf, anyOf, allOf, description } = schema;

  let zodSchema: z.ZodType<any>;

  switch (type) {
    case 'string': {
      let strSchema = z.string();
      if (description) strSchema = strSchema.describe(description) as z.ZodString; // SAFETY: Zod .describe() widens return type
      if (enumValues) {
        zodSchema = z.enum(enumValues as [string, ...string[]]);
      } else {
        zodSchema = strSchema;
      }
      break;
    }
    case 'number':
    case 'integer': {
      let numSchema = type === 'integer' ? z.number().int() : z.number();
      if (description) numSchema = numSchema.describe(description) as z.ZodNumber; // SAFETY: Zod .describe() widens return type
      zodSchema = numSchema;
      break;
    }
    case 'boolean': {
      let boolSchema = z.boolean();
      if (description) boolSchema = boolSchema.describe(description) as z.ZodBoolean; // SAFETY: Zod .describe() widens return type
      zodSchema = boolSchema;
      break;
    }
    case 'array': {
      if (!items) {
        throw new Error('Array schema must have items defined');
      }
      let arraySchema = z.array(buildZodSchema(items, resolveRef, depth + 1));
      if (description) arraySchema = arraySchema.describe(description) as typeof arraySchema; // SAFETY: Zod .describe() widens return type
      zodSchema = arraySchema;
      break;
    }
    case 'object': {
      const shape: Record<string, z.ZodType<any>> = {};
      if (properties) {
        for (const [key, propSchema] of Object.entries(properties)) {
          let propZod = buildZodSchema(propSchema, resolveRef, depth + 1);
          if (!required || !required.includes(key)) {
            propZod = propZod.optional();
          }
          shape[key] = propZod;
        }
      }
      let objSchema = z.object(shape);
      if (description) objSchema = objSchema.describe(description) as typeof objSchema; // SAFETY: Zod .describe() widens return type
      zodSchema = objSchema;
      break;
    }
    default: {
      // Handle logical composition schemas without explicit type
      if (oneOf) {
        zodSchema = z.union(oneOf.map(s => buildZodSchema(s, resolveRef, depth + 1)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]); // SAFETY: OpenAPI oneOf guarantees 2+ schemas
      } else if (anyOf) {
        zodSchema = z.union(anyOf.map(s => buildZodSchema(s, resolveRef, depth + 1)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]); // SAFETY: OpenAPI anyOf guarantees 2+ schemas
      } else if (allOf) {
        // Zod doesn't have a direct allOf (intersection) that works easily for all types,
        // but for objects we can use .merge(). For simplicity here, we use intersection.
        const schemas = allOf.map(s => buildZodSchema(s, resolveRef, depth + 1));
        zodSchema = schemas.reduce((acc, curr) => acc.and(curr));
      } else if (properties) {
          // Fallback to object if properties are present but type is omitted
          return buildZodSchema({ ...schema, type: 'object' }, resolveRef, depth);
      } else {
        throw new Error(`Unsupported or missing type in OpenAPI schema: ${type}`);
      }
    }
  }

  // Handle default values
  if (schema.default !== undefined) {
    zodSchema = zodSchema.default(schema.default);
  }

  return zodSchema;
}
