#!/usr/bin/env python
"""
Test that the current version has the bug
"""
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

print("Testing with installed astropy (should show the bug)...")

try:
    # This should trigger the bug in the unfixed version
    mapping = m.Mapping([0, 1])
    cm = m.Linear1D(1) & m.Linear1D(2)
    nested = mapping | cm
    print(f"Model: Mapping([0,1]) | (Linear1D & Linear1D)")
    sep = separability_matrix(nested)
    print(f"Separability matrix:\n{sep}")
    print("✓ No error - either already fixed or different bug")
except Exception as e:
    print(f"✗ Error occurred (this is the bug): {e}")

print("\nThe fix prevents this error by handling CompoundModels correctly in _cdot")