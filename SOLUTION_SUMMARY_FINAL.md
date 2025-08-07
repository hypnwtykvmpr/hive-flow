# Solution Summary: Add Helpers to Convert Between Uncertainty Types

## Issue Description
GitHub Issue astropy__astropy-12057 requested adding helper functions to convert between different types of uncertainties in the astropy.nddata module. While the underlying conversion mechanism (`represent_as`) already existed, it was not easily discoverable or convenient to use.

## Problem Analysis
1. The `NDUncertainty.represent_as()` method existed but required passing a class reference
2. No convenience methods like `to_variance()`, `to_stddev()` were available
3. No standalone function for conversion with string-based type selection
4. The feature was not well-documented or discoverable

## Solution Implemented

### 1. Added Convenience Methods to NDUncertainty Base Class
- `to_stddev()` - Convert any uncertainty to StdDevUncertainty
- `to_variance()` - Convert any uncertainty to VarianceUncertainty  
- `to_inverse_variance()` - Convert any uncertainty to InverseVariance

These methods internally use the existing `represent_as()` method but provide a more intuitive API.

### 2. Added Standalone Conversion Function
- `convert_uncertainty(uncertainty, target_type)` - Convert between uncertainty types
- Accepts string identifiers ('std', 'variance', 'ivar') or class references
- Provides clear error messages for invalid inputs

### 3. Updated Exports
- Added `convert_uncertainty` to the `__all__` list in nduncertainty.py
- This makes it available via `from astropy.nddata import convert_uncertainty`

## Key Features
- **Backward Compatible**: All existing functionality remains unchanged
- **Easy to Use**: Simple method calls like `uncertainty.to_variance()`
- **Flexible**: Supports both method calls and standalone function
- **String Support**: Can use strings like 'variance' instead of class references
- **Unit Aware**: Properly handles unit conversions (e.g., m → m² for variance)
- **Well Documented**: Includes docstrings with examples

## Example Usage

```python
from astropy.nddata import StdDevUncertainty, convert_uncertainty
import numpy as np

# Create a standard deviation uncertainty
std = StdDevUncertainty(np.array([2, 3, 4]))

# Convert using convenience methods
var = std.to_variance()  # Returns VarianceUncertainty([4, 9, 16])
ivar = std.to_inverse_variance()  # Returns InverseVariance([0.25, 0.111, 0.0625])

# Convert using standalone function with strings
var = convert_uncertainty(std, 'variance')
ivar = convert_uncertainty(std, 'ivar')

# Round-trip conversions work correctly
std2 = var.to_stddev()  # Returns StdDevUncertainty([2, 3, 4])
```

## Testing
The solution includes comprehensive test cases covering:
- Conversion between all three uncertainty types
- Round-trip conversions
- Unit handling
- Error cases for unsupported conversions
- String-based type selection
- Invalid input handling

## Impact
This enhancement makes uncertainty conversion in astropy much more accessible to users, especially those working with external libraries that expect specific uncertainty formats (e.g., variances). The solution maintains full backward compatibility while significantly improving the user experience.