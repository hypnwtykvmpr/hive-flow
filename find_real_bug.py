#!/usr/bin/env python
"""
Find the real bug case - the issue says the expected output should be [[True, True], [True, True]]
This would mean both outputs depend on both inputs
"""
import numpy as np
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

# Let's test the exact case from the issue description
# The issue mentions Mapping([0, 1, 0, 1]) | cm where cm = Linear1D(10) & Linear1D(5)
# But that gives a dimension error

# Let's check if the issue is with how nested CompoundModels are handled
print("=== Test Case 1: Simple nested CompoundModel ===")
cm1 = m.Linear1D(10) & m.Linear1D(5)
cm2 = m.Shift(1) & m.Shift(2)
nested1 = cm1 | cm2
print(f"Model: (Linear1D & Linear1D) | (Shift & Shift)")
print(f"Separability matrix:\n{separability_matrix(nested1)}")
print(f"Expected: [[True, False], [False, True]] - CORRECT")

print("\n=== Test Case 2: CompoundModel with non-separable component ===")
rot = m.Rotation2D(30)
cm3 = m.Scale(1) & m.Scale(2)
nested2 = cm3 | rot
print(f"Model: (Scale & Scale) | Rotation2D")
print(f"Separability matrix:\n{separability_matrix(nested2)}")
print(f"Expected: [[True, True], [True, True]] - because Rotation2D mixes inputs")

print("\n=== Test Case 3: Mapping that duplicates ===")
# Perhaps the real issue is when a CompoundModel itself contains a Mapping?
inner_map = m.Mapping([0, 1, 0, 1])
try:
    # This should work if we have 2 inputs going to 4 outputs, then to a 4-input model
    model_4 = (m.Scale(1) & m.Scale(2)) & (m.Scale(3) & m.Scale(4))
    nested3 = inner_map | model_4
    print(f"Model: Mapping([0,1,0,1]) | (4 Scales)")
    sep3 = separability_matrix(nested3)
    print(f"Separability matrix:\n{sep3}")
    print(f"Shape: {sep3.shape}")
    
    # The issue might be that it's not recognizing that through the mapping,
    # outputs 0 and 2 both depend on input 0, and outputs 1 and 3 on input 1
    # But that's what we're getting...
except Exception as e:
    print(f"Error: {e}")

print("\n=== Test Case 4: Deeply nested CompoundModels ===")
# Maybe the issue is with deeper nesting
inner1 = m.Linear1D(1) & m.Linear1D(2)
inner2 = m.Linear1D(3) & m.Linear1D(4)
outer = inner1 | inner2
print(f"Model: ((Linear1D & Linear1D) | (Linear1D & Linear1D))")
sep4 = separability_matrix(outer)
print(f"Separability matrix:\n{sep4}")
print(f"Expected: [[True, False], [False, True]]")

print("\n=== The Real Issue ===")
print("Looking at the _cdot implementation in separable.py...")
print("The issue might be in how nested CompoundModels are processed recursively")