// cli/src/integrations/variant-detection.ts
import { parse, parseTree, findNodeAtLocation } from 'jsonc-parser';
import { readTextIfExists } from './atomic-merge.js';

/** Generate variant spellings of a canonical kebab-case key. Pure function for unit testing. */
export function generateVariants(canonical: string): string[] {
  const parts = canonical.split('-');
  const pascal = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  const camel  = parts.map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return Array.from(new Set([
    canonical.toUpperCase(),                                                          // HIVE-FLOW
    canonical.toUpperCase().replace(/-/g, '_'),                                       // HIVE_FLOW
    canonical.replace(/-/g, '_'),                                                     // hive_flow
    pascal,                                                                           // HiveFlow
    camel,                                                                            // hiveFlow
    canonical.toLowerCase().replace(/[-_]/g, ''),                                     // hiveflow
    parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-'),                 // Hive-Flow
    parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('_'),                 // Hive_Flow
  ])).filter(v => v !== canonical);
}

/** Public API — dispatches on file extension. Matches the test signature at §12.3. */
export async function detectVariants(filePath: string, parentPath: string, canonical: string): Promise<string[]> {
  if (/\.toml$/i.test(filePath))           return detectTomlVariants(filePath, parentPath, canonical);
  if (/\.(jsonc?|json5)$/i.test(filePath)) return detectJsonVariants(filePath, parentPath, canonical);
  return [];
}

async function detectJsonVariants(filePath: string, parentDotted: string, canonical: string): Promise<string[]> {
  const text = await readTextIfExists(filePath);
  if (text === null) return [];
  const tree = parse(text, [], { allowTrailingComma: true });
  let cur: any = tree;
  for (const p of parentDotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return [];
    cur = cur[p];
  }
  if (cur == null || typeof cur !== 'object') return [];
  const variants = new Set(generateVariants(canonical));
  const variantHits = Object.keys(cur).filter(k => variants.has(k));

  // Supplemental scan for duplicate canonical keys (Codex pass-4 additional correctness).
  // `jsonc-parser.parse()` collapses duplicate object keys to last-value, so a file with two
  // `"hive-flow":` entries under the same parent presents as one in the parsed tree.
  // Scope the regex scan to the parent object's substring (via parseTree + findNodeAtLocation)
  // so we don't false-positive on `"hive-flow"` appearing as a value, in a comment, or under
  // a different parent.
  const tn = parseTree(text, [], { allowTrailingComma: true });
  const parentNode = tn ? findNodeAtLocation(tn, parentDotted.split('.')) : undefined;
  if (parentNode && parentNode.offset !== undefined && parentNode.length !== undefined) {
    const parentText = text.slice(parentNode.offset, parentNode.offset + parentNode.length);
    const escCanonical = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const canonicalKeyRe = new RegExp(`"${escCanonical}"\\s*:`, 'g');
    const canonicalOccurrences = (parentText.match(canonicalKeyRe) ?? []).length;
    if (canonicalOccurrences > 1) return [canonical, ...variantHits];
  }
  return variantHits;
}

async function detectTomlVariants(filePath: string, parentDotted: string, canonical: string): Promise<string[]> {
  const text = await readTextIfExists(filePath);
  if (text === null) return [];
  // Match `[parent.<name>]` and array-of-tables `[[parent.<name>]]` headers via String.prototype.matchAll.
  const escapedParent = parentDotted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*\\[\\[?${escapedParent}\\.([^\\]\\s.]+)\\]\\]?\\s*$`, 'gm');
  const variants = new Set(generateVariants(canonical));
  const found = new Set<string>();
  for (const match of text.matchAll(re)) {
    if (variants.has(match[1])) found.add(match[1]);
  }
  return Array.from(found);
}
