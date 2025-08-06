"""
Decision Engine for Autonomous Automation.

This module provides intelligent decision-making capabilities for autonomous
workflows, enabling the system to make context-aware decisions without human intervention.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Callable, Tuple
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from ..core.base_interfaces import ConfigurableComponent

logger = logging.getLogger(__name__)


class DecisionType(Enum):
    """Types of decisions the engine can make."""
    RESOURCE_ALLOCATION = "resource_allocation"
    TASK_PRIORITIZATION = "task_prioritization"
    ERROR_HANDLING = "error_handling"
    OPTIMIZATION = "optimization"
    ROUTING = "routing"
    SCALING = "scaling"


class ConfidenceLevel(Enum):
    """Confidence levels for decisions."""
    LOW = 0.3
    MEDIUM = 0.6
    HIGH = 0.8
    VERY_HIGH = 0.95


@dataclass
class DecisionContext:
    """Context information for decision making."""
    decision_type: DecisionType
    current_state: Dict[str, Any]
    available_options: List[Dict[str, Any]]
    constraints: Dict[str, Any] = field(default_factory=dict)
    preferences: Dict[str, Any] = field(default_factory=dict)
    historical_data: List[Dict[str, Any]] = field(default_factory=list)
    timestamp: datetime = field(default_factory=datetime.now)


@dataclass
class DecisionResult:
    """Result of a decision-making process."""
    selected_option: Dict[str, Any]
    confidence: float
    reasoning: str
    alternative_options: List[Dict[str, Any]] = field(default_factory=list)
    risk_factors: List[str] = field(default_factory=list)
    expected_outcome: Optional[Dict[str, Any]] = None
    decision_time: datetime = field(default_factory=datetime.now)
    execution_time_ms: float = 0.0


class DecisionStrategy:
    """Base class for decision strategies."""
    
    def __init__(self, name: str):
        self.name = name
    
    async def evaluate(self, context: DecisionContext) -> Tuple[Dict[str, Any], float, str]:
        """
        Evaluate options and return best choice with confidence and reasoning.
        
        Returns:
            Tuple of (selected_option, confidence, reasoning)
        """
        raise NotImplementedError("Subclasses must implement evaluate method")


class WeightedScoringStrategy(DecisionStrategy):
    """Decision strategy using weighted scoring."""
    
    def __init__(self, weights: Dict[str, float]):
        super().__init__("weighted_scoring")
        self.weights = weights
    
    async def evaluate(self, context: DecisionContext) -> Tuple[Dict[str, Any], float, str]:
        """Evaluate options using weighted scoring."""
        best_option = None
        best_score = -float('inf')
        scores = []
        
        for option in context.available_options:
            score = self._calculate_score(option, context)
            scores.append((option, score))
            
            if score > best_score:
                best_score = score
                best_option = option
        
        # Normalize confidence based on score range
        if len(scores) > 1:
            scores.sort(key=lambda x: x[1], reverse=True)
            top_score = scores[0][1]
            second_score = scores[1][1] if len(scores) > 1 else 0
            confidence = min(0.95, max(0.1, (top_score - second_score) / top_score))
        else:
            confidence = 0.5
        
        reasoning = f"Selected based on weighted scoring (score: {best_score:.3f})"
        
        return best_option, confidence, reasoning
    
    def _calculate_score(self, option: Dict[str, Any], context: DecisionContext) -> float:
        """Calculate weighted score for an option."""
        score = 0.0
        
        for criterion, weight in self.weights.items():
            if criterion in option:
                value = option[criterion]
                if isinstance(value, (int, float)):
                    score += value * weight
                elif isinstance(value, bool):
                    score += (1.0 if value else 0.0) * weight
        
        # Apply constraints
        for constraint, constraint_value in context.constraints.items():
            if constraint in option:
                if not self._meets_constraint(option[constraint], constraint_value):
                    score -= 1000  # Heavy penalty for constraint violations
        
        return score
    
    def _meets_constraint(self, value: Any, constraint: Any) -> bool:
        """Check if a value meets a constraint."""
        if isinstance(constraint, dict):
            if 'min' in constraint and value < constraint['min']:
                return False
            if 'max' in constraint and value > constraint['max']:
                return False
            if 'equals' in constraint and value != constraint['equals']:
                return False
        elif isinstance(constraint, (list, tuple)):
            return value in constraint
        else:
            return value == constraint
        
        return True


class MLBasedStrategy(DecisionStrategy):
    """Machine learning-based decision strategy."""
    
    def __init__(self, model_path: Optional[str] = None):
        super().__init__("ml_based")
        self.model_path = model_path
        self.model = None
    
    async def evaluate(self, context: DecisionContext) -> Tuple[Dict[str, Any], float, str]:
        """Evaluate using ML model (placeholder implementation)."""
        # Placeholder: In a real implementation, this would use a trained ML model
        # For now, use a simple heuristic
        
        if not context.available_options:
            raise ValueError("No options available for decision")
        
        # Simple heuristic: prefer options with higher expected performance
        best_option = max(
            context.available_options,
            key=lambda x: x.get('expected_performance', 0)
        )
        
        confidence = 0.7  # Medium confidence for heuristic
        reasoning = "Selected using ML-based heuristic (performance optimization)"
        
        return best_option, confidence, reasoning


class DecisionEngine(ConfigurableComponent):
    """
    Autonomous decision engine for workflow automation.
    
    This engine can make intelligent decisions based on context, constraints,
    and historical data without human intervention.
    """
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        super().__init__(config)
        self.strategies: Dict[DecisionType, List[DecisionStrategy]] = {}
        self.decision_history: List[DecisionResult] = []
        self.fallback_strategy = WeightedScoringStrategy({
            'performance': 0.4,
            'cost': -0.3,
            'reliability': 0.3
        })
        
        self._setup_default_strategies()
    
    def _validate_config(self) -> None:
        """Validate decision engine configuration."""
        required_keys = ['enabled', 'max_history_size']
        for key in required_keys:
            if key not in self.config:
                logger.warning(f"Missing config key '{key}', using default")
    
    def _setup_default_strategies(self) -> None:
        """Setup default decision strategies for different decision types."""
        # Resource allocation strategy
        resource_strategy = WeightedScoringStrategy({
            'available_cpu': 0.3,
            'available_memory': 0.3,
            'cost_per_hour': -0.2,
            'reliability_score': 0.2
        })
        self.add_strategy(DecisionType.RESOURCE_ALLOCATION, resource_strategy)
        
        # Task prioritization strategy
        priority_strategy = WeightedScoringStrategy({
            'deadline_urgency': 0.4,
            'business_value': 0.3,
            'complexity': -0.2,
            'dependencies': -0.1
        })
        self.add_strategy(DecisionType.TASK_PRIORITIZATION, priority_strategy)
        
        # Error handling strategy
        error_strategy = WeightedScoringStrategy({
            'recovery_probability': 0.5,
            'recovery_time': -0.3,
            'impact_severity': -0.2
        })
        self.add_strategy(DecisionType.ERROR_HANDLING, error_strategy)
    
    def add_strategy(self, decision_type: DecisionType, strategy: DecisionStrategy) -> None:
        """Add a decision strategy for a specific decision type."""
        if decision_type not in self.strategies:
            self.strategies[decision_type] = []
        
        self.strategies[decision_type].append(strategy)
        logger.info(f"Added strategy '{strategy.name}' for {decision_type.value}")
    
    async def make_decision(self, context: DecisionContext) -> DecisionResult:
        """
        Make a decision based on the given context.
        
        This is the main method for autonomous decision making.
        """
        start_time = datetime.now()
        
        if not context.available_options:
            raise ValueError("No options available for decision making")
        
        # Get strategies for this decision type
        strategies = self.strategies.get(context.decision_type, [self.fallback_strategy])
        
        # Evaluate using all available strategies
        evaluations = []
        for strategy in strategies:
            try:
                option, confidence, reasoning = await strategy.evaluate(context)
                evaluations.append((option, confidence, reasoning, strategy.name))
            except Exception as e:
                logger.warning(f"Strategy {strategy.name} failed: {e}")
        
        if not evaluations:
            # Fallback to first available option
            selected_option = context.available_options[0]
            confidence = 0.1  # Very low confidence
            reasoning = "Fallback selection - no strategies succeeded"
            strategy_name = "fallback"
        else:
            # Select best evaluation (highest confidence)
            evaluations.sort(key=lambda x: x[1], reverse=True)
            selected_option, confidence, reasoning, strategy_name = evaluations[0]
        
        # Calculate execution time
        execution_time = (datetime.now() - start_time).total_seconds() * 1000
        
        # Create decision result
        result = DecisionResult(
            selected_option=selected_option,
            confidence=confidence,
            reasoning=f"{reasoning} (via {strategy_name})",
            alternative_options=[eval[0] for eval in evaluations[1:5]],  # Top 4 alternatives
            execution_time_ms=execution_time,
            expected_outcome=self._predict_outcome(selected_option, context)
        )
        
        # Store in history
        self._store_decision(result)
        
        logger.info(f"Decision made: {result.reasoning} (confidence: {confidence:.2f})")
        
        return result
    
    def _predict_outcome(self, option: Dict[str, Any], 
                        context: DecisionContext) -> Dict[str, Any]:
        """Predict the expected outcome of a decision."""
        # Simple outcome prediction based on option properties
        outcome = {
            'expected_success_rate': option.get('reliability_score', 0.8),
            'estimated_completion_time': option.get('estimated_time', 'unknown'),
            'estimated_cost': option.get('cost', 0),
            'risk_level': 'low' if option.get('reliability_score', 0.8) > 0.8 else 'medium'
        }
        
        return outcome
    
    def _store_decision(self, result: DecisionResult) -> None:
        """Store decision in history for learning."""
        max_history = self.get_config_value('max_history_size', 1000)
        
        self.decision_history.append(result)
        
        # Trim history if too large
        if len(self.decision_history) > max_history:
            self.decision_history = self.decision_history[-max_history:]
    
    def get_decision_statistics(self) -> Dict[str, Any]:
        """Get statistics about decision making performance."""
        if not self.decision_history:
            return {"total_decisions": 0}
        
        total_decisions = len(self.decision_history)
        avg_confidence = sum(d.confidence for d in self.decision_history) / total_decisions
        avg_execution_time = sum(d.execution_time_ms for d in self.decision_history) / total_decisions
        
        confidence_distribution = {
            'low': sum(1 for d in self.decision_history if d.confidence < 0.5),
            'medium': sum(1 for d in self.decision_history if 0.5 <= d.confidence < 0.8),
            'high': sum(1 for d in self.decision_history if d.confidence >= 0.8)
        }
        
        return {
            'total_decisions': total_decisions,
            'average_confidence': avg_confidence,
            'average_execution_time_ms': avg_execution_time,
            'confidence_distribution': confidence_distribution,
            'recent_decisions': len([d for d in self.decision_history 
                                  if (datetime.now() - d.decision_time).days < 1])
        }
    
    async def learn_from_feedback(self, decision_id: str, 
                                 actual_outcome: Dict[str, Any],
                                 success: bool) -> None:
        """
        Learn from decision outcomes to improve future decisions.
        
        This method would be used to implement reinforcement learning
        or other feedback-based improvement mechanisms.
        """
        # Placeholder for learning implementation
        logger.info(f"Received feedback for decision {decision_id}: success={success}")
        
        # In a full implementation, this would:
        # 1. Find the decision in history
        # 2. Compare actual vs expected outcome
        # 3. Adjust strategy parameters
        # 4. Retrain models if applicable
        pass