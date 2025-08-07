#!/usr/bin/env python3
"""
Minimal test to reproduce the separability_matrix issue with nested CompoundModels.
This directly tests the separability matrix computation logic without requiring full astropy build.
"""

import numpy as np

# Mock classes to simulate the problematic model structure
class MockModel:
    def __init__(self, n_inputs, n_outputs, separable=True, name=""):
        self.n_inputs = n_inputs
        self.n_outputs = n_outputs
        self.separable = separable
        self.name = name
    
    def __str__(self):
        return f"{self.name}({self.n_inputs}→{self.n_outputs})"

class MockMapping(MockModel):
    def __init__(self, mapping, name="Mapping"):
        self.mapping = mapping
        super().__init__(len(set(mapping)), len(mapping), True, name)

class MockCompoundModel(MockModel):
    def __init__(self, left, right, op):
        self.left = left
        self.right = right
        self.op = op
        
        if op == '&':  # parallel combination
            n_inputs = left.n_inputs + right.n_inputs
            n_outputs = left.n_outputs + right.n_outputs
        elif op == '|':  # serial combination
            n_inputs = right.n_inputs
            n_outputs = left.n_outputs
        elif op == '*':  # arithmetic
            n_inputs = left.n_inputs  # assume same
            n_outputs = left.n_outputs  # assume same
        
        super().__init__(n_inputs, n_outputs, False)
    
    def _calculate_separability_matrix(self):
        return NotImplemented
    
    def __str__(self):
        return f"({self.left} {self.op} {self.right})"

# Simulate the separable.py functions
def _coord_matrix(model, pos, noutp):
    """Create coordinate matrix for a simple model."""
    if isinstance(model, MockMapping):
        axes = []
        for i in model.mapping:
            axis = np.zeros((model.n_inputs,))
            axis[i] = 1
            axes.append(axis)
        m = np.vstack(axes)
        mat = np.zeros((noutp, model.n_inputs))
        if pos == 'left':
            mat[: model.n_outputs, :model.n_inputs] = m
        else:
            mat[-model.n_outputs:, -model.n_inputs:] = m
        return mat
    
    if not model.separable:
        mat = np.zeros((noutp, model.n_inputs))
        if pos == 'left':
            mat[:model.n_outputs, : model.n_inputs] = 1
        else:
            mat[-model.n_outputs:, -model.n_inputs:] = 1
    else:
        mat = np.zeros((noutp, model.n_inputs))
        for i in range(min(model.n_inputs, model.n_outputs)):
            if i < noutp:
                mat[i, i] = 1
        if pos == 'right':
            mat = np.roll(mat, (noutp - model.n_outputs), axis=0)
    return mat

def _compute_n_outputs(left, right):
    """Compute number of outputs."""
    if isinstance(left, MockModel):
        lnout = left.n_outputs
    else:
        lnout = left.shape[0]
    if isinstance(right, MockModel):
        rnout = right.n_outputs
    else:
        rnout = right.shape[0]
    return lnout + rnout

def _cstack(left, right):
    """Function for & operation."""
    noutp = _compute_n_outputs(left, right)
    
    if isinstance(left, MockModel):
        cleft = _coord_matrix(left, 'left', noutp)
    else:
        cleft = np.zeros((noutp, left.shape[1]))
        cleft[: left.shape[0], : left.shape[1]] = left
    
    if isinstance(right, MockModel):
        cright = _coord_matrix(right, 'right', noutp)
    else:
        cright = np.zeros((noutp, right.shape[1]))
        cright[-right.shape[0]:, -right.shape[1]:] = 1
    
    return np.hstack([cleft, cright])

def _cdot(left, right):
    """Function for | operation."""
    left, right = right, left  # swap order
    
    def _n_inputs_outputs(input, position):
        if isinstance(input, MockModel):
            coords = _coord_matrix(input, position, input.n_outputs)
        else:
            coords = input
        return coords
    
    cleft = _n_inputs_outputs(left, 'left')
    cright = _n_inputs_outputs(right, 'right')
    
    try:
        result = np.dot(cleft, cright)
    except ValueError as e:
        raise ValueError(f'Models cannot be combined with "|" operator; '
                        f'left coord_matrix shape {cright.shape}, right coord_matrix shape {cleft.shape}: {e}')
    return result

def _arith_oper(left, right):
    """Function for arithmetic operators."""
    def _n_inputs_outputs(input):
        if isinstance(input, MockModel):
            n_outputs, n_inputs = input.n_outputs, input.n_inputs
        else:
            n_outputs, n_inputs = input.shape
        return n_inputs, n_outputs
    
    left_inputs, left_outputs = _n_inputs_outputs(left)
    right_inputs, right_outputs = _n_inputs_outputs(right)
    
    if left_inputs != right_inputs or left_outputs != right_outputs:
        raise ValueError("Models must have same dimensions for arithmetic")
    
    result = np.ones((left_outputs, left_inputs))
    return result

