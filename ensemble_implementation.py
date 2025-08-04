#!/usr/bin/env python3
"""
MLE-STAR Ensemble Implementation
Comprehensive model ensembling with voting, stacking, and blending mechanisms
"""

import numpy as np
import pandas as pd
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple, Union
from dataclasses import dataclass, field
from sklearn.base import BaseEstimator, RegressorMixin, ClassifierMixin
from sklearn.model_selection import cross_val_predict, KFold, StratifiedKFold
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.neural_network import MLPRegressor, MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, mean_squared_error, r2_score, f1_score
import logging
import json
import pickle
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class ModelPerformance:
    """Track individual model performance metrics."""
    model_id: str
    accuracy: float = 0.0
    precision: float = 0.0
    recall: float = 0.0
    f1_score: float = 0.0
    mse: float = 0.0
    rmse: float = 0.0
    r2_score: float = 0.0
    training_time: float = 0.0
    inference_time: float = 0.0
    memory_usage: float = 0.0
    
@dataclass 
class EnsembleConfig:
    """Configuration for ensemble methods."""
    voting_strategy: str = "soft"  # "hard", "soft", "weighted"
    stacking_meta_learner: str = "linear"  # "linear", "rf", "neural"
    blending_method: str = "simple"  # "simple", "hierarchical", "dynamic"
    cv_folds: int = 5
    random_state: int = 42
    enable_feature_importance: bool = True
    diversity_threshold: float = 0.1
    performance_weight: float = 0.7
    diversity_weight: float = 0.3

class BaseModel(ABC):
    """Abstract base class for ensemble models."""
    
    def __init__(self, model_id: str, model: Any):
        self.model_id = model_id
        self.model = model
        self.performance = ModelPerformance(model_id=model_id)
        self.is_trained = False
        
    @abstractmethod
    def fit(self, X: np.ndarray, y: np.ndarray) -> 'BaseModel':
        """Train the model."""
        pass
        
    @abstractmethod
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Make predictions."""
        pass
        
    @abstractmethod
    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]:
        """Predict class probabilities if applicable."""
        pass
        
class WrappedModel(BaseModel):
    """Wrapper for scikit-learn style models."""
    
    def fit(self, X: np.ndarray, y: np.ndarray) -> 'WrappedModel':
        """Train the wrapped model."""
        start_time = datetime.now()
        
        self.model.fit(X, y)
        self.is_trained = True
        
        # Update performance metrics
        self.performance.training_time = (datetime.now() - start_time).total_seconds()
        
        # Calculate training performance
        if hasattr(self.model, 'predict_proba'):
            y_pred = self.model.predict(X)
            if len(np.unique(y)) <= 10:  # Classification
                self.performance.accuracy = accuracy_score(y, y_pred)
                self.performance.f1_score = f1_score(y, y_pred, average='weighted')
        else:  # Regression
            y_pred = self.model.predict(X)
            self.performance.mse = mean_squared_error(y, y_pred)
            self.performance.rmse = np.sqrt(self.performance.mse)
            self.performance.r2_score = r2_score(y, y_pred)
            
        return self
        
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Make predictions."""
        if not self.is_trained:
            raise ValueError(f"Model {self.model_id} must be trained before prediction")
            
        start_time = datetime.now()
        predictions = self.model.predict(X)
        self.performance.inference_time = (datetime.now() - start_time).total_seconds()
        
        return predictions
        
    def predict_proba(self, X: np.ndarray) -> Optional[np.ndarray]:
        """Predict class probabilities."""
        if not self.is_trained:
            raise ValueError(f"Model {self.model_id} must be trained before prediction")
            
        if hasattr(self.model, 'predict_proba'):
            return self.model.predict_proba(X)
        return None

