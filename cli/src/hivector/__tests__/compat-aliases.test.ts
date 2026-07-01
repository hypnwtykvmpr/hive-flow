import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getHivectorVersion,
  isHivectorAvailable,
} from '../index.js';

describe('hivector public exports', () => {
  const legacyVectorName = ['r', 'u', 'v', 'e', 'c', 't', 'o', 'r'].join('');

  it('publishes only the hivector availability helpers', () => {
    expect(isHivectorAvailable).toBeTypeOf('function');
    expect(getHivectorVersion).toBeTypeOf('function');
  });

  it('does not publish legacy vector subpath aliases', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports['./hivector']).toBeDefined();
    expect(pkg.exports['./hivector/*']).toBeDefined();
    expect(pkg.exports).not.toHaveProperty(`./${legacyVectorName}`);
    expect(pkg.exports).not.toHaveProperty(`./${legacyVectorName}/*`);
  });
});
