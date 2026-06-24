import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApplianceBuilder, resolveVerifyApplianceScript } from '../appliance-builder.js';

describe('Appliance appliance verify script bundling', () => {
  it('resolves the verify script from the CLI package root in source and dist layouts', () => {
    expect(resolveVerifyApplianceScript(join(process.cwd(), 'src', 'appliance')))
      .toBe(join(process.cwd(), 'scripts', 'verify-appliance.sh'));
    expect(resolveVerifyApplianceScript(join(process.cwd(), 'dist', 'src', 'appliance')))
      .toBe(join(process.cwd(), 'scripts', 'verify-appliance.sh'));
  });

  it('bundles the real appliance verification script instead of the fallback stub', async () => {
    const builder = new ApplianceBuilder({
      profile: 'cloud',
      arch: 'x86_64',
      output: 'unused.hfap',
      hiveFlowVersion: 'test',
    }) as unknown as { buildVerifySection(): Buffer };

    const verifySection = builder.buildVerifySection().toString('utf8');
    const canonicalScript = readFileSync(resolveVerifyApplianceScript(), 'utf8');

    expect(verifySection).toContain('Full Capability Verification Suite');
    expect(verifySection).toContain('---VERIFY-MANIFEST---');
    expect(verifySection).toContain(canonicalScript.slice(0, 80));
    expect(verifySection).not.toContain('Running basic verification...');
  });
});
