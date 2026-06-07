import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  getHivectorVersion,
  getRuvectorVersion,
  isHivectorAvailable,
  isRuvectorAvailable,
} from '../index.js';

describe('hivector compatibility aliases', () => {
  it('keeps deprecated ruvector export aliases wired to the hivector implementations', () => {
    expect(isRuvectorAvailable).toBe(isHivectorAvailable);
    expect(getRuvectorVersion).toBe(getHivectorVersion);
  });

  it('keeps package subpath compatibility aliases while publishing hivector as primary', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };

    expect(pkg.exports['./hivector']).toBeDefined();
    expect(pkg.exports['./hivector/*']).toBeDefined();
    expect(pkg.exports['./ruvector']).toEqual(pkg.exports['./hivector']);
    expect(pkg.exports['./ruvector/*']).toEqual(pkg.exports['./hivector/*']);
  });
});
