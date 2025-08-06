"""
CLAUDE.md Configuration Optimizer Module.

This module provides intelligent CLAUDE.md configuration generation and optimization
for specific use cases, improving Claude Code performance and accuracy.
"""

from .optimizer import ClaudeMdOptimizer, OptimizationConfig, OptimizedConfig
from .use_case_templates import UseCaseTemplateManager, UseCase, Template
from .optimization_rules import OptimizationRulesEngine, OptimizationRule, RuleSet
from .config_validator import ConfigValidator, ValidationResult, ValidationRule
from .performance_tester import ConfigPerformanceTester, PerformanceMetrics

__all__ = [
    "ClaudeMdOptimizer",
    "OptimizationConfig",
    "OptimizedConfig",
    "UseCaseTemplateManager",
    "UseCase",
    "Template",
    "OptimizationRulesEngine",
    "OptimizationRule",
    "RuleSet",
    "ConfigValidator",
    "ValidationResult",
    "ValidationRule",
    "ConfigPerformanceTester",
    "PerformanceMetrics",
]