/**
 * @claude-flow/mcp - Resource Registry
 *
 * MCP 2025-11-25 compliant resource management
 * Supports: list, read, subscribe, templates, pagination
 */

import { EventEmitter } from 'events';
import type {
  MCPResource,
  ResourceContent,
  ResourceTemplate,
  ResourceListResult,
  ResourceReadResult,
  ILogger,
  ContentAnnotations,
} from './types.js';

export type ResourceHandler = (uri: string) => Promise<ResourceContent[]>;
export type SubscriptionCallback = (uri: string, content: ResourceContent[]) => void;

export interface ResourceRegistryOptions {
  enableSubscriptions?: boolean;
  maxSubscriptionsPerResource?: number;
  cacheEnabled?: boolean;
  cacheTTL?: number;
}

interface CachedResource {
  content: ResourceContent[];
  cachedAt: number;
  ttl: number;
}

interface Subscription {
  id: string;
  uri: string;
  callback: SubscriptionCallback;
  createdAt: Date;
}

export class ResourceRegistry extends EventEmitter {
  private resources: Map<string, MCPResource> = new Map();
  private templates: Map<string, ResourceTemplate> = new Map();
  private handlers: Map<string, ResourceHandler> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map();
  private cache: Map<string, CachedResource> = new Map();
  private subscriptionCounter = 0;

  private readonly options: Required<ResourceRegistryOptions>;

  constructor(
    private readonly logger: ILogger,
    options: ResourceRegistryOptions = {}
  ) {
    super();
    this.options = {
      enableSubscriptions: options.enableSubscriptions ?? true,
      maxSubscriptionsPerResource: options.maxSubscriptionsPerResource ?? 100,
      cacheEnabled: options.cacheEnabled ?? true,
      cacheTTL: options.cacheTTL ?? 60000, // 1 minute default
    };
  }

  /**
   * Register a static resource
   */
  registerResource(resource: MCPResource, handler: ResourceHandler): boolean {
    if (this.resources.has(resource.uri)) {
      this.logger.warn('Resource already registered', { uri: resource.uri });
      return false;
    }

    this.resources.set(resource.uri, resource);
    this.handlers.set(resource.uri, handler);

    this.logger.debug('Resource registered', { uri: resource.uri, name: resource.name });
    this.emit('resource:registered', { uri: resource.uri });
    this.emitListChanged();

    return true;
  }

  /**
   * Register a resource template (dynamic URIs)
   */
  registerTemplate(template: ResourceTemplate, handler: ResourceHandler): boolean {
    if (this.templates.has(template.uriTemplate)) {
      this.logger.warn('Template already registered', { template: template.uriTemplate });
      return false;
    }

    this.templates.set(template.uriTemplate, template);
    this.handlers.set(template.uriTemplate, handler);

    this.logger.debug('Resource template registered', { template: template.uriTemplate });
    this.emit('template:registered', { template: template.uriTemplate });

    return true;
  }

  /**
   * Unregister a resource
   */
  unregisterResource(uri: string): boolean {
    if (!this.resources.has(uri)) {
      return false;
    }

    this.resources.delete(uri);
    this.handlers.delete(uri);
    this.cache.delete(uri);

    // Cancel subscriptions for this resource
    const subs = this.subscriptions.get(uri) || [];
    for (const sub of subs) {
      this.emit('subscription:cancelled', { subscriptionId: sub.id, uri });
    }
    this.subscriptions.delete(uri);

    this.logger.debug('Resource unregistered', { uri });
    this.emit('resource:unregistered', { uri });
    this.emitListChanged();

    return true;
  }

  /**
   * List resources with pagination
   */
  list(cursor?: string, pageSize: number = 50): ResourceListResult {
    const allResources = Array.from(this.resources.values());

    let startIndex = 0;
    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      startIndex = decoded.offset;
    }

    const endIndex = Math.min(startIndex + pageSize, allResources.length);
    const resources = allResources.slice(startIndex, endIndex);

    const result: ResourceListResult = { resources };

    if (endIndex < allResources.length) {
      result.nextCursor = this.encodeCursor({ offset: endIndex });
    }

