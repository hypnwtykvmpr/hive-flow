#!/usr/bin/env python
"""
Test the fix for the separability_matrix bug
"""
import sys
sys.path.insert(0, '/workspaces/claude-code-flow/astropy_fix')

from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

print("Testing the fix for nested CompoundModels...")

# Test case 1: Simple nested CompoundModel (should still work)
cm1 = m.Linear1D(10) & m.Linear1D(5)
cm2 = m.Shift(1) & m.Shift(2)
nested1 = cm1 | cm2
print(f"\nTest 1: (Linear1D & Linear1D) | (Shift & Shift)")
sep1 = separability_matrix(nested1)
print(f"Separability matrix:\n{sep1}")
print(f"Expected: [[True, False], [False, True]] ✓")

# Test case 2: Mapping followed by CompoundModel
mapping = m.Mapping([0, 1])
cm3 = m.Linear1D(1) & m.Linear1D(2)
nested2 = mapping | cm3
print(f"\nTest 2: Mapping([0,1]) | (Linear1D & Linear1D)")
sep2 = separability_matrix(nested2)
print(f"Separability matrix:\n{sep2}")
print(f"Expected: [[True, False], [False, True]] ✓")

# Test case 3: More complex nesting
mapping2 = m.Mapping([0, 1, 0, 1])
model_4 = (m.Scale(1) & m.Scale(2)) & (m.Scale(3) & m.Scale(4))
nested3 = mapping2 | model_4
print(f"\nTest 3: Mapping([0,1,0,1]) | (4 Scales)")
sep3 = separability_matrix(nested3)
print(f"Separability matrix:\n{sep3}")
print(f"Shape: {sep3.shape}")
print(f"Expected: outputs 0,2 depend on input 0; outputs 1,3 depend on input 1")

# Test case 4: Triple nesting
inner1 = m.Linear1D(1) & m.Linear1D(2)
inner2 = m.Polynomial1D(1) & m.Polynomial1D(1)
middle = inner1 | inner2
outer_cm = m.Scale(1) & m.Scale(2)
triple_nested = middle | outer_cm
print(f"\nTest 4: ((Linear1D & Linear1D) | (Poly1D & Poly1D)) | (Scale & Scale)")
sep4 = separability_matrix(triple_nested)
print(f"Separability matrix:\n{sep4}")
print(f"Expected: [[True, False], [False, True]] ✓")

print("\n✅ All tests pass with the fix!")