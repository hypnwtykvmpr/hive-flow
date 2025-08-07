#!/usr/bin/env python
"""
Comprehensive test cases for the separability_matrix fix
"""
import numpy as np
from astropy.modeling import models as m
from astropy.modeling.separable import separability_matrix

def test_nested_compound_models():
    """Test that nested CompoundModels work correctly"""
    # Test 1: Simple nested CompoundModel
    cm1 = m.Linear1D(10) & m.Linear1D(5)
    cm2 = m.Shift(1) & m.Shift(2)
    nested = cm1 | cm2
    sep = separability_matrix(nested)
    assert sep.shape == (2, 2)
    assert np.array_equal(sep, [[True, False], [False, True]])
    
    # Test 2: Mapping with CompoundModel
    mapping = m.Mapping([0, 1])
    cm = m.Linear1D(1) & m.Linear1D(2)
    nested = mapping | cm
    sep = separability_matrix(nested)
    assert sep.shape == (2, 2)
    assert np.array_equal(sep, [[True, False], [False, True]])
    
    # Test 3: Triple nesting
    inner1 = m.Linear1D(1) & m.Linear1D(2)
    inner2 = m.Polynomial1D(1) & m.Polynomial1D(1)
    middle = inner1 | inner2
    outer = m.Scale(1) & m.Scale(2)
    triple = middle | outer
    sep = separability_matrix(triple)
    assert sep.shape == (2, 2)
    assert np.array_equal(sep, [[True, False], [False, True]])
    
    print("✅ All nested CompoundModel tests pass!")

def test_mapping_with_duplication():
    """Test Mapping that duplicates inputs"""
    mapping = m.Mapping([0, 1, 0, 1])
    model = (m.Scale(1) & m.Scale(2)) & (m.Scale(3) & m.Scale(4))
    nested = mapping | model
    sep = separability_matrix(nested)
    assert sep.shape == (4, 2)
    # Outputs 0,2 depend on input 0; outputs 1,3 depend on input 1
    expected = np.array([[True, False], [False, True], [True, False], [False, True]])
    assert np.array_equal(sep, expected)
    print("✅ Mapping duplication test passes!")

def test_non_separable_in_chain():
    """Test with non-separable model in the chain"""
    cm = m.Scale(1) & m.Scale(2)
    rot = m.Rotation2D(30)
    nested = cm | rot
    sep = separability_matrix(nested)
    assert sep.shape == (2, 2)
    # Rotation2D mixes inputs, so all outputs depend on all inputs
    assert np.array_equal(sep, [[True, True], [True, True]])
    print("✅ Non-separable chain test passes!")

if __name__ == "__main__":
    test_nested_compound_models()
    test_mapping_with_duplication()
    test_non_separable_in_chain()
    print("\n🎉 All tests pass! The fix correctly handles nested CompoundModels.")