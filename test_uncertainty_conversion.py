"""
Test cases for the new uncertainty conversion helper functions.
"""

import numpy as np
import pytest


def test_to_stddev():
    """Test conversion to standard deviation uncertainty."""
    from astropy.nddata import VarianceUncertainty, InverseVariance
    
    # From variance
    var = VarianceUncertainty(np.array([4, 9, 16]))
    std = var.to_stddev()
    assert std.uncertainty_type == 'std'
    np.testing.assert_array_almost_equal(std.array, [2, 3, 4])
    
    # From inverse variance
    ivar = InverseVariance(np.array([0.25, 1/9, 1/16]))
    std = ivar.to_stddev()
    assert std.uncertainty_type == 'std'
    np.testing.assert_array_almost_equal(std.array, [2, 3, 4])


def test_to_variance():
    """Test conversion to variance uncertainty."""
    from astropy.nddata import StdDevUncertainty, InverseVariance
    
    # From standard deviation
    std = StdDevUncertainty(np.array([2, 3, 4]))
    var = std.to_variance()
    assert var.uncertainty_type == 'var'
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])
    
    # From inverse variance
    ivar = InverseVariance(np.array([0.25, 1/9, 1/16]))
    var = ivar.to_variance()
    assert var.uncertainty_type == 'var'
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])


def test_to_inverse_variance():
    """Test conversion to inverse variance uncertainty."""
    from astropy.nddata import StdDevUncertainty, VarianceUncertainty
    
    # From standard deviation
    std = StdDevUncertainty(np.array([2, 3, 4]))
    ivar = std.to_inverse_variance()
    assert ivar.uncertainty_type == 'ivar'
    np.testing.assert_array_almost_equal(ivar.array, [0.25, 1/9, 1/16])
    
    # From variance  
    var = VarianceUncertainty(np.array([4, 9, 16]))
    ivar = var.to_inverse_variance()
    assert ivar.uncertainty_type == 'ivar'
    np.testing.assert_array_almost_equal(ivar.array, [0.25, 1/9, 1/16])


def test_convert_uncertainty_function():
    """Test the standalone convert_uncertainty function."""
    from astropy.nddata import (
        StdDevUncertainty, VarianceUncertainty, InverseVariance,
        convert_uncertainty
    )
    
    # Test with string target types
    std = StdDevUncertainty(np.array([2, 3, 4]))
    
    # Convert to variance using string
    var = convert_uncertainty(std, 'variance')
    assert isinstance(var, VarianceUncertainty)
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])
    
    # Convert to variance using 'var' alias
    var = convert_uncertainty(std, 'var')
    assert isinstance(var, VarianceUncertainty)
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])
    
    # Convert to inverse variance using string
    ivar = convert_uncertainty(std, 'inverse_variance')
    assert isinstance(ivar, InverseVariance)
    np.testing.assert_array_almost_equal(ivar.array, [0.25, 1/9, 1/16])
    
    # Convert to inverse variance using 'ivar' alias
    ivar = convert_uncertainty(std, 'ivar')
    assert isinstance(ivar, InverseVariance)
    np.testing.assert_array_almost_equal(ivar.array, [0.25, 1/9, 1/16])
    
    # Test with class target type
    var = convert_uncertainty(std, VarianceUncertainty)
    assert isinstance(var, VarianceUncertainty)
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])
    
    # Test invalid string
    with pytest.raises(ValueError, match="Unknown uncertainty type"):
        convert_uncertainty(std, 'invalid')


def test_round_trip_conversions():
    """Test that round-trip conversions preserve values."""
    from astropy.nddata import StdDevUncertainty
    
    original = np.array([1, 2, 3, 4, 5])
    std = StdDevUncertainty(original)
    
    # Round trip through variance
    var = std.to_variance()
    std2 = var.to_stddev()
    np.testing.assert_array_almost_equal(std2.array, original)
    
    # Round trip through inverse variance
    ivar = std.to_inverse_variance()
    std3 = ivar.to_stddev()
    np.testing.assert_array_almost_equal(std3.array, original)


def test_conversion_with_units():
    """Test that conversions handle units correctly."""
    from astropy.nddata import StdDevUncertainty, VarianceUncertainty
    from astropy import units as u
    
    # Standard deviation with unit
    std = StdDevUncertainty(np.array([2, 3, 4]), unit=u.m)
    
    # Convert to variance - unit should be squared
    var = std.to_variance()
    assert var.array is not None
    np.testing.assert_array_almost_equal(var.array, [4, 9, 16])
    assert var.unit == u.m**2
    
    # Convert back to std - unit should be m again
    std2 = var.to_stddev()
    np.testing.assert_array_almost_equal(std2.array, [2, 3, 4])
    assert std2.unit == u.m


def test_unsupported_conversion():
    """Test that unsupported conversions raise appropriate errors."""
    from astropy.nddata import UnknownUncertainty
    
    # UnknownUncertainty doesn't support conversion
    unk = UnknownUncertainty(np.array([1, 2, 3]))
    
    with pytest.raises(TypeError, match="does not support conversion"):
        unk.to_variance()
    
    with pytest.raises(TypeError, match="does not support conversion"):
        unk.to_stddev()
    
    with pytest.raises(TypeError, match="does not support conversion"):
        unk.to_inverse_variance()


if __name__ == "__main__":
    # Run the tests
    test_to_stddev()
    print("✓ test_to_stddev passed")
    
    test_to_variance()
    print("✓ test_to_variance passed")
    
    test_to_inverse_variance()
    print("✓ test_to_inverse_variance passed")
    
    test_convert_uncertainty_function()
    print("✓ test_convert_uncertainty_function passed")
    
    test_round_trip_conversions()
    print("✓ test_round_trip_conversions passed")
    
    test_conversion_with_units()
    print("✓ test_conversion_with_units passed")
    
    test_unsupported_conversion()
    print("✓ test_unsupported_conversion passed")
    
    print("\nAll tests passed!")