class VotingEnsemble:
    """Voting ensemble implementation with multiple strategies."""
    
    def __init__(self, models: List[BaseModel], config: EnsembleConfig):
        self.models = models
        self.config = config
        self.weights = None
        self.is_fitted = False
        
    def fit(self, X: np.ndarray, y: np.ndarray) -> 'VotingEnsemble':
        """Train all base models and compute weights."""
        logger.info(f"Training {len(self.models)} models for voting ensemble")
        
        # Train all base models
        for model in self.models:
            logger.info(f"Training model: {model.model_id}")
            model.fit(X, y)
            
        # Compute weights based on performance and diversity
        if self.config.voting_strategy == "weighted":
            self.weights = self._compute_weights(X, y)
        else:
            self.weights = np.ones(len(self.models)) / len(self.models)
            
        self.is_fitted = True
        return self
        
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Make ensemble predictions."""
        if not self.is_fitted:
            raise ValueError("Ensemble must be fitted before prediction")
            
        predictions = []
        probabilities = []
        
        for model in self.models:
            pred = model.predict(X)
            predictions.append(pred)
            
            if self.config.voting_strategy == "soft":
                proba = model.predict_proba(X)
                if proba is not None:
                    probabilities.append(proba)
                    
        predictions = np.array(predictions)
        
        if self.config.voting_strategy == "hard":
            # Hard voting - majority vote
            return self._hard_vote(predictions)
        elif self.config.voting_strategy == "soft" and probabilities:
            # Soft voting - average probabilities
            return self._soft_vote(probabilities)
        else:
            # Weighted average
            return self._weighted_vote(predictions)
            
    def _compute_weights(self, X: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Compute performance-based weights."""
        weights = []
        
        for model in self.models:
            # Cross-validation performance
            cv_scores = cross_val_predict(
                model.model, X, y, 
                cv=self.config.cv_folds,
                method='predict'
            )
            
            if len(np.unique(y)) <= 10:  # Classification
                score = accuracy_score(y, cv_scores)
            else:  # Regression
                score = r2_score(y, cv_scores)
                
            weights.append(max(score, 0.1))  # Minimum weight
            
        # Normalize weights
        weights = np.array(weights)
        weights = weights / np.sum(weights)
        
        logger.info(f"Computed weights: {dict(zip([m.model_id for m in self.models], weights))}")
        return weights
        
    def _hard_vote(self, predictions: np.ndarray) -> np.ndarray:
        """Hard voting implementation."""
        # Mode along axis 0 (across models)
        return np.apply_along_axis(
            lambda x: np.bincount(x.astype(int)).argmax(), 
            axis=0, 
            arr=predictions
        )
        
    def _soft_vote(self, probabilities: List[np.ndarray]) -> np.ndarray:
        """Soft voting implementation."""
        # Average probabilities and return class with highest probability
        avg_proba = np.mean(probabilities, axis=0)
        return np.argmax(avg_proba, axis=1)
        
    def _weighted_vote(self, predictions: np.ndarray) -> np.ndarray:
        """Weighted voting implementation."""
        return np.average(predictions, axis=0, weights=self.weights)

class StackingEnsemble:
    """Stacking ensemble with configurable meta-learners."""
    
    def __init__(self, models: List[BaseModel], config: EnsembleConfig):
        self.models = models
        self.config = config
        self.meta_learner = self._create_meta_learner()
        self.is_fitted = False
        
    def _create_meta_learner(self) -> BaseEstimator:
        """Create meta-learner based on configuration."""
        if self.config.stacking_meta_learner == "linear":
            return LinearRegression()
        elif self.config.stacking_meta_learner == "rf":
            return RandomForestRegressor(
                n_estimators=100, 
                random_state=self.config.random_state
            )
        elif self.config.stacking_meta_learner == "neural":
            return MLPRegressor(
                hidden_layer_sizes=(100, 50),
                random_state=self.config.random_state,
                max_iter=1000
            )
        else:
            raise ValueError(f"Unknown meta-learner: {self.config.stacking_meta_learner}")
            
    def fit(self, X: np.ndarray, y: np.ndarray) -> 'StackingEnsemble':
        """Train base models and meta-learner."""
        logger.info(f"Training stacking ensemble with {len(self.models)} base models")
        
        # Generate out-of-fold predictions for meta-features
        meta_features = self._generate_meta_features(X, y)
        
        # Train all base models on full dataset
        for model in self.models:
            logger.info(f"Training base model: {model.model_id}")
            model.fit(X, y)
            
        # Train meta-learner
        logger.info(f"Training meta-learner: {self.config.stacking_meta_learner}")
        self.meta_learner.fit(meta_features, y)
        
        self.is_fitted = True
        return self
        
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Make stacked predictions."""
        if not self.is_fitted:
            raise ValueError("Stacking ensemble must be fitted before prediction")
            
        # Get base model predictions
        base_predictions = []
        for model in self.models:
            pred = model.predict(X)
            base_predictions.append(pred)
            
        # Stack predictions as meta-features
        meta_features = np.column_stack(base_predictions)
        
        # Meta-learner prediction
        return self.meta_learner.predict(meta_features)
        
    def _generate_meta_features(self, X: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Generate out-of-fold predictions for meta-learning."""
        meta_features = []
        
        # Use appropriate cross-validation
        kf = StratifiedKFold(n_splits=self.config.cv_folds, shuffle=True, 
                            random_state=self.config.random_state)
        
        for model in self.models:
            logger.info(f"Generating meta-features for: {model.model_id}")
            
            # Out-of-fold predictions
            oof_predictions = cross_val_predict(
                model.model, X, y, cv=kf, method='predict'
            )
            meta_features.append(oof_predictions)
            
        return np.column_stack(meta_features)

