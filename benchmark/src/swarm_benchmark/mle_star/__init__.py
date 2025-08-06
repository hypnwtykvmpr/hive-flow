"""
MLE-STAR Ensemble Learning Integration Module.

This module provides MLE-STAR ensemble learning capabilities for the benchmark system,
including multi-model coordination, voting strategies, and consensus mechanisms.
"""

from .ensemble_executor import MLEStarEnsembleExecutor
from .voting_strategies import VotingStrategy, MajorityVoting, WeightedVoting, StackingEnsemble
from .model_coordinator import ModelCoordinator
from .performance_tracker import MLEStarPerformanceTracker

__all__ = [
    "MLEStarEnsembleExecutor",
    "VotingStrategy",
    "MajorityVoting", 
    "WeightedVoting",
    "StackingEnsemble",
    "ModelCoordinator",
    "MLEStarPerformanceTracker",
]