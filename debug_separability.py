#!/usr/bin/env python3
"""
Debug script for astropy separability_matrix issue with nested CompoundModels.
Testing the failure case and analyzing the computation step by step.
"""

import sys
import os
sys.path.insert(0, '/workspaces/claude-code-flow/astropy_fix')

import numpy as np
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix
from astropy.modeling.core import CompoundModel

def test_nested_compound_model():
    """Test the specific failing case with nested CompoundModels."""
    print("=== Testing Nested CompoundModel Separability ===")
    
    # Create the nested model that fails
    cm = ((m.Shift(1) & m.Shift(2)) | m.Mapping([0, 1, 0, 1])) * (m.Polynomial1D(1) & m.Polynomial1D(2))
    
    print(f"Compound Model: {cm}")
    print(f"Model inputs: {cm.n_inputs}")
    print(f"Model outputs: {cm.n_outputs}")
    
    # Analyze the model structure
    print("\n=== Model Structure Analysis ===")
    print(f"Left side: {cm.left}")
    print(f"Left n_inputs: {cm.left.n_inputs}")
    print(f"Left n_outputs: {cm.left.n_outputs}")
    
    print(f"Right side: {cm.right}")
    print(f"Right n_inputs: {cm.right.n_inputs}")
    print(f"Right n_outputs: {cm.right.n_outputs}")
    
    # Try to compute separability matrix
    print("\n=== Computing Separability Matrix ===")
    try:
        result = separability_matrix(cm)
        print(f"Result shape: {result.shape}")
        print(f"Result:\n{result}")
        
        # Expected should be 4x2 matrix
        print(f"Expected shape: (4, 2)")
        print(f"Shape matches expected: {result.shape == (4, 2)}")
        
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
    
    return cm

def analyze_subcomponents():
    """Analyze each subcomponent separately."""
    print("\n=== Analyzing Subcomponents ===")
    
    # Test individual components
    shift1 = m.Shift(1)
    shift2 = m.Shift(2)
    mapping = m.Mapping([0, 1, 0, 1])
    poly1 = m.Polynomial1D(1)
    poly2 = m.Polynomial1D(2)
    
    components = [
        ("Shift(1)", shift1),
        ("Shift(2)", shift2),
        ("Mapping([0,1,0,1])", mapping),
        ("Polynomial1D(1)", poly1),
        ("Polynomial1D(2)", poly2)
    ]
    
    for name, comp in components:
        try:
            sep_mat = separability_matrix(comp)
            print(f"{name}: {comp.n_inputs}→{comp.n_outputs}, matrix shape: {sep_mat.shape}")
            print(f"  Matrix:\n{sep_mat}")
        except Exception as e:
            print(f"{name}: ERROR - {e}")
    
    # Test intermediate compound models
    print("\n=== Testing Intermediate Compounds ===")
    
    # Shift(1) & Shift(2)
    shifts_combined = shift1 & shift2
    print(f"Shift(1) & Shift(2): {shifts_combined.n_inputs}→{shifts_combined.n_outputs}")
    try:
        sep_mat = separability_matrix(shifts_combined)
        print(f"  Matrix shape: {sep_mat.shape}")
        print(f"  Matrix:\n{sep_mat}")
    except Exception as e:
        print(f"  ERROR: {e}")
    
    # (Shift(1) & Shift(2)) | Mapping
    left_side = shifts_combined | mapping
    print(f"Left side: {left_side.n_inputs}→{left_side.n_outputs}")
    try:
        sep_mat = separability_matrix(left_side)
        print(f"  Matrix shape: {sep_mat.shape}")
        print(f"  Matrix:\n{sep_mat}")
    except Exception as e:
        print(f"  ERROR: {e}")
    
    # Polynomial1D(1) & Polynomial1D(2)
    polys_combined = poly1 & poly2
    print(f"Poly1D(1) & Poly1D(2): {polys_combined.n_inputs}→{polys_combined.n_outputs}")
    try:
        sep_mat = separability_matrix(polys_combined)
        print(f"  Matrix shape: {sep_mat.shape}")
        print(f"  Matrix:\n{sep_mat}")
    except Exception as e:
        print(f"  ERROR: {e}")

def debug_separability_computation(model):
    """Debug the separability matrix computation step by step."""
    print("\n=== Debugging Separability Computation ===")
    
    # Import the internal functions to trace execution
    try:
        from astropy.modeling.separable import _separable, _compute_n_outputs
        
        print(f"Model type: {type(model)}")
        print(f"Is CompoundModel: {isinstance(model, CompoundModel)}")
        
        if isinstance(model, CompoundModel):
            print(f"Operator: {model.op}")
            print(f"Left: {model.left} ({type(model.left)})")
            print(f"Right: {model.right} ({type(model.right)})")
            
            # Try to compute separability for each side
            print("\n--- Left side separability ---")
            try:
                left_sep = separability_matrix(model.left)
                print(f"Left separability shape: {left_sep.shape}")
                print(f"Left separability:\n{left_sep}")
            except Exception as e:
                print(f"Left separability ERROR: {e}")
            
            print("\n--- Right side separability ---")
            try:
                right_sep = separability_matrix(model.right)
                print(f"Right separability shape: {right_sep.shape}")
                print(f"Right separability:\n{right_sep}")
            except Exception as e:
                print(f"Right separability ERROR: {e}")
        
    except ImportError as e:
        print(f"Cannot import internal functions: {e}")

if __name__ == "__main__":
    # Run the analysis
    model = test_nested_compound_model()
    analyze_subcomponents()
    debug_separability_computation(model)