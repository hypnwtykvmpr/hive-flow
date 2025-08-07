#!/usr/bin/env python
"""Reproduce the exact issue from the test."""

import numpy as np
from astropy import units as u
from astropy.modeling.models import BlackBody

# From test_blackbody_dimensionless
T = 3000 * u.K
r = 1e14 * u.cm
DL = 100 * u.Mpc
scale = np.pi * (r / DL) ** 2

print(f"Scale value: {scale}")
print(f"Scale unit: {scale.unit}")
print(f"Scale to dimensionless_unscaled: {scale.to_value(u.dimensionless_unscaled)}")

bb1 = BlackBody(temperature=T, scale=scale)
print(f"\nbb1 (regular dimensionless scale):")
print(f"  bb1.scale.unit: {bb1.scale.unit}")
print(f"  bb1.scale.value: {bb1.scale.value}")

bb2 = BlackBody(temperature=T, scale=scale.to_value(u.dimensionless_unscaled))
print(f"\nbb2 (float scale from to_value):")
print(f"  bb2.scale.unit: {bb2.scale.unit}")
print(f"  bb2.scale.value: {bb2.scale.value}")

# Check bolometric flux
flux1 = bb1.bolometric_flux
flux2 = bb2.bolometric_flux

print(f"\nBolometric fluxes:")
print(f"  bb1.bolometric_flux: {flux1}")
print(f"  bb2.bolometric_flux: {flux2}")
print(f"  Are they equal? {flux1 == flux2}")
print(f"  Values equal? {flux1.value == flux2.value}")

# Let's also test with explicit dimensionless_unscaled Quantity
bb3 = BlackBody(temperature=T, scale=scale.to(u.dimensionless_unscaled))
print(f"\nbb3 (dimensionless_unscaled Quantity):")
print(f"  bb3.scale.unit: {bb3.scale.unit}")
print(f"  bb3.scale.value: {bb3.scale.value}")
flux3 = bb3.bolometric_flux
print(f"  bb3.bolometric_flux: {flux3}")
print(f"  bb3 == bb2? {flux3 == flux2}")

# Test what the original issue report describes
print("\n--- Original Issue Test ---")
bb_float = BlackBody(temperature=T, scale=1.0)
bb_dim_unscaled = BlackBody(temperature=T, scale=1.0 * u.dimensionless_unscaled)

print(f"Float scale flux: {bb_float.bolometric_flux}")
print(f"Dimensionless_unscaled flux: {bb_dim_unscaled.bolometric_flux}")
print(f"Are they equal? {bb_float.bolometric_flux == bb_dim_unscaled.bolometric_flux}")