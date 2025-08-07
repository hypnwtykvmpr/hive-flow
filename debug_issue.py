#!/usr/bin/env python3
"""
Script to debug the separability matrix issue with nested CompoundModels.
"""
import sys
import os
sys.path.insert(0, '/workspaces/claude-code-flow/astropy_fix')

import numpy as np
from astropy.modeling import models
from astropy.modeling.separable import separability_matrix, _separable, _cdot
from astropy.modeling.core import CompoundModel

def debug_nested_compound_model():
    """Debug the nested CompoundModel separability issue."""
    print("="*60)
    print("DEBUGGING NESTED COMPOUND MODEL SEPARABILITY ISSUE")
    print("="*60)
    
    # Create simple models
    shift1 = models.Shift(1, name="shift1")
    shift2 = models.Shift(2, name="shift2")
    rotation = models.Rotation2D(2, name="rotation")
    
    print(f"Simple models:")
    print(f"  shift1: {shift1.n_inputs} inputs, {shift1.n_outputs} outputs")
    print(f"  shift2: {shift2.n_inputs} inputs, {shift2.n_outputs} outputs") 
    print(f"  rotation: {rotation.n_inputs} inputs, {rotation.n_outputs} outputs")
    print()
    
    # Create a simple CompoundModel (this should work)
    simple_compound = shift1 & shift2
    print(f"Simple compound (shift1 & shift2):")
    print(f"  Type: {type(simple_compound)}")
    print(f"  Is CompoundModel: {isinstance(simple_compound, CompoundModel)}")
    print(f"  Inputs: {simple_compound.n_inputs}, Outputs: {simple_compound.n_outputs}")
    print(f"  Left: {simple_compound.left} (type: {type(simple_compound.left)})")
    print(f"  Right: {simple_compound.right} (type: {type(simple_compound.right)})")
    print()
    
    # Test separability matrix for simple compound
    try:
        simple_sep_matrix = separability_matrix(simple_compound)
        print(f"  Separability matrix for simple compound:")
        print(f"    {simple_sep_matrix}")
        print(f"    Shape: {simple_sep_matrix.shape}")
    except Exception as e:
        print(f"  ERROR with simple compound: {e}")
    print()
    
    # Create a nested CompoundModel (this might fail)
    nested_compound = simple_compound | rotation
    print(f"Nested compound (simple_compound | rotation):")
    print(f"  Type: {type(nested_compound)}")
    print(f"  Is CompoundModel: {isinstance(nested_compound, CompoundModel)}")
    print(f"  Inputs: {nested_compound.n_inputs}, Outputs: {nested_compound.n_outputs}")
    print(f"  Left: {nested_compound.left} (type: {type(nested_compound.left)})")
    print(f"  Right: {nested_compound.right} (type: {type(nested_compound.right)})")
    print()
    
    # Test separability matrix for nested compound
    try:
        nested_sep_matrix = separability_matrix(nested_compound)
        print(f"  Separability matrix for nested compound:")
        print(f"    {nested_sep_matrix}")
        print(f"    Shape: {nested_sep_matrix.shape}")
    except Exception as e:
        print(f"  ERROR with nested compound: {e}")
        import traceback
        traceback.print_exc()
    print()
    
    # Let's trace through the _separable function for the nested case
    print("="*60)
    print("TRACING _separable FUNCTION FOR NESTED COMPOUND")
    print("="*60)
    
    def trace_separable(transform, depth=0):
        indent = "  " * depth
        print(f"{indent}trace_separable({transform}, type={type(transform)})")
        
        if hasattr(transform, '_calculate_separability_matrix'):
            matrix = transform._calculate_separability_matrix()
            print(f"{indent}  _calculate_separability_matrix() -> {matrix}")
            if matrix is not NotImplemented:
                print(f"{indent}  returning custom matrix: {matrix}")
                return matrix
        
        if isinstance(transform, CompoundModel):
            print(f"{indent}  CompoundModel: op='{transform.op}'")
            print(f"{indent}  Left: {transform.left} (type: {type(transform.left)})")
            print(f"{indent}  Right: {transform.right} (type: {type(transform.right)})")
            
            sepleft = trace_separable(transform.left, depth + 1)
            print(f"{indent}  sepleft result: {sepleft}")
            
            sepright = trace_separable(transform.right, depth + 1)
            print(f"{indent}  sepright result: {sepright}")
            
            from astropy.modeling.separable import _operators
            operator_func = _operators[transform.op]
            print(f"{indent}  Using operator function: {operator_func}")
            
            try:
                result = operator_func(sepleft, sepright)
                print(f"{indent}  operator result: {result}")
                return result
            except Exception as e:
                print(f"{indent}  ERROR in operator: {e}")
                raise
        else:
            from astropy.modeling.separable import _coord_matrix
            result = _coord_matrix(transform, 'left', transform.n_outputs)
            print(f"{indent}  _coord_matrix result: {result}")
            return result
    
    try:
        result = trace_separable(nested_compound)
        print(f"Final result: {result}")
    except Exception as e:
        print(f"Final error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    debug_nested_compound_model()