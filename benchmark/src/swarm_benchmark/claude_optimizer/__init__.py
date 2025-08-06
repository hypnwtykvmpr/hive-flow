"""
CLAUDE.md Optimizer Module

This module provides intelligent optimization of CLAUDE.md configurations
for different development use cases and performance targets.
"""

from .optimizer import ClaudeMdOptimizer
from .templates import TemplateEngine
from .rules_engine import OptimizationRulesEngine

__all__ = [
    "ClaudeMdOptimizer",
    "TemplateEngine", 
    "OptimizationRulesEngine"
]

__version__ = "1.0.0"