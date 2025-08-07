#!/usr/bin/env python3
"""
Minimal script to understand the separability matrix issue directly with the source code.
"""
import sys
import numpy as np

# Import the necessary modules directly from the source
sys.path.insert(0, '/workspaces/claude-code-flow/astropy_fix/astropy/modeling')
sys.path.insert(0, '/workspaces/claude-code-flow/astropy_fix')

# Create a minimal model structure to test separability
class Model:
    """Minimal Model class for testing"""
    def __init__(self, n_inputs, n_outputs, name=None, separable=True):
        self.n_inputs = n_inputs
        self.n_outputs = n_outputs
        self.name = name
        self.separable = separable
        
    def _calculate_separability_matrix(self):
        return NotImplemented

class CompoundModel(Model):
    """Minimal CompoundModel class for testing"""
    def __init__(self, op, left, right, name=None):
        self.op = op
        self.left = left
        self.right = right
        self.name = name
        
        # Calculate combined inputs/outputs
        if op == '&':  # concatenation
            self.n_inputs = left.n_inputs + right.n_inputs
            self.n_outputs = left.n_outputs + right.n_outputs
        elif op == '|':  # composition
            self.n_inputs = right.n_inputs  # input of rightmost (first applied)
            self.n_outputs = left.n_outputs  # output of leftmost (last applied)
        
    def _calculate_separability_matrix(self):
        return NotImplemented

class Mapping(Model):
    """Minimal Mapping class for testing"""
    def __init__(self, mapping, name=None):
        self.mapping = mapping
        self.n_inputs = max(mapping) + 1
        self.n_outputs = len(mapping)
        self.name = name
        self.separable = True
        
    def _calculate_separability_matrix(self):
        return NotImplemented

def debug_separability_issue():
    """Debug the specific separability matrix issue"""
    print("="*60)
    print("DEBUGGING SEPARABILITY MATRIX ISSUE - MINIMAL VERSION")
    print("="*60)
    
    # Import the actual separability functions
    from separable import _separable, _coord_matrix, _cdot, _operators, separability_matrix
    
    # Create test models
    shift1 = Model(1, 1, "shift1", separable=True)
    shift2 = Model(1, 1, "shift2", separable=True)
    rotation = Model(2, 2, "rotation", separable=False)
    
    print("Test models:")
    print(f"  shift1: {shift1.n_inputs}→{shift1.n_outputs}, separable={shift1.separable}")
    print(f"  shift2: {shift2.n_inputs}→{shift2.n_outputs}, separable={shift2.separable}")
    print(f"  rotation: {rotation.n_inputs}→{rotation.n_outputs}, separable={rotation.separable}")
    print()
    
    # Test 1: Simple compound model (shift1 & shift2)
    simple_compound = CompoundModel('&', shift1, shift2, "simple")
    print(f"Simple compound (shift1 & shift2):")
    print(f"  Inputs: {simple_compound.n_inputs}, Outputs: {simple_compound.n_outputs}")
    print(f"  Left: {simple_compound.left.name}")
    print(f"  Right: {simple_compound.right.name}")
    
    # Test separability
    simple_matrix = _separable(simple_compound)
    print(f"  _separable result: {simple_matrix}")
    print(f"  Shape: {simple_matrix.shape}")
    print()
    
    # Test 2: Nested compound model (simple_compound | rotation)
    nested_compound = CompoundModel('|', simple_compound, rotation, "nested")
    print(f"Nested compound (simple | rotation):")
    print(f"  Inputs: {nested_compound.n_inputs}, Outputs: {nested_compound.n_outputs}")
    print(f"  Left: {nested_compound.left.name} (type: {type(nested_compound.left)})")
    print(f"  Right: {nested_compound.right.name}")
    
    # Trace the issue step by step
    print("\nTracing _separable for nested compound:")
    
    def trace_separable(transform, depth=0):
        indent = "  " * depth
        print(f"{indent}Processing: {getattr(transform, 'name', 'unnamed')} (type: {type(transform).__name__})")
        
        if hasattr(transform, '_calculate_separability_matrix'):
            matrix = transform._calculate_separability_matrix()
            if matrix is not NotImplemented:
                print(f"{indent}  Custom separability matrix: {matrix}")
                return matrix
        
        if isinstance(transform, CompoundModel):
            print(f"{indent}  CompoundModel with op: '{transform.op}'")
            
            # Get left and right separability matrices
            print(f"{indent}  Processing left: {getattr(transform.left, 'name', 'unnamed')}")
            sepleft = trace_separable(transform.left, depth + 1)
            print(f"{indent}  Left result: {sepleft} (shape: {sepleft.shape})")
            
            print(f"{indent}  Processing right: {getattr(transform.right, 'name', 'unnamed')}")
            sepright = trace_separable(transform.right, depth + 1)
            print(f"{indent}  Right result: {sepright} (shape: {sepright.shape})")
            
            # Apply operator
            operator_func = _operators[transform.op]
            print(f"{indent}  Applying operator '{transform.op}' using {operator_func.__name__}")
            
            try:
                result = operator_func(sepleft, sepright)
                print(f"{indent}  Operator result: {result} (shape: {result.shape})")
                return result
            except Exception as e:
                print(f"{indent}  ERROR in operator: {e}")
                import traceback
                traceback.print_exc()
                raise
        else:
            # Simple model
            result = _coord_matrix(transform, 'left', transform.n_outputs)
            print(f"{indent}  _coord_matrix result: {result} (shape: {result.shape})")
            return result
    
    try:
        nested_matrix = trace_separable(nested_compound)
        print(f"\nFinal separability matrix: {nested_matrix}")
        print(f"Shape: {nested_matrix.shape}")
    except Exception as e:
        print(f"\nFinal error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    debug_separability_issue()