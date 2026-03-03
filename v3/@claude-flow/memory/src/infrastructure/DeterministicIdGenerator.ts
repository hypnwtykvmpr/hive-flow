import { createHash } from 'node:crypto';
import { MemoryType } from '../types.js';

/**
 * Deterministic ID Generator for Memory Entries
 * 
 * Generates stable, content-addressable IDs using SHA-256 hashes.
 * Formula: hash(namespace + type + key + content + stable_metadata)
 */
export class DeterministicIdGenerator {
  /**
   * Generates a deterministic ID for a memory entry
   * 
   * @param namespace - The namespace for organization
   * @param type - The type of memory
   * @param key - Human-readable key
   * @param content - Actual content of the memory
   * @param metadata - Optional metadata for additional stability
   * @returns A stable hexadecimal ID
   */
  public static generateId(
    namespace: string,
    type: MemoryType,
    key: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): string {
    const hash = createHash('sha256');
    
    // Combine core fields for hashing
    hash.update(namespace);
    hash.update(':');
    hash.update(type);
    hash.update(':');
    hash.update(key);
    hash.update(':');
    hash.update(content);
    
    // Add stable metadata if present (sorted keys for determinism)
    if (Object.keys(metadata).length > 0) {
      hash.update(':');
      const sortedKeys = Object.keys(metadata).sort();
      for (const k of sortedKeys) {
        const val = metadata[k];
        if (val !== undefined && val !== null) {
          hash.update(k);
          hash.update('=');
          hash.update(typeof val === 'object' ? JSON.stringify(val) : String(val));
        }
      }
    }
    
    return hash.digest('hex');
  }

  /**
   * Generates a prefixed ID for use in the system
   * 
   * @param namespace - The namespace for organization
   * @param type - The type of memory
   * @param key - Human-readable key
   * @param content - Actual content of the memory
   * @returns A prefixed stable hexadecimal ID
   */
  public static generatePrefixedId(
    namespace: string,
    type: MemoryType,
    key: string,
    content: string
  ): string {
    const id = this.generateId(namespace, type, key, content);
    return `mem_${id.substring(0, 16)}`;
  }
}
