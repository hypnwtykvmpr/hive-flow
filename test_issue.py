#!/usr/bin/env python
"""
Test the actual issue case from astropy #12907
The issue states that separability_matrix does not compute separability correctly 
for nested CompoundModels with Mapping
"""
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

# Based on the issue description, test with Mapping
# The issue shows a case like: Mapping([0, 1, 0, 1]) | (Linear1D & Linear1D)

# Create a mapping that duplicates inputs
mapping = m.Mapping([0, 1, 0, 1])
print(f"Mapping: {mapping.mapping}")
print(f"Mapping n_inputs: {mapping.n_inputs}, n_outputs: {mapping.n_outputs}")
print()

# Create a compound model
linear_compound = m.Linear1D(10) & m.Linear1D(5)
print(f"Linear compound n_inputs: {linear_compound.n_inputs}, n_outputs: {linear_compound.n_outputs}")
print()

# Chain them - but this fails due to dimension mismatch
# The mapping outputs 4 values but the compound expects 2 inputs
# So we need a different mapping
mapping2 = m.Mapping([0, 1])  # Identity mapping
nested = mapping2 | linear_compound
print(f"Nested model: {nested}")
sep = separability_matrix(nested)
print(f"Separability matrix: {sep}")
print()

# Try with a model that accepts 4 inputs
model_4input = (m.Linear1D(1) & m.Linear1D(2)) & (m.Linear1D(3) & m.Linear1D(4))
print(f"4-input model n_inputs: {model_4input.n_inputs}, n_outputs: {model_4input.n_outputs}")

# Now we can chain with the 4-output mapping
try:
    nested2 = mapping | model_4input
    print(f"Nested with mapping: {nested2}")
    sep2 = separability_matrix(nested2)
    print(f"Separability matrix of nested: {sep2}")
    print(f"Expected: should show correct separability based on mapping")
except Exception as e:
    print(f"Error: {e}")