def _separable(transform):
    """Calculate separability matrix."""
    if hasattr(transform, '_calculate_separability_matrix'):
        if (transform_matrix := transform._calculate_separability_matrix()) is not NotImplemented:
            return transform_matrix
    
    if isinstance(transform, MockCompoundModel):
        sepleft = _separable(transform.left)
        sepright = _separable(transform.right)
        return _operators[transform.op](sepleft, sepright)
    elif isinstance(transform, MockModel):
        return _coord_matrix(transform, 'left', transform.n_outputs)

def separability_matrix(transform):
    """Compute separability matrix."""
    if transform.n_inputs == 1 and transform.n_outputs > 1:
        return np.ones((transform.n_outputs, transform.n_inputs), dtype=np.bool_)
    
    separable_matrix = _separable(transform)
    separable_matrix = np.where(separable_matrix != 0, True, False)
    return separable_matrix

# Operator mapping
_operators = {'&': _cstack, '|': _cdot, '+': _arith_oper, '-': _arith_oper,
              '*': _arith_oper, '/': _arith_oper, '**': _arith_oper}

def test_nested_compound_model():
    """Test the failing case with nested CompoundModels."""
    print("=== Testing Nested CompoundModel Separability ===")
    
    # Create the components
    shift1 = MockModel(1, 1, True, "Shift(1)")
    shift2 = MockModel(1, 1, True, "Shift(2)")
    mapping = MockMapping([0, 1, 0, 1], "Mapping([0,1,0,1])")
    poly1 = MockModel(1, 1, True, "Polynomial1D(1)")
    poly2 = MockModel(1, 1, True, "Polynomial1D(2)")
    
    print(f"Components:")
    print(f"  {shift1}")
    print(f"  {shift2}")
    print(f"  {mapping}")
    print(f"  {poly1}")
    print(f"  {poly2}")
    
    # Build nested model: ((Shift(1) & Shift(2)) | Mapping([0, 1, 0, 1])) * (Polynomial1D(1) & Polynomial1D(2))
    
    # Step 1: Shift(1) & Shift(2)
    shifts_combined = MockCompoundModel(shift1, shift2, '&')
    print(f"\nStep 1: {shifts_combined} -> {shifts_combined.n_inputs}→{shifts_combined.n_outputs}")
    
    # Step 2: (Shift(1) & Shift(2)) | Mapping([0, 1, 0, 1])
    left_side = MockCompoundModel(shifts_combined, mapping, '|')
    print(f"Step 2: {left_side} -> {left_side.n_inputs}→{left_side.n_outputs}")
    
    # Step 3: Polynomial1D(1) & Polynomial1D(2)
    polys_combined = MockCompoundModel(poly1, poly2, '&')
    print(f"Step 3: {polys_combined} -> {polys_combined.n_inputs}→{polys_combined.n_outputs}")
    
    # Step 4: Full compound model
    full_model = MockCompoundModel(left_side, polys_combined, '*')
    print(f"Step 4: {full_model} -> {full_model.n_inputs}→{full_model.n_outputs}")
    
    # Try to compute separability matrix
    print("\n=== Computing Separability Matrices ===")
    
    # Test each intermediate step
    try:
        print("\n--- Shifts Combined ---")
        sep_shifts = separability_matrix(shifts_combined)
        print(f"Shape: {sep_shifts.shape}")
        print(f"Matrix:\n{sep_shifts}")
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
    
    try:
        print("\n--- Left Side ---")
        sep_left = separability_matrix(left_side)
        print(f"Shape: {sep_left.shape}")
        print(f"Matrix:\n{sep_left}")
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
    
    try:
        print("\n--- Polys Combined ---")
        sep_polys = separability_matrix(polys_combined)
        print(f"Shape: {sep_polys.shape}")
        print(f"Matrix:\n{sep_polys}")
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
    
    try:
        print("\n--- Full Model ---")
        sep_full = separability_matrix(full_model)
        print(f"Shape: {sep_full.shape}")
        print(f"Matrix:\n{sep_full}")
        print(f"Expected shape: (4, 2)")
        print(f"Shape matches: {sep_full.shape == (4, 2)}")
    except Exception as e:
        print(f"ERROR: {e}")
        import traceback
        traceback.print_exc()
    
    return full_model

if __name__ == "__main__":
    test_nested_compound_model()