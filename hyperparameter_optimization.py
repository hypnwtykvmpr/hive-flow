#!/usr/bin/env python3
"""
MLE-STAR Hyperparameter Optimization Framework
Refinement Phase Implementation

Agent: Refinement Specialist
Session: automation-session-1754319839721-scewi2uw3
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Any, Optional
import optuna
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler, MinMaxScaler, RobustScaler
from sklearn.feature_selection import SelectKBest, RFE
from sklearn.pipeline import Pipeline
import joblib
import json
import time
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class MLESTAROptimizer:
    """
    Advanced hyperparameter optimization using Bayesian methods, Grid Search,
    and Evolutionary algorithms as part of MLE-STAR refinement phase.
    """
    
    def __init__(self, 
                 optimization_method: str = 'bayesian',
                 n_trials: int = 100,
                 cv_folds: int = 5,
                 random_state: int = 42):
        self.optimization_method = optimization_method
        self.n_trials = n_trials
        self.cv_folds = cv_folds
        self.random_state = random_state
        self.best_params = {}
        self.best_score = 0.0
        self.optimization_history = []
        self.study = None
        
        # Performance tracking
        self.start_time = None
        self.optimization_log = []
        
    def define_search_space(self) -> Dict[str, Any]:
        """
        Define comprehensive hyperparameter search space based on 
        foundation phase analysis and ablation study results.
        """
        search_space = {
            # Preprocessing parameters
            'scaler_type': ['standard', 'minmax', 'robust'],
            'feature_selection_k': [10, 20, 50, 100, 'all'],
            
            # Model architecture parameters
            'model_type': ['rf', 'gb', 'mlp', 'lr'],
            
            # Random Forest parameters
            'rf_n_estimators': [50, 100, 200, 300, 500],
            'rf_max_depth': [3, 5, 7, 10, None],
            'rf_min_samples_split': [2, 5, 10, 20],
            'rf_min_samples_leaf': [1, 2, 4, 8],
            
            # Gradient Boosting parameters
            'gb_n_estimators': [50, 100, 200, 300],
            'gb_learning_rate': [0.01, 0.05, 0.1, 0.2, 0.3],
            'gb_max_depth': [3, 4, 5, 6, 7],
            'gb_subsample': [0.6, 0.7, 0.8, 0.9, 1.0],
            
            # Neural Network parameters
            'mlp_hidden_layer_sizes': [(50,), (100,), (50, 50), (100, 50), (100, 100)],
            'mlp_learning_rate_init': [0.001, 0.01, 0.1],
            'mlp_alpha': [0.0001, 0.001, 0.01, 0.1],
            'mlp_max_iter': [200, 300, 500],
            
            # Logistic Regression parameters
            'lr_C': [0.01, 0.1, 1.0, 10.0, 100.0],
            'lr_penalty': ['l1', 'l2', 'elasticnet'],
            'lr_solver': ['liblinear', 'saga']
        }
        
        return search_space
    
    def create_model_pipeline(self, params: Dict[str, Any]) -> Pipeline:
        """Create ML pipeline based on hyperparameters."""
        
        # Preprocessing components
        if params['scaler_type'] == 'standard':
            scaler = StandardScaler()
        elif params['scaler_type'] == 'minmax':
            scaler = MinMaxScaler()
        else:  # robust
            scaler = RobustScaler()
        
        # Feature selection
        if params['feature_selection_k'] != 'all':
            feature_selector = SelectKBest(k=params['feature_selection_k'])
        else:
            feature_selector = 'passthrough'
        
        # Model selection
        if params['model_type'] == 'rf':
            model = RandomForestClassifier(
                n_estimators=params['rf_n_estimators'],
                max_depth=params['rf_max_depth'],
                min_samples_split=params['rf_min_samples_split'],
                min_samples_leaf=params['rf_min_samples_leaf'],
                random_state=self.random_state,
                n_jobs=-1
            )
        elif params['model_type'] == 'gb':
            model = GradientBoostingClassifier(
                n_estimators=params['gb_n_estimators'],
                learning_rate=params['gb_learning_rate'],
                max_depth=params['gb_max_depth'],
                subsample=params['gb_subsample'],
                random_state=self.random_state
            )
        elif params['model_type'] == 'mlp':
            model = MLPClassifier(
                hidden_layer_sizes=params['mlp_hidden_layer_sizes'],
                learning_rate_init=params['mlp_learning_rate_init'],
                alpha=params['mlp_alpha'],
                max_iter=params['mlp_max_iter'],
                random_state=self.random_state
            )
        else:  # lr
            model = LogisticRegression(
                C=params['lr_C'],
                penalty=params['lr_penalty'],
                solver=params['lr_solver'],
                random_state=self.random_state,
                max_iter=1000
            )
        
        # Create pipeline
        pipeline = Pipeline([
            ('scaler', scaler),
            ('feature_selector', feature_selector),
            ('model', model)
        ])
        
        return pipeline
    
    def objective_function(self, trial) -> float:
        """Optuna objective function for Bayesian optimization."""
        
        # Sample hyperparameters
        params = {
            'scaler_type': trial.suggest_categorical('scaler_type', ['standard', 'minmax', 'robust']),
            'feature_selection_k': trial.suggest_categorical('feature_selection_k', [10, 20, 50, 100, 'all']),
            'model_type': trial.suggest_categorical('model_type', ['rf', 'gb', 'mlp', 'lr'])
        }
        
        # Model-specific parameters
        if params['model_type'] == 'rf':
            params.update({
                'rf_n_estimators': trial.suggest_categorical('rf_n_estimators', [50, 100, 200, 300, 500]),
                'rf_max_depth': trial.suggest_categorical('rf_max_depth', [3, 5, 7, 10, None]),
                'rf_min_samples_split': trial.suggest_categorical('rf_min_samples_split', [2, 5, 10, 20]),
                'rf_min_samples_leaf': trial.suggest_categorical('rf_min_samples_leaf', [1, 2, 4, 8])
            })
        elif params['model_type'] == 'gb':
            params.update({
                'gb_n_estimators': trial.suggest_categorical('gb_n_estimators', [50, 100, 200, 300]),
                'gb_learning_rate': trial.suggest_categorical('gb_learning_rate', [0.01, 0.05, 0.1, 0.2, 0.3]),
                'gb_max_depth': trial.suggest_categorical('gb_max_depth', [3, 4, 5, 6, 7]),
                'gb_subsample': trial.suggest_categorical('gb_subsample', [0.6, 0.7, 0.8, 0.9, 1.0])
            })
        elif params['model_type'] == 'mlp':
            params.update({
                'mlp_hidden_layer_sizes': trial.suggest_categorical('mlp_hidden_layer_sizes', 
                                                                   [(50,), (100,), (50, 50), (100, 50), (100, 100)]),
                'mlp_learning_rate_init': trial.suggest_categorical('mlp_learning_rate_init', [0.001, 0.01, 0.1]),
                'mlp_alpha': trial.suggest_categorical('mlp_alpha', [0.0001, 0.001, 0.01, 0.1]),
                'mlp_max_iter': trial.suggest_categorical('mlp_max_iter', [200, 300, 500])
            })
        else:  # lr
            params.update({
                'lr_C': trial.suggest_categorical('lr_C', [0.01, 0.1, 1.0, 10.0, 100.0]),
                'lr_penalty': trial.suggest_categorical('lr_penalty', ['l1', 'l2', 'elasticnet']),
                'lr_solver': trial.suggest_categorical('lr_solver', ['liblinear', 'saga'])
            })
        
        # Create and evaluate pipeline
        try:
            pipeline = self.create_model_pipeline(params)
            cv_scores = cross_val_score(
                pipeline, self.X_train, self.y_train,
                cv=StratifiedKFold(n_splits=self.cv_folds, shuffle=True, random_state=self.random_state),
                scoring='accuracy',
                n_jobs=-1
            )
            
            mean_score = np.mean(cv_scores)
            std_score = np.std(cv_scores)
            
            # Log optimization step
            self.optimization_log.append({
                'trial': trial.number,
                'params': params,
                'mean_score': mean_score,
                'std_score': std_score,
                'timestamp': datetime.now().isoformat()
            })
            
            logger.info(f"Trial {trial.number}: {mean_score:.4f} (+/- {std_score:.4f}) - {params['model_type']}")
            
            return mean_score
            
        except Exception as e:
            logger.warning(f"Trial {trial.number} failed: {str(e)}")
            return 0.0
    
    def optimize_hyperparameters(self, X_train: np.ndarray, y_train: np.ndarray) -> Dict[str, Any]:
        """
        Execute hyperparameter optimization using specified method.
        """
        self.X_train = X_train
        self.y_train = y_train
        self.start_time = time.time()
        
        logger.info(f"Starting {self.optimization_method} hyperparameter optimization...")
        logger.info(f"Training data shape: {X_train.shape}")
        logger.info(f"Number of trials: {self.n_trials}")
        
        if self.optimization_method == 'bayesian':
            return self._bayesian_optimization()
        elif self.optimization_method == 'grid':
            return self._grid_search_optimization()
        elif self.optimization_method == 'evolutionary':
            return self._evolutionary_optimization()
        else:
            raise ValueError(f"Unknown optimization method: {self.optimization_method}")
    
    def _bayesian_optimization(self) -> Dict[str, Any]:
        """Bayesian optimization using Optuna."""
        
        # Create study
        self.study = optuna.create_study(
            direction='maximize',
            sampler=optuna.samplers.TPESampler(seed=self.random_state),
            pruner=optuna.pruners.MedianPruner(n_startup_trials=10, n_warmup_steps=5)
        )
        
        # Optimize
        self.study.optimize(self.objective_function, n_trials=self.n_trials)
        
        # Extract best results
        self.best_params = self.study.best_params
        self.best_score = self.study.best_value
        
        # Calculate optimization time
        optimization_time = time.time() - self.start_time
        
        results = {
            'method': 'bayesian',
            'best_params': self.best_params,
            'best_score': self.best_score,
            'optimization_time': optimization_time,
            'n_trials': len(self.study.trials),
            'optimization_log': self.optimization_log[-10:],  # Last 10 trials
            'study_summary': {
                'best_trial': self.study.best_trial.number,
                'best_value': self.study.best_value,
                'n_complete_trials': len([t for t in self.study.trials if t.state == optuna.trial.TrialState.COMPLETE])
            }
        }
        
        logger.info(f"Bayesian optimization completed in {optimization_time:.2f} seconds")
        logger.info(f"Best score: {self.best_score:.4f}")
        logger.info(f"Best parameters: {self.best_params}")
        
        return results
    
    def _grid_search_optimization(self) -> Dict[str, Any]:
        """Grid search optimization (fallback method)."""
        # Simplified grid search implementation
        logger.info("Grid search optimization not fully implemented - using simplified version")
        
        # Define smaller grid for demonstration
        param_grid = {
            'scaler_type': ['standard', 'robust'],
            'model_type': ['rf', 'gb'],
            'feature_selection_k': [20, 50]
        }
        
        best_score = 0.0
        best_params = {}
        trial_count = 0
        
        from itertools import product
        
        # Generate all combinations
        keys = param_grid.keys()
        values = param_grid.values()
        
        for combination in product(*values):
            params = dict(zip(keys, combination))
            
            # Add model-specific default parameters
            if params['model_type'] == 'rf':
                params.update({
                    'rf_n_estimators': 100,
                    'rf_max_depth': 10,
                    'rf_min_samples_split': 5,
                    'rf_min_samples_leaf': 2
                })
            elif params['model_type'] == 'gb':
                params.update({
                    'gb_n_estimators': 100,
                    'gb_learning_rate': 0.1,
                    'gb_max_depth': 5,
                    'gb_subsample': 0.8
                })
            
            try:
                pipeline = self.create_model_pipeline(params)
                cv_scores = cross_val_score(
                    pipeline, self.X_train, self.y_train,
                    cv=StratifiedKFold(n_splits=self.cv_folds, shuffle=True, random_state=self.random_state),
                    scoring='accuracy',
                    n_jobs=-1
                )
                
                mean_score = np.mean(cv_scores)
                
                if mean_score > best_score:
                    best_score = mean_score
                    best_params = params.copy()
                
                trial_count += 1
                logger.info(f"Grid trial {trial_count}: {mean_score:.4f} - {params['model_type']}")
                
            except Exception as e:
                logger.warning(f"Grid trial failed: {str(e)}")
        
        optimization_time = time.time() - self.start_time
        
        results = {
            'method': 'grid_search',
            'best_params': best_params,
            'best_score': best_score,
            'optimization_time': optimization_time,
            'n_trials': trial_count
        }
        
        return results
    
    def _evolutionary_optimization(self) -> Dict[str, Any]:
        """Evolutionary algorithm optimization (placeholder)."""
        logger.info("Evolutionary optimization not implemented - falling back to Bayesian")
        return self._bayesian_optimization()
    
    def create_optimized_model(self) -> Pipeline:
        """Create final optimized model with best parameters."""
        if not self.best_params:
            raise ValueError("No optimization has been performed yet")
        
        return self.create_model_pipeline(self.best_params)
    
    def save_optimization_results(self, filepath: str):
        """Save optimization results to JSON file."""
        results = {
            'optimization_method': self.optimization_method,
            'best_params': self.best_params,
            'best_score': self.best_score,
            'optimization_history': self.optimization_log,
            'metadata': {
                'n_trials': self.n_trials,
                'cv_folds': self.cv_folds,
                'random_state': self.random_state,
                'timestamp': datetime.now().isoformat()
            }
        }
        
        with open(filepath, 'w') as f:
            json.dump(results, f, indent=2, default=str)
        
        logger.info(f"Optimization results saved to {filepath}")

def main():
    """Example usage of MLE-STAR hyperparameter optimization."""
    
    # Generate sample data for demonstration
    from sklearn.datasets import make_classification
    
    X, y = make_classification(
        n_samples=1000,
        n_features=20,
        n_informative=15,
        n_redundant=5,
        random_state=42
    )
    
    # Initialize optimizer
    optimizer = MLESTAROptimizer(
        optimization_method='bayesian',
        n_trials=50,  # Reduced for demo
        cv_folds=5
    )
    
    # Perform optimization
    results = optimizer.optimize_hyperparameters(X, y)
    
    # Save results
    optimizer.save_optimization_results('optimization_results.json')
    
    # Create and save optimized model
    optimized_model = optimizer.create_optimized_model()
    joblib.dump(optimized_model, 'optimized_model.pkl')
    
    print("Hyperparameter optimization completed!")
    print(f"Best score: {results['best_score']:.4f}")
    print(f"Optimization time: {results['optimization_time']:.2f} seconds")

if __name__ == "__main__":
    main()