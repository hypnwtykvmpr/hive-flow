import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getCanonicalAgentTypes } from '../../agents/roster.js';
import { Q_LEARNING_ROUTE_NAMES } from '../../hivector/q-learning-router.js';
import {
  ROUTE_AGENT_TYPES,
  ROUTER_TARGET_ALIASES,
  resolveRouterTarget,
} from '../route.js';

function canonicalSet(): Set<string> {
  return new Set(getCanonicalAgentTypes());
}

describe('router target canonicalization', () => {
  it('advertises only canonical spawnable agent types', () => {
    const canonical = canonicalSet();
    const advertisedIds = ROUTE_AGENT_TYPES.map((agent) => agent.id);

    expect(advertisedIds.filter((id) => !canonical.has(id))).toEqual([]);
  });

  it('keeps Q-learning action names spawnable without remapping', () => {
    const canonical = canonicalSet();

    expect(new Set(Q_LEARNING_ROUTE_NAMES).size).toBe(Q_LEARNING_ROUTE_NAMES.length);
    expect(Q_LEARNING_ROUTE_NAMES.filter((route) => !canonical.has(route))).toEqual([]);
  });

  it('maps legacy persisted route names to canonical targets', () => {
    const canonical = canonicalSet();

    for (const [legacy, target] of Object.entries(ROUTER_TARGET_ALIASES)) {
      expect(canonical.has(target), `${legacy} -> ${target}`).toBe(true);
      expect(resolveRouterTarget(legacy)).toBe(target);
    }
  });

  it('resolves every router-emittable or persisted route target to a canonical target', () => {
    const canonical = canonicalSet();
    const routeNames = [
      ...ROUTE_AGENT_TYPES.map((agent) => agent.id),
      ...Q_LEARNING_ROUTE_NAMES,
      ...Object.keys(ROUTER_TARGET_ALIASES),
    ];

    fc.assert(
      fc.property(fc.constantFrom(...routeNames), (route) => {
        const resolved = resolveRouterTarget(route);

        expect(resolved, route).toBeDefined();
        expect(canonical.has(resolved!), `${route} -> ${resolved}`).toBe(true);
      }),
      { numRuns: routeNames.length * 4 },
    );
  });
});
