#!/usr/bin/env python
"""
Trace through the bug in detail
"""
import numpy as np
from astropy.modeling import models as m
from astropy.modeling.separable import _separable, _cdot, _coord_matrix, separability_matrix

# Create the problematic case
mapping = m.Mapping([0, 1, 0, 1])
model_4input = (m.Linear1D(1) & m.Linear1D(2)) & (m.Linear1D(3) & m.Linear1D(4))

print("=== Mapping Analysis ===")
print(f"Mapping: {mapping.mapping}")
print(f"n_inputs: {mapping.n_inputs}, n_outputs: {mapping.n_outputs}")

# Get the coord matrix for the mapping
map_matrix = _coord_matrix(mapping, "left", mapping.n_outputs)
print(f"\nMapping coord_matrix (shape {map_matrix.shape}):")
print(map_matrix)
print("This shows which inputs affect which outputs")
print("Row 0 (output 0): depends on input 0")
print("Row 1 (output 1): depends on input 1")
print("Row 2 (output 2): depends on input 0")
print("Row 3 (output 3): depends on input 1")

print("\n=== Model Analysis ===")
print(f"Model n_inputs: {model_4input.n_inputs}, n_outputs: {model_4input.n_outputs}")
model_sep = _separable(model_4input)
print(f"\nModel separability matrix (shape {model_sep.shape}):")
print(model_sep)

print("\n=== Nested Model Analysis ===")
nested = mapping | model_4input
print(f"Nested n_inputs: {nested.n_inputs}, n_outputs: {nested.n_outputs}")

# Manually compute what _cdot should produce
print("\n=== Manual _cdot computation ===")
# In _cdot, the inputs are swapped: _cdot(left, right) swaps to (right, left)
# So we compute: map_matrix @ model_sep
print(f"map_matrix shape: {map_matrix.shape}")
print(f"model_sep shape: {model_sep.shape}")

# The issue is that _cdot expects both to have compatible dimensions
# Let's trace what actually happens in _cdot
print("\n=== What _cdot does ===")
result = _cdot(mapping, model_4input)
print(f"Result shape: {result.shape}")
print("Result:")
print(result)

print("\n=== Final separability matrix ===")
sep = separability_matrix(nested)
print(sep)

print("\n=== EXPECTED ===")
print("Since Mapping[0,1,0,1] maps:")
print("  input 0 -> outputs 0,2")
print("  input 1 -> outputs 1,3")
print("And the 4-input model has each output depend on one input,")
print("The final result should show:")
print("  output 0 depends on input 0 (via mapping output 0 -> model input 0)")
print("  output 1 depends on input 1 (via mapping output 1 -> model input 1)")
print("  output 2 depends on input 0 (via mapping output 2 -> model input 2)")
print("  output 3 depends on input 1 (via mapping output 3 -> model input 3)")
print("So we expect:")
expected = np.array([[True, False], [False, True], [True, False], [False, True]])
print(expected)
print("\nBut this IS what we're getting! So the bug must be different...")