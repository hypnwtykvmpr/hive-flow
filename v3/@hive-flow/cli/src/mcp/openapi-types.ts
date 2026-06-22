/**
 * OpenAPI 3.0 Types for MCP Tool Generation
 * Based on OpenAPI Specification v3.0.3
 */

export interface OpenApiSpec {
  openapi: string;
  info: OpenApiInfo;
  paths: OpenApiPaths;
  components?: OpenApiComponents;
  servers?: OpenApiServer[];
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiPaths {
  [path: string]: OpenApiPathItem;
}

export interface OpenApiPathItem {
  get?: OpenApiOperation;
  put?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  patch?: OpenApiOperation;
  trace?: OpenApiOperation;
  parameters?: (OpenApiParameter | OpenApiReference)[];
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: (OpenApiParameter | OpenApiReference)[];
  requestBody?: OpenApiRequestBody | OpenApiReference;
  responses: OpenApiResponses;
  deprecated?: boolean;
  // Custom extensions
  'x-timeout'?: number;
  'x-pass-as-object'?: boolean;
  'x-annotations'?: Record<string, any>;
}

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: OpenApiSchema | OpenApiReference;
}

export interface OpenApiRequestBody {
  description?: string;
  content: {
    [contentType: string]: OpenApiMediaType;
  };
  required?: boolean;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema | OpenApiReference;
}

export interface OpenApiResponses {
  [statusCode: string]: OpenApiResponse | OpenApiReference;
}

export interface OpenApiResponse {
  description: string;
  content?: {
    [contentType: string]: OpenApiMediaType;
  };
}

export interface OpenApiComponents {
  schemas?: { [key: string]: OpenApiSchema | OpenApiReference };
  parameters?: { [key: string]: OpenApiParameter | OpenApiReference };
  requestBodies?: { [key: string]: OpenApiRequestBody | OpenApiReference };
}

export interface OpenApiReference {
  $ref: string;
}

export interface OpenApiSchema {
  type?: string;
  properties?: { [key: string]: OpenApiSchema | OpenApiReference };
  items?: OpenApiSchema | OpenApiReference;
  required?: string[];
  description?: string;
  enum?: any[];
  default?: any;
  format?: string;
  oneOf?: (OpenApiSchema | OpenApiReference)[];
  anyOf?: (OpenApiSchema | OpenApiReference)[];
  allOf?: (OpenApiSchema | OpenApiReference)[];
}

export function isReference(obj: any): obj is OpenApiReference {
  return typeof obj === 'object' && obj !== null && '$ref' in obj;
}
