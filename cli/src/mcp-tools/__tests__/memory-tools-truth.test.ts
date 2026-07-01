import { describe, expect, it } from 'vitest';
import { memoryTools } from '../memory-tools.js';

function metadata(name: string) {
  const tool = memoryTools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`missing memory tool ${name}`);
  return {
    description: tool.description,
  };
}

describe('memory MCP tool truth labels', () => {
  it('does not describe the fallback memory path as unconditional HNSW', () => {
    const rendered = JSON.stringify(memoryTools.map(tool => ({
      name: tool.name,
      description: tool.description,
    })));

    expect(rendered).not.toMatch(/sql\.js \+ HNSW|HNSW \+ sql\.js|HNSW-indexed/i);
    expect(rendered).toContain('HiveMemory');
    expect(rendered).toContain('local vector');
  });

  it('describes memory_search as bridge-or-local-vector behavior without claiming bridge HNSW', () => {
    expect(metadata('memory_search').description).toMatch(/HiveMemory bridge when available/i);
    expect(metadata('memory_search').description).toMatch(/sql\.js local vector similarity fallback/i);
    expect(metadata('memory_search').description).not.toMatch(/HiveMemory\/HNSW/i);
  });
});
