"""
Proposed patch to add helper functions for converting between uncertainty types.
This adds convenience methods to NDUncertainty classes to make conversion easier.
"""

# The patch would add these methods to the NDUncertainty class:

def to_stddev(self):
    """Convert this uncertainty to standard deviation uncertainty.
    
    Returns
    -------
    stddev_uncertainty : `StdDevUncertainty`
        The uncertainty converted to standard deviation.
        
    Raises
    ------
    TypeError
        If the conversion is not supported.
        
    Examples
    --------
    >>> from astropy.nddata import VarianceUncertainty
    >>> import numpy as np
    >>> var = VarianceUncertainty(np.array([4, 9, 16]))
    >>> std = var.to_stddev()
    >>> std.array
    array([2., 3., 4.])
    """
    from astropy.nddata import StdDevUncertainty
    return self.represent_as(StdDevUncertainty)


def to_variance(self):
    """Convert this uncertainty to variance uncertainty.
    
    Returns
    -------
    variance_uncertainty : `VarianceUncertainty`
        The uncertainty converted to variance.
        
    Raises
    ------
    TypeError
        If the conversion is not supported.
        
    Examples
    --------
    >>> from astropy.nddata import StdDevUncertainty
    >>> import numpy as np
    >>> std = StdDevUncertainty(np.array([2, 3, 4]))
    >>> var = std.to_variance()
    >>> var.array
    array([4., 9., 16.])
    """
    from astropy.nddata import VarianceUncertainty
    return self.represent_as(VarianceUncertainty)


def to_inverse_variance(self):
    """Convert this uncertainty to inverse variance uncertainty.
    
    Returns
    -------
    ivar_uncertainty : `InverseVariance`
        The uncertainty converted to inverse variance.
        
    Raises
    ------
    TypeError
        If the conversion is not supported.
        
    Examples
    --------
    >>> from astropy.nddata import VarianceUncertainty
    >>> import numpy as np
    >>> var = VarianceUncertainty(np.array([4, 9, 16]))
    >>> ivar = var.to_inverse_variance()
    >>> ivar.array
    array([0.25, 0.11111111, 0.0625])
    """
    from astropy.nddata import InverseVariance
    return self.represent_as(InverseVariance)


# Also add a standalone function for convenience:

def convert_uncertainty(uncertainty, target_type):
    """Convert an uncertainty to a different uncertainty type.
    
    Parameters
    ----------
    uncertainty : `NDUncertainty` instance
        The uncertainty to convert.
    target_type : str or `NDUncertainty` subclass
        The target uncertainty type. Can be:
        - 'stddev' or 'std' for `StdDevUncertainty`
        - 'variance' or 'var' for `VarianceUncertainty`  
        - 'inverse_variance' or 'ivar' for `InverseVariance`
        - An `NDUncertainty` subclass
        
    Returns
    -------
    converted_uncertainty : `NDUncertainty` instance
        The uncertainty converted to the target type.
        
    Raises
    ------
    TypeError
        If the conversion is not supported.
    ValueError
        If the target_type string is not recognized.
        
    Examples
    --------
    >>> from astropy.nddata import StdDevUncertainty, convert_uncertainty
    >>> import numpy as np
    >>> std = StdDevUncertainty(np.array([2, 3, 4]))
    >>> var = convert_uncertainty(std, 'variance')
    >>> var.array
    array([4., 9., 16.])
    """
    from astropy.nddata import StdDevUncertainty, VarianceUncertainty, InverseVariance
    
    # Map string names to classes
    type_map = {
        'stddev': StdDevUncertainty,
        'std': StdDevUncertainty,
        'variance': VarianceUncertainty,
        'var': VarianceUncertainty,
        'inverse_variance': InverseVariance,
        'ivar': InverseVariance,
    }
    
    if isinstance(target_type, str):
        target_type = target_type.lower()
        if target_type not in type_map:
            raise ValueError(
                f"Unknown uncertainty type '{target_type}'. "
                f"Valid options are: {', '.join(type_map.keys())}"
            )
        target_class = type_map[target_type]
    else:
        target_class = target_type
        
    return uncertainty.represent_as(target_class)