class BlendingEnsemble:
    """Blending ensemble with multiple combination strategies."""
    
    def __init__(self, models: List[BaseModel], config: EnsembleConfig):
        self.models = models
        self.config = config
        self.blend_weights = None
        self.is_fitted = False
        
    def fit(self, X: np.ndarray, y: np.ndarray, 
            X_blend: Optional[np.ndarray] = None, 
            y_blend: Optional[np.ndarray] = None) -> 'BlendingEnsemble':
        """Train models and learn blending weights."""
        logger.info(f"Training blending ensemble with {len(self.models)} models")
        
        # Use holdout set for blending if not provided
        if X_blend is None or y_blend is None:
            # Simple split - use last 20% for blending
            split_idx = int(0.8 * len(X))
            X_train, X_blend = X[:split_idx], X[split_idx:]
            y_train, y_blend = y[:split_idx], y[split_idx:]
        else:
            X_train, y_train = X, y
            
        # Train base models
        for model in self.models:
            logger.info(f"Training model for blending: {model.model_id}")
            model.fit(X_train, y_train)
            
        # Learn blending weights
        self.blend_weights = self._learn_blend_weights(X_blend, y_blend)
        
        self.is_fitted = True
        return self
        
    def predict(self, X: np.ndarray) -> np.ndarray:
        """Make blended predictions."""
        if not self.is_fitted:
            raise ValueError("Blending ensemble must be fitted before prediction")
            
        predictions = []
        for model in self.models:
            pred = model.predict(X)
            predictions.append(pred)
            
        predictions = np.array(predictions)
        
        if self.config.blending_method == "simple":
            return self._simple_blend(predictions)
        elif self.config.blending_method == "hierarchical":
            return self._hierarchical_blend(predictions)
        elif self.config.blending_method == "dynamic":
            return self._dynamic_blend(predictions, X)
        else:
            return self._simple_blend(predictions)
            
    def _learn_blend_weights(self, X_blend: np.ndarray, y_blend: np.ndarray) -> np.ndarray:
        """Learn optimal blending weights."""
        predictions = []
        for model in self.models:
            pred = model.predict(X_blend)
            predictions.append(pred)
            
        predictions = np.array(predictions).T  # Shape: (samples, models)
        
        # Solve for optimal weights using least squares
        try:
            # Add regularization to prevent overfitting
            A = np.column_stack([predictions, np.ones(len(predictions)) * 0.01])
            weights, _, _, _ = np.linalg.lstsq(A, y_blend, rcond=None)
            weights = weights[:-1]  # Remove regularization term
            
            # Ensure non-negative weights and normalize
            weights = np.maximum(weights, 0.01)
            weights = weights / np.sum(weights)
            
        except np.linalg.LinAlgError:
            # Fallback to equal weights
            weights = np.ones(len(self.models)) / len(self.models)
            
        logger.info(f"Learned blend weights: {dict(zip([m.model_id for m in self.models], weights))}")
        return weights
        
    def _simple_blend(self, predictions: np.ndarray) -> np.ndarray:
        """Simple weighted blending."""
        return np.average(predictions, axis=0, weights=self.blend_weights)
        
    def _hierarchical_blend(self, predictions: np.ndarray) -> np.ndarray:
        """Hierarchical blending with grouping."""
        # Group models by type/performance and blend hierarchically
        # For simplicity, use two-level blending
        n_models = len(predictions)
        mid_point = n_models // 2
        
        # First level blending
        group1 = np.average(predictions[:mid_point], axis=0)
        group2 = np.average(predictions[mid_point:], axis=0)
        
        # Second level blending
        return 0.5 * group1 + 0.5 * group2
        
    def _dynamic_blend(self, predictions: np.ndarray, X: np.ndarray) -> np.ndarray:
        """Dynamic blending based on input characteristics."""
        # Simple dynamic blending based on prediction confidence
        confidences = np.std(predictions, axis=0)
        
        # Higher weight to models when confidence is low (high variance)
        dynamic_weights = 1.0 / (confidences + 1e-8)
        dynamic_weights = dynamic_weights / np.sum(dynamic_weights)
        
        return np.average(predictions, axis=0, weights=dynamic_weights)

