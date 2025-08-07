#!/usr/bin/env python
"""Comprehensive test to reproduce and understand the BlackBody issue."""

import numpy as np
from astropy import units as u
from astropy import constants as const
from astropy.modeling.models import BlackBody

print("Testing BlackBody bolometric flux with different scale types:\n")

# Test temperature
temperature = 3000 * u.K

# Test 1: Scale as float
bb_float = BlackBody(temperature=temperature, scale=1.0)
flux_float = bb_float.bolometric_flux
print(f"1. Float scale (1.0):")
print(f"   scale.unit: {bb_float.scale.unit}")
print(f"   scale.value: {bb_float.scale.value}")
print(f"   bolometric_flux: {flux_float}")

# Test 2: Scale as dimensionless_unscaled
bb_dim = BlackBody(temperature=temperature, scale=1.0 * u.dimensionless_unscaled)
flux_dim = bb_dim.bolometric_flux
print(f"\n2. Dimensionless_unscaled scale (1.0 * u.dimensionless_unscaled):")
print(f"   scale.unit: {bb_dim.scale.unit}")
print(f"   scale.value: {bb_dim.scale.value}")
print(f"   bolometric_flux: {flux_dim}")

# Test 3: Scale as regular dimensionless
bb_dimless = BlackBody(temperature=temperature, scale=u.Quantity(1.0))
flux_dimless = bb_dimless.bolometric_flux
print(f"\n3. Regular dimensionless scale (u.Quantity(1.0)):")
print(f"   scale.unit: {bb_dimless.scale.unit}")
print(f"   scale.value: {bb_dimless.scale.value}")
print(f"   bolometric_flux: {flux_dimless}")

# Manual calculation of expected value
expected_flux = const.sigma_sb * temperature**4 / np.pi
print(f"\n4. Expected flux (manual calculation):")
print(f"   sigma_sb * T^4 / pi = {expected_flux.to(u.erg / (u.cm**2 * u.s))}")

# Check equality
print(f"\nComparison:")
print(f"   Float == Expected? {np.isclose(flux_float.value, expected_flux.to(flux_float.unit).value)}")
print(f"   Dimensionless_unscaled == Expected? {np.isclose(flux_dim.value, expected_flux.to(flux_dim.unit).value)}")
print(f"   Regular dimensionless == Expected? {np.isclose(flux_dimless.value, expected_flux.to(flux_dimless.unit).value)}")

# Check what happens in bolometric_flux property
print("\n5. Debug bolometric_flux calculation:")
for name, bb in [("float", bb_float), ("dimensionless_unscaled", bb_dim), ("dimensionless", bb_dimless)]:
    print(f"\n   {name}:")
    if bb.scale.unit is not None:
        scale = bb.scale.quantity.to(u.dimensionless_unscaled)
        print(f"     scale from quantity: {scale} (type: {type(scale)})")
        if hasattr(scale, 'value'):
            print(f"     scale.value: {scale.value}")
    else:
        scale = bb.scale.value
        print(f"     scale from value: {scale} (type: {type(scale)})")
    
    # Calculate native flux
    native_flux = scale * const.sigma_sb * bb.temperature**4 / np.pi
    print(f"     native_flux type: {type(native_flux)}")
    if hasattr(native_flux, 'unit'):
        print(f"     native_flux: {native_flux}")
        try:
            final_flux = native_flux.to(u.erg / (u.cm**2 * u.s))
            print(f"     final_flux: {final_flux}")
        except Exception as e:
            print(f"     Error converting: {e}")