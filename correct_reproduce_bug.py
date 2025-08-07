#!/usr/bin/env python
"""
Correctly reproduce astropy issue #12907: separability_matrix incorrect for nested CompoundModels
The issue is about nested CompoundModels, not Mapping followed by CompoundModel
"""
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

# Create nested compound models as in the actual issue
# The issue is about nesting compound models within compound models
cm1 = m.Linear1D(10) & m.Linear1D(5)
print("First compound model (cm1):")
print(f"  Model: {cm1}")
print(f"  n_inputs: {cm1.n_inputs}, n_outputs: {cm1.n_outputs}")
sep1 = separability_matrix(cm1)
print(f"  Separability matrix: {sep1}")
print()

# Create another compound model that includes the first one
cm2 = m.Shift(1) & m.Shift(2)
print("Second compound model (cm2):")
print(f"  Model: {cm2}")
print(f"  n_inputs: {cm2.n_inputs}, n_outputs: {cm2.n_outputs}")
sep2 = separability_matrix(cm2)
print(f"  Separability matrix: {sep2}")
print()

# Now nest them - this is where the bug occurs
nested = cm1 | cm2
print("Nested compound model (cm1 | cm2):")
print(f"  Model: {nested}")
print(f"  n_inputs: {nested.n_inputs}, n_outputs: {nested.n_outputs}")
sep_nested = separability_matrix(nested)
print(f"  Separability matrix: {sep_nested}")
print()

# The issue is that separability is not correctly propagated through nested compound models
# Each output should be separable since Linear1D and Shift are separable

# Try with a more complex example
p1 = m.Polynomial1D(1)
p2 = m.Polynomial1D(2)
compound1 = p1 & p2
compound2 = m.Scale(2) & m.Scale(3)
nested2 = compound1 | compound2

print("More complex nested model:")
print(f"  Model: {nested2}")
sep_nested2 = separability_matrix(nested2)
print(f"  Separability matrix: {sep_nested2}")
print(f"  Expected: diagonal True elements since all are separable")