class EnsembleManager:
    """Main ensemble management system."""
    
    def __init__(self, config: EnsembleConfig):
        self.config = config
        self.models: List[BaseModel] = []
        self.ensembles: Dict[str, Any] = {}
        self.performance_history: List[Dict] = []
        
    def add_model(self, model_id: str, model: Any) -> None:
        """Add a model to the ensemble pool."""
        wrapped_model = WrappedModel(model_id, model)
        self.models.append(wrapped_model)
        logger.info(f"Added model: {model_id}")
        
    def create_voting_ensemble(self, name: str, 
                             model_ids: Optional[List[str]] = None) -> VotingEnsemble:
        """Create a voting ensemble."""
        selected_models = self._select_models(model_ids)
        ensemble = VotingEnsemble(selected_models, self.config)
        self.ensembles[name] = ensemble
        return ensemble
        
    def create_stacking_ensemble(self, name: str,
                               model_ids: Optional[List[str]] = None) -> StackingEnsemble:
        """Create a stacking ensemble."""
        selected_models = self._select_models(model_ids)
        ensemble = StackingEnsemble(selected_models, self.config)
        self.ensembles[name] = ensemble
        return ensemble
        
    def create_blending_ensemble(self, name:str,
                               model_ids: Optional[List[str]] = None) -> BlendingEnsemble:
        """Create a blending ensemble."""
        selected_models = self._select_models(model_ids)
        ensemble = BlendingEnsemble(selected_models, self.config)
        self.ensembles[name] = ensemble
        return ensemble
        
    def _select_models(self, model_ids: Optional[List[str]]) -> List[BaseModel]:
        """Select models for ensemble."""
        if model_ids is None:
            return self.models.copy()
        return [m for m in self.models if m.model_id in model_ids]
        
    def evaluate_ensemble(self, ensemble_name: str, X_test: np.ndarray, 
                         y_test: np.ndarray) -> Dict[str, float]:
        """Evaluate ensemble performance."""
        if ensemble_name not in self.ensembles:
            raise ValueError(f"Ensemble {ensemble_name} not found")
            
        ensemble = self.ensembles[ensemble_name]
        predictions = ensemble.predict(X_test)
        
        metrics = {}
        if len(np.unique(y_test)) <= 10:  # Classification
            metrics['accuracy'] = accuracy_score(y_test, predictions)
            metrics['f1_score'] = f1_score(y_test, predictions, average='weighted')
        else:  # Regression
            metrics['mse'] = mean_squared_error(y_test, predictions)
            metrics['rmse'] = np.sqrt(metrics['mse'])
            metrics['r2_score'] = r2_score(y_test, predictions)
            
        logger.info(f"Ensemble {ensemble_name} metrics: {metrics}")
        return metrics
        
    def save_ensemble(self, ensemble_name: str, filepath: str) -> None:
        """Save ensemble to disk."""
        if ensemble_name not in self.ensembles:
            raise ValueError(f"Ensemble {ensemble_name} not found")
            
        ensemble_data = {
            'ensemble': self.ensembles[ensemble_name],
            'config': self.config,
            'timestamp': datetime.now().isoformat()
        }
        
        with open(filepath, 'wb') as f:
            pickle.dump(ensemble_data, f)
            
        logger.info(f"Saved ensemble {ensemble_name} to {filepath}")
        
    def load_ensemble(self, ensemble_name: str, filepath: str) -> None:
        """Load ensemble from disk."""
        with open(filepath, 'rb') as f:
            ensemble_data = pickle.load(f)
            
        self.ensembles[ensemble_name] = ensemble_data['ensemble']
        logger.info(f"Loaded ensemble {ensemble_name} from {filepath}")
        
    def get_model_diversity(self) -> Dict[str, float]:
        """Calculate model diversity metrics."""
        if len(self.models) < 2:
            return {}
            
        # This would require actual predictions to compute
        # For now, return placeholder
        diversity_metrics = {
            'correlation_coefficient': 0.0,
            'disagreement_measure': 0.0,
            'q_statistic': 0.0
        }
        return diversity_metrics
        
    def export_performance_report(self, filepath: str) -> None:
        """Export comprehensive performance report."""
        report = {
            'timestamp': datetime.now().isoformat(),
            'config': self.config.__dict__,
            'models': [
                {
                    'model_id': m.model_id,
                    'performance': m.performance.__dict__
                }
                for m in self.models
            ],
            'ensembles': list(self.ensembles.keys()),
            'performance_history': self.performance_history
        }
        
        with open(filepath, 'w') as f:
            json.dump(report, f, indent=2, default=str)
            
        logger.info(f"Exported performance report to {filepath}")

