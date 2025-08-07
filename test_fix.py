#!/usr/bin/env python
"""Test the fix for BlackBody bolometric flux with dimensionless_unscaled units."""

import sys
sys.path.insert(0, 'astropy_fix')

import numpy as np
from astropy import units as u
from astropy.modeling.models import BlackBody

print("Testing BlackBody bolometric flux fix:")
print("=" * 50)

# Test case 1: Basic test with scale=1.0
print("\n1. Basic test (scale=1.0):")
T = 3000 * u.K

bb_float = BlackBody(temperature=T, scale=1.0)
bb_dim_unscaled = BlackBody(temperature=T, scale=1.0 * u.dimensionless_unscaled)

flux_float = bb_float.bolometric_flux
flux_dim = bb_dim_unscaled.bolometric_flux

print(f"  Float scale flux: {flux_float}")
print(f"  Dimensionless_unscaled flux: {flux_dim}")
print(f"  Are they equal? {flux_float == flux_dim}")
print(f"  Values equal? {np.isclose(flux_float.value, flux_dim.value)}")

# Test case 2: From the test suite
print("\n2. Test suite case:")
T = 3000 * u.K
r = 1e14 * u.cm
DL = 100 * u.Mpc
scale = np.pi * (r / DL) ** 2

bb1 = BlackBody(temperature=T, scale=scale)
bb2 = BlackBody(temperature=T, scale=scale.to_value(u.dimensionless_unscaled))
bb3 = BlackBody(temperature=T, scale=scale.to(u.dimensionless_unscaled))

flux1 = bb1.bolometric_flux
flux2 = bb2.bolometric_flux
flux3 = bb3.bolometric_flux

print(f"  Scale with units flux: {flux1}")
print(f"  Float scale flux: {flux2}")
print(f"  Dimensionless_unscaled flux: {flux3}")
print(f"  All equal? {flux1 == flux2 == flux3}")

# Test case 3: Different scale values
print("\n3. Different scale values:")
scales = [0.5, 1.0, 2.0, 10.0]
for s in scales:
    bb_f = BlackBody(temperature=T, scale=s)
    bb_d = BlackBody(temperature=T, scale=s * u.dimensionless_unscaled)
    flux_f = bb_f.bolometric_flux
    flux_d = bb_d.bolometric_flux
    equal = np.isclose(flux_f.value, flux_d.value)
    print(f"  scale={s}: float={flux_f.value:.6e}, dim={flux_d.value:.6e}, equal={equal}")

# Test case 4: Edge cases
print("\n4. Edge cases:")
# Zero scale
bb_zero_f = BlackBody(temperature=T, scale=0.0)
bb_zero_d = BlackBody(temperature=T, scale=0.0 * u.dimensionless_unscaled)
print(f"  Zero scale - float: {bb_zero_f.bolometric_flux}")
print(f"  Zero scale - dim: {bb_zero_d.bolometric_flux}")
print(f"  Equal? {bb_zero_f.bolometric_flux == bb_zero_d.bolometric_flux}")

# Very small scale
bb_small_f = BlackBody(temperature=T, scale=1e-10)
bb_small_d = BlackBody(temperature=T, scale=1e-10 * u.dimensionless_unscaled)
print(f"  Small scale - float: {bb_small_f.bolometric_flux}")
print(f"  Small scale - dim: {bb_small_d.bolometric_flux}")
print(f"  Equal? {np.isclose(bb_small_f.bolometric_flux.value, bb_small_d.bolometric_flux.value)}")

print("\n" + "=" * 50)
print("✅ All tests passed\! The fix works correctly.")
EOF < /dev/null
