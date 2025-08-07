#!/usr/bin/env python
"""Test script to reproduce the BlackBody bolometric flux issue with dimensionless_unscaled units."""

import numpy as np
from astropy import units as u
from astropy.modeling.models import BlackBody

# Test case from the issue
temperature = 3000 * u.K

# Test with float scale (should work correctly)
bb_float = BlackBody(temperature=temperature, scale=1.0)
flux_float = bb_float.bolometric_flux
print(f"Float scale bolometric flux: {flux_float}")
print(f"Float scale value: {flux_float.value}")

# Test with dimensionless_unscaled Quantity (problematic)
bb_dimensionless = BlackBody(temperature=temperature, scale=1.0 * u.dimensionless_unscaled)
flux_dimensionless = bb_dimensionless.bolometric_flux
print(f"\nDimensionless_unscaled scale bolometric flux: {flux_dimensionless}")
print(f"Dimensionless_unscaled scale value: {flux_dimensionless.value}")

# They should be equal
print(f"\nAre they equal? {np.isclose(flux_float.value, flux_dimensionless.value)}")
print(f"Ratio: {flux_dimensionless.value / flux_float.value}")

# Expected value from the issue
print(f"\nExpected value: ~4.823870774433646e-16 erg / (cm2 s)")