    return result;
  }

  /**
   * Read resource content
   */
  async read(uri: string): Promise<ResourceReadResult> {
    // Check cache first
    if (this.options.cacheEnabled) {
      const cached = this.cache.get(uri);
      if (cached && Date.now() - cached.cachedAt < cached.ttl) {
        this.logger.debug('Resource cache hit', { uri });
        return { contents: cached.content };
      }
    }

    // Find handler (exact match or template match)
    let handler = this.handlers.get(uri);
    if (!handler) {
      handler = this.findTemplateHandler(uri);
    }

    if (!handler) {
      throw new Error(`Resource not found: ${uri}`);
    }

    const contents = await handler(uri);

    // Cache the result
    if (this.options.cacheEnabled) {
      this.cache.set(uri, {
        content: contents,
        cachedAt: Date.now(),
        ttl: this.options.cacheTTL,
      });
    }

    this.emit('resource:read', { uri, contentCount: contents.length });
    return { contents };
  }

  /**
   * Subscribe to resource updates
   */
  subscribe(uri: string, callback: SubscriptionCallback): string {
    if (!this.options.enableSubscriptions) {
      throw new Error('Subscriptions are disabled');
    }

    const existingSubs = this.subscriptions.get(uri) || [];
    if (existingSubs.length >= this.options.maxSubscriptionsPerResource) {
      throw new Error(`Maximum subscriptions reached for resource: ${uri}`);
    }

    const subscriptionId = `sub-${++this.subscriptionCounter}-${Date.now()}`;
    const subscription: Subscription = {
      id: subscriptionId,
      uri,
      callback,
      createdAt: new Date(),
    };

    existingSubs.push(subscription);
    this.subscriptions.set(uri, existingSubs);

    this.logger.debug('Subscription created', { subscriptionId, uri });
    this.emit('subscription:created', { subscriptionId, uri });

    return subscriptionId;
  }

  /**
   * Unsubscribe from resource updates
   */
  unsubscribe(subscriptionId: string): boolean {
    for (const [uri, subs] of this.subscriptions) {
      const index = subs.findIndex((s) => s.id === subscriptionId);
      if (index !== -1) {
        subs.splice(index, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(uri);
        }
        this.logger.debug('Subscription removed', { subscriptionId, uri });
        this.emit('subscription:removed', { subscriptionId, uri });
        return true;
      }
    }
    return false;
  }

  /**
   * Notify subscribers of resource update
   */
  async notifyUpdate(uri: string): Promise<void> {
    const subs = this.subscriptions.get(uri);
    if (!subs || subs.length === 0) {
      return;
    }

    // Invalidate cache
    this.cache.delete(uri);

    // Read fresh content
    const { contents } = await this.read(uri);

    // Notify all subscribers
    for (const sub of subs) {
      try {
        sub.callback(uri, contents);
      } catch (error) {
        this.logger.error('Subscription callback error', { subscriptionId: sub.id, error });
      }
    }

    this.emit('resource:updated', { uri, subscriberCount: subs.length });
  }

  /**
   * Get resource by URI
   */
  getResource(uri: string): MCPResource | undefined {
    return this.resources.get(uri);
  }

  /**
   * Check if resource exists
   */
  hasResource(uri: string): boolean {
    return this.resources.has(uri) || this.matchesTemplate(uri);
  }

  /**
   * Get resource count
   */
  getResourceCount(): number {
    return this.resources.size;
  }

  /**
   * Get all templates
   */
  getTemplates(): ResourceTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get subscription count for a resource
   */
  getSubscriptionCount(uri: string): number {
    return this.subscriptions.get(uri)?.length || 0;
  }

  /**
   * Get stats
   */
  getStats(): {
    totalResources: number;
    totalTemplates: number;
    totalSubscriptions: number;
    cacheSize: number;
  } {
    let totalSubscriptions = 0;
    for (const subs of this.subscriptions.values()) {
      totalSubscriptions += subs.length;
    }

    return {
      totalResources: this.resources.size,
      totalTemplates: this.templates.size,
      totalSubscriptions,
      cacheSize: this.cache.size,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('Resource cache cleared');
  }

  /**
   * Find handler for template URI
   */
  private findTemplateHandler(uri: string): ResourceHandler | undefined {
    for (const [template, handler] of this.handlers) {
      if (this.matchesTemplate(uri, template)) {
        return handler;
      }
    }
    return undefined;
  }

  /**
   * Check if URI matches any template
   */
  private matchesTemplate(uri: string, template?: string): boolean {
    if (template) {
      // Simple template matching (supports {param} style)
      const regex = new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$');
      return regex.test(uri);
    }

    for (const t of this.templates.keys()) {
      const regex = new RegExp('^' + t.replace(/\{[^}]+\}/g, '[^/]+') + '$');
      if (regex.test(uri)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Encode cursor for pagination
   */
  private encodeCursor(data: { offset: number }): string {
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }

  /**
   * Decode cursor for pagination
   */
  private decodeCursor(cursor: string): { offset: number } {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
    } catch {
      return { offset: 0 };
    }
  }

  /**
   * Emit listChanged notification
   */
  private emitListChanged(): void {
    this.emit('resources:listChanged');
  }
}

export function createResourceRegistry(
  logger: ILogger,
  options?: ResourceRegistryOptions
): ResourceRegistry {
  return new ResourceRegistry(logger, options);
}

/**
 * Helper to create a static text resource
 */
export function createTextResource(
  uri: string,
  name: string,
  text: string,
  options?: {
    description?: string;
    mimeType?: string;
    annotations?: ContentAnnotations;
  }
): { resource: MCPResource; handler: ResourceHandler } {
  const resource: MCPResource = {
    uri,
    name,
    description: options?.description,
    mimeType: options?.mimeType || 'text/plain',
    annotations: options?.annotations,
  };

  const handler: ResourceHandler = async () => [
    {
      uri,
      mimeType: options?.mimeType || 'text/plain',
      text,
    },
  ];

  return { resource, handler };
}

/**
 * Helper to create a file resource
 */
export function createFileResource(
  uri: string,
  name: string,
  filePath: string,
  options?: {
    description?: string;
    mimeType?: string;
  }
): { resource: MCPResource; handler: ResourceHandler } {
  const resource: MCPResource = {
    uri,
    name,
    description: options?.description,
    mimeType: options?.mimeType || 'application/octet-stream',
  };

  const handler: ResourceHandler = async () => {
    const fs = await import('fs/promises');
    const content = await fs.readFile(filePath);
    return [
      {
        uri,
        mimeType: options?.mimeType || 'application/octet-stream',
        blob: content.toString('base64'),
      },
    ];
  };

  return { resource, handler };
}