# Example usage and demonstration
def create_sample_ensemble_system():
    """Create a sample ensemble system for demonstration."""
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.svm import SVC
    from sklearn.linear_model import LogisticRegression
    from sklearn.datasets import make_classification
    
    # Generate sample data
    X, y = make_classification(
        n_samples=1000, n_features=20, n_informative=10,
        n_redundant=10, n_classes=3, random_state=42
    )
    
    # Split data
    split_idx = int(0.8 * len(X))
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    # Create ensemble manager
    config = EnsembleConfig(
        voting_strategy="weighted",
        stacking_meta_learner="rf",
        blending_method="dynamic"
    )
    
    manager = EnsembleManager(config)
    
    # Add base models
    manager.add_model("rf", RandomForestClassifier(n_estimators=100, random_state=42))
    manager.add_model("gb", GradientBoostingClassifier(n_estimators=100, random_state=42))
    manager.add_model("svm", SVC(probability=True, random_state=42))
    manager.add_model("lr", LogisticRegression(random_state=42))
    
    # Create different types of ensembles
    voting_ensemble = manager.create_voting_ensemble("voting_ensemble")
    stacking_ensemble = manager.create_stacking_ensemble("stacking_ensemble")
    blending_ensemble = manager.create_blending_ensemble("blending_ensemble")
    
    # Train ensembles
    print("Training ensembles...")
    voting_ensemble.fit(X_train, y_train)
    stacking_ensemble.fit(X_train, y_train)
    blending_ensemble.fit(X_train, y_train)
    
    # Evaluate ensembles
    print("\nEvaluating ensembles...")
    for name in manager.ensembles.keys():
        metrics = manager.evaluate_ensemble(name, X_test, y_test)
        print(f"{name}: {metrics}")
    
    # Export report
    manager.export_performance_report("ensemble_performance_report.json")
    
    return manager

if __name__ == "__main__":
    # Run demonstration
    print("Creating sample ensemble system...")
    manager = create_sample_ensemble_system()
    print("\nEnsemble system demonstration completed!")
    print("Check 'ensemble_performance_report.json' for detailed results.")