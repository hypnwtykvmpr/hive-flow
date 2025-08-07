#!/usr/bin/env python
"""
Fixed version of the _cdot function from astropy/modeling/separable.py
"""

def _cdot_fixed(left, right):
    """
    Function corresponding to "|" operation.
    
    Parameters
    ----------
    left, right : `astropy.modeling.Model` or ndarray
        If input is of an array, it is the output of `coord_matrix`.
    
    Returns
    -------
    result : ndarray
        Result from this operation.
    """
    from astropy.modeling.core import CompoundModel, Model
    import numpy as np
    
    left, right = right, left
    
    def _n_inputs_outputs(input, position):
        """
        Return ``n_inputs``, ``n_outputs`` for a model or coord_matrix.
        """
        if isinstance(input, Model):
            # FIX: Check if it's a CompoundModel and handle it differently
            if isinstance(input, CompoundModel):
                # For CompoundModels, use _separable to get the separability matrix
                coords = _separable(input)
            else:
                # For simple Models, use _coord_matrix as before
                coords = _coord_matrix(input, position, input.n_outputs)
        else:
            coords = input
        return coords
    
    cleft = _n_inputs_outputs(left, "left")
    cright = _n_inputs_outputs(right, "right")
    
    try:
        result = np.dot(cleft, cright)
    except ValueError:
        from astropy.modeling.core import ModelDefinitionError
        raise ModelDefinitionError(
            'Models cannot be combined with the "|" operator; '
            f"left coord_matrix is {cright}, right coord_matrix is {cleft}"
        )
    return result

print("Fixed _cdot function created")
print("\nThe key change is in the _n_inputs_outputs nested function:")
print("- Added check for CompoundModel using isinstance")
print("- If it's a CompoundModel, call _separable(input) instead of _coord_matrix")
print("- This ensures nested CompoundModels are processed correctly")