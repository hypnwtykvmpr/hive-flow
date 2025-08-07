#!/usr/bin/env python
"""Test scale multiplication behavior."""

import numpy as np
from astropy import units as u
from astropy import constants as const

# Test temperature
temperature = 3000 * u.K

# Test different scale types
scale_float = 1.0
scale_dim_unscaled = u.Quantity(1.0, u.dimensionless_unscaled)
scale_dim_regular = u.Quantity(1.0)

print("Testing scale multiplication:")
print(f"  scale_float: {scale_float} (type: {type(scale_float)})")
print(f"  scale_dim_unscaled: {scale_dim_unscaled} (type: {type(scale_dim_unscaled)})")
print(f"  scale_dim_regular: {scale_dim_regular} (type: {type(scale_dim_regular)})")

# Test multiplication
result_float = scale_float * const.sigma_sb * temperature**4 / np.pi
result_dim_unscaled = scale_dim_unscaled * const.sigma_sb * temperature**4 / np.pi
result_dim_regular = scale_dim_regular * const.sigma_sb * temperature**4 / np.pi

print("\nMultiplication results:")
print(f"  float: {result_float}")
print(f"  dim_unscaled: {result_dim_unscaled}")
print(f"  dim_regular: {result_dim_regular}")

# Convert to erg / (cm^2 s)
target_unit = u.erg / (u.cm**2 * u.s)
print("\nConverted to erg / (cm^2 s):")
print(f"  float: {result_float.to(target_unit)}")
print(f"  dim_unscaled: {result_dim_unscaled.to(target_unit)}")
print(f"  dim_regular: {result_dim_regular.to(target_unit)}")

# Test what happens when converting dimensionless to dimensionless_unscaled
print("\n--- Conversion to dimensionless_unscaled ---")
q1 = u.Quantity(1.0)
q2 = u.Quantity(1.0, u.dimensionless_unscaled)
print(f"Regular dimensionless: {q1}, unit: {q1.unit}")
print(f"Dimensionless_unscaled: {q2}, unit: {q2.unit}")
print(f"Convert regular to unscaled: {q1.to(u.dimensionless_unscaled)}")
print(f"Convert unscaled to unscaled: {q2.to(u.dimensionless_unscaled)}")

# Test what happens in property getter
print("\n--- Simulating bolometric_flux property ---")
class MockBlackBody:
    def __init__(self, scale):
        self.scale = MockParameter(scale)
        self.temperature = temperature
    
class MockParameter:
    def __init__(self, value):
        if hasattr(value, 'unit'):
            self.unit = value.unit
            self.value = value.value
            self.quantity = value
        else:
            self.unit = None
            self.value = value
            
for name, scale_val in [("float", 1.0), 
                        ("dim_unscaled", 1.0 * u.dimensionless_unscaled),
                        ("dim_regular", u.Quantity(1.0))]:
    print(f"\n{name}:")
    bb = MockBlackBody(scale_val)
    if bb.scale.unit is not None:
        scale = bb.scale.quantity.to(u.dimensionless_unscaled)
        print(f"  scale from quantity: {scale}, type: {type(scale)}")
        print(f"  scale.value: {scale.value}")
    else:
        scale = bb.scale.value
        print(f"  scale from value: {scale}, type: {type(scale)}")
    
    native_flux = scale * const.sigma_sb * bb.temperature**4 / np.pi
    print(f"  native_flux: {native_flux}")
    final_flux = native_flux.to(u.erg / (u.cm**2 * u.s))
    print(f"  final_flux: {final_flux}")