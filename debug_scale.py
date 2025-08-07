#!/usr/bin/env python
"""Debug script to understand scale parameter handling."""

from astropy import units as u
from astropy.modeling.models import BlackBody

# Test case 1: float scale
bb1 = BlackBody(temperature=3000*u.K, scale=1.0)
print(f"Float scale:")
print(f"  bb1.scale.value: {bb1.scale.value}")
print(f"  bb1.scale.unit: {bb1.scale.unit}")
print(f"  hasattr scale.unit: {bb1.scale.unit is not None}")

# Test case 2: dimensionless_unscaled scale
bb2 = BlackBody(temperature=3000*u.K, scale=1.0*u.dimensionless_unscaled)
print(f"\nDimensionless_unscaled scale:")
print(f"  bb2.scale.value: {bb2.scale.value}")
print(f"  bb2.scale.unit: {bb2.scale.unit}")
print(f"  hasattr scale.unit: {bb2.scale.unit is not None}")
print(f"  bb2.scale.quantity: {bb2.scale.quantity}")

# Check the bolometric flux calculation manually
import numpy as np
from astropy import constants as const

print("\n--- Manual calculation ---")
# For float scale
if bb1.scale.unit is not None:
    scale1 = bb1.scale.quantity.to(u.dimensionless_unscaled)
    print(f"Float case - scale1: {scale1}")
else:
    scale1 = bb1.scale.value
    print(f"Float case - scale1: {scale1}")

# For dimensionless scale  
if bb2.scale.unit is not None:
    scale2 = bb2.scale.quantity.to(u.dimensionless_unscaled)
    print(f"Dimensionless case - scale2: {scale2}")
else:
    scale2 = bb2.scale.value
    print(f"Dimensionless case - scale2: {scale2}")

# Check native flux calculation
native_flux1 = scale1 * const.sigma_sb * bb1.temperature**4 / np.pi
native_flux2 = scale2 * const.sigma_sb * bb2.temperature**4 / np.pi
print(f"\nNative flux 1: {native_flux1}")
print(f"Native flux 2: {native_flux2}")