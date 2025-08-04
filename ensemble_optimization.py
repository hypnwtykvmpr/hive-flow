#!/usr/bin/env python3
"""
Ensemble Optimization System
Advanced hyperparameter tuning and optimization for ensemble models
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Any, Optional
from itertools import product
from sklearn.model_selection import cross_val_score, ParameterGrid
from sklearn.metrics import accuracy_score, mean_squared_error, f1_score
from sklearn.datasets import make_classification, make_regression
import optuna
import logging
from datetime import datetime
import json

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class EnsembleOptimizer:
    """Advanced ensemble optimization system."""
    
    def __init__(self, ensemble_manager, optimization_metric='accuracy'):
        self.ensemble_manager = ensemble_manager
        self.optimization_metric = optimization_metric
        self.optimization_history = []
        self.best_config = None
        self.best_score = -np.inf if optimization_metric in ['accuracy', 'f1', 'r2'] else np.inf
        
    def grid_search_optimization(self, X_train, y_train, X_val, y_val, 
                                param_grid: Dict[str, List]) -> Dict[str, Any]:
        """Perform grid search optimization for ensemble parameters."""
        logger.info("Starting grid search optimization...")
        
        best_config = None
        best_score = self.best_score
        results = []
        
        # Generate all parameter combinations
        param_combinations = list(ParameterGrid(param_grid))
        
        for i, params in enumerate(param_combinations):
            logger.info(f"Testing configuration {i+1}/{len(param_combinations)}: {params}")
            
            try:
                # Update ensemble configuration
                for key, value in params.items():
                    setattr(self.ensemble_manager.config, key, value)
                
                # Create and train ensemble
                ensemble_name = f"grid_search_{i}"
                if 'voting_strategy' in params:
                    ensemble = self.ensemble_manager.create_voting_ensemble(ensemble_name)
                elif 'stacking_meta_learner' in params:
                    ensemble = self.ensemble_manager.create_stacking_ensemble(ensemble_name)
                else:
                    ensemble = self.ensemble_manager.create_blending_ensemble(ensemble_name)
                
                ensemble.fit(X_train, y_train)
                
                # Evaluate performance
                predictions = ensemble.predict(X_val)
                score = self._calculate_score(y_val, predictions)
                
                results.append({
                    'params': params.copy(),
                    'score': score,
                    'ensemble_type': type(ensemble).__name__
                })
                
                # Update best configuration
                is_better = (score > best_score if self.optimization_metric in ['accuracy', 'f1', 'r2'] 
                           else score < best_score)
                
                if is_better:
                    best_score = score
                    best_config = params.copy()
                    self.best_config = best_config
                    self.best_score = best_score
                    
                logger.info(f"Score: {score:.4f} (Best: {best_score:.4f})")
                
            except Exception as e:
                logger.error(f"Error in configuration {params}: {str(e)}")
                continue
        
        # Store optimization history
        self.optimization_history.extend(results)
        
        logger.info(f"Grid search completed. Best score: {best_score:.4f}")
        logger.info(f"Best configuration: {best_config}")
        
        return {
            'best_config': best_config,
            'best_score': best_score,
            'all_results': results
        }
    
    def bayesian_optimization(self, X_train, y_train, X_val, y_val, 
                            n_trials: int = 100) -> Dict[str, Any]:
        """Perform Bayesian optimization using Optuna."""
        logger.info(f"Starting Bayesian optimization with {n_trials} trials...")
        
        def objective(trial):
            # Define hyperparameter space
            voting_strategy = trial.suggest_categorical(
                'voting_strategy', ['hard', 'soft', 'weighted']
            )
            stacking_meta_learner = trial.suggest_categorical(
                'stacking_meta_learner', ['linear', 'rf', 'neural']
            )
            blending_method = trial.suggest_categorical(
                'blending_method', ['simple', 'hierarchical', 'dynamic']
            )
            cv_folds = trial.suggest_int('cv_folds', 3, 10)
            
            # Update configuration
            self.ensemble_manager.config.voting_strategy = voting_strategy
            self.ensemble_manager.config.stacking_meta_learner = stacking_meta_learner
            self.ensemble_manager.config.blending_method = blending_method
            self.ensemble_manager.config.cv_folds = cv_folds
            
            # Suggest ensemble type
            ensemble_type = trial.suggest_categorical(
                'ensemble_type', ['voting', 'stacking', 'blending']
            )
            
            try:
                # Create and train ensemble
                ensemble_name = f"bayesian_{trial.number}"
                if ensemble_type == 'voting':
                    ensemble = self.ensemble_manager.create_voting_ensemble(ensemble_name)
                elif ensemble_type == 'stacking':
                    ensemble = self.ensemble_manager.create_stacking_ensemble(ensemble_name)
                else:
                    ensemble = self.ensemble_manager.create_blending_ensemble(ensemble_name)
                
                ensemble.fit(X_train, y_train)
                
                # Evaluate performance
                predictions = ensemble.predict(X_val)
                score = self._calculate_score(y_val, predictions)
                
                # Store result
                self.optimization_history.append({
                    'trial': trial.number,
                    'params': trial.params.copy(),
                    'score': score,
                    'ensemble_type': ensemble_type
                })
                
                return score
                
            except Exception as e:
                logger.error(f"Error in trial {trial.number}: {str(e)}")
                # Return worst possible score for failed trials
                return -np.inf if self.optimization_metric in ['accuracy', 'f1', 'r2'] else np.inf
        
        # Create study and optimize
        direction = 'maximize' if self.optimization_metric in ['accuracy', 'f1', 'r2'] else 'minimize'
        study = optuna.create_study(direction=direction)
        study.optimize(objective, n_trials=n_trials)
        
        # Update best configuration
        self.best_config = study.best_params
        self.best_score = study.best_value
        
        logger.info(f"Bayesian optimization completed. Best score: {study.best_value:.4f}")
        logger.info(f"Best configuration: {study.best_params}")
        
        return {
            'best_config': study.best_params,
            'best_score': study.best_value,
            'study': study,
            'optimization_history': self.optimization_history
        }
    
    def evolutionary_optimization(self, X_train, y_train, X_val, y_val,
                                population_size: int = 20, generations: int = 10) -> Dict[str, Any]:
        """Perform evolutionary optimization (genetic algorithm approach)."""
        logger.info(f"Starting evolutionary optimization: {population_size} individuals, {generations} generations")
        
        # Define parameter bounds
        param_space = {
            'voting_strategy': ['hard', 'soft', 'weighted'],
            'stacking_meta_learner': ['linear', 'rf', 'neural'],
            'blending_method': ['simple', 'hierarchical', 'dynamic'],
            'cv_folds': list(range(3, 11)),
            'ensemble_type': ['voting', 'stacking', 'blending']
        }
        
        # Initialize population
        population = []
        for _ in range(population_size):
            individual = {
                param: np.random.choice(values) 
                for param, values in param_space.items()
            }
            population.append(individual)
        
        evolution_history = []
        
        for generation in range(generations):
            logger.info(f"Generation {generation + 1}/{generations}")
            
            # Evaluate population
            fitness_scores = []
            for i, individual in enumerate(population):
                try:
                    score = self._evaluate_individual(individual, X_train, y_train, X_val, y_val)
                    fitness_scores.append(score)
                    
                    self.optimization_history.append({
                        'generation': generation,
                        'individual': i,
                        'params': individual.copy(),
                        'score': score
                    })
                    
                except Exception as e:
                    logger.error(f"Error evaluating individual {i}: {str(e)}")
                    # Assign worst possible fitness
                    worst_score = -np.inf if self.optimization_metric in ['accuracy', 'f1', 'r2'] else np.inf
                    fitness_scores.append(worst_score)
            
            # Selection and reproduction
            population = self._evolve_population(population, fitness_scores, param_space)
            
            # Track best in generation
            best_idx = np.argmax(fitness_scores) if self.optimization_metric in ['accuracy', 'f1', 'r2'] else np.argmin(fitness_scores)
            best_score = fitness_scores[best_idx]
            best_individual = population[best_idx]
            
            evolution_history.append({
                'generation': generation,
                'best_score': best_score,
                'best_individual': best_individual.copy(),
                'population_stats': {
                    'mean_fitness': np.mean(fitness_scores),
                    'std_fitness': np.std(fitness_scores)
                }
            })
            
            # Update global best
            is_better = (best_score > self.best_score if self.optimization_metric in ['accuracy', 'f1', 'r2'] 
                        else best_score < self.best_score)
            
            if is_better:
                self.best_score = best_score
                self.best_config = best_individual.copy()
            
            logger.info(f"Generation {generation + 1} best: {best_score:.4f} (Global best: {self.best_score:.4f})")
        
        logger.info(f"Evolutionary optimization completed. Best score: {self.best_score:.4f}")
        logger.info(f"Best configuration: {self.best_config}")
        
        return {
            'best_config': self.best_config,
            'best_score': self.best_score,
            'evolution_history': evolution_history,
            'final_population': population
        }
    
    def _evaluate_individual(self, individual: Dict, X_train, y_train, X_val, y_val) -> float:
        """Evaluate a single individual in evolutionary optimization."""
        # Update configuration
        self.ensemble_manager.config.voting_strategy = individual['voting_strategy']
        self.ensemble_manager.config.stacking_meta_learner = individual['stacking_meta_learner']
        self.ensemble_manager.config.blending_method = individual['blending_method']
        self.ensemble_manager.config.cv_folds = individual['cv_folds']
        
        # Create ensemble
        ensemble_name = f"evolution_{np.random.randint(0, 10000)}"
        if individual['ensemble_type'] == 'voting':
            ensemble = self.ensemble_manager.create_voting_ensemble(ensemble_name)
        elif individual['ensemble_type'] == 'stacking':
            ensemble = self.ensemble_manager.create_stacking_ensemble(ensemble_name)
        else:
            ensemble = self.ensemble_manager.create_blending_ensemble(ensemble_name)
        
        # Train and evaluate
        ensemble.fit(X_train, y_train)
        predictions = ensemble.predict(X_val)
        return self._calculate_score(y_val, predictions)
    
    def _evolve_population(self, population: List[Dict], fitness_scores: List[float], 
                          param_space: Dict) -> List[Dict]:
        """Evolve population using selection, crossover, and mutation."""
        new_population = []
        
        # Sort by fitness (best first)
        if self.optimization_metric in ['accuracy', 'f1', 'r2']:
            sorted_indices = np.argsort(fitness_scores)[::-1]  # Descending
        else:
            sorted_indices = np.argsort(fitness_scores)  # Ascending
        
        # Elitism - keep best 20%
        elite_size = max(1, len(population) // 5)
        for i in range(elite_size):
            new_population.append(population[sorted_indices[i]].copy())
        
        # Generate rest through crossover and mutation
        while len(new_population) < len(population):
            # Tournament selection
            parent1 = self._tournament_selection(population, fitness_scores, tournament_size=3)
            parent2 = self._tournament_selection(population, fitness_scores, tournament_size=3)
            
            # Crossover
            child = self._crossover(parent1, parent2, param_space)
            
            # Mutation
            child = self._mutate(child, param_space, mutation_rate=0.1)
            
            new_population.append(child)
        
        return new_population
    
    def _tournament_selection(self, population: List[Dict], fitness_scores: List[float], 
                            tournament_size: int = 3) -> Dict:
        """Tournament selection for evolutionary algorithm."""
        tournament_indices = np.random.choice(len(population), tournament_size, replace=False)
        tournament_fitness = [fitness_scores[i] for i in tournament_indices]
        
        if self.optimization_metric in ['accuracy', 'f1', 'r2']:
            winner_idx = tournament_indices[np.argmax(tournament_fitness)]
        else:
            winner_idx = tournament_indices[np.argmin(tournament_fitness)]
        
        return population[winner_idx].copy()
    
    def _crossover(self, parent1: Dict, parent2: Dict, param_space: Dict) -> Dict:
        """Uniform crossover for parameter dictionaries."""
        child = {}
        for param in param_space:
            # Randomly choose from either parent
            child[param] = parent1[param] if np.random.random() < 0.5 else parent2[param]
        return child
    
    def _mutate(self, individual: Dict, param_space: Dict, mutation_rate: float = 0.1) -> Dict:
        """Mutate individual with given probability."""
        mutated = individual.copy()
        
        for param in param_space:
            if np.random.random() < mutation_rate:
                mutated[param] = np.random.choice(param_space[param])
        
        return mutated
    
    def _calculate_score(self, y_true, y_pred) -> float:
        """Calculate optimization score based on metric."""
        if self.optimization_metric == 'accuracy':
            return accuracy_score(y_true, y_pred)
        elif self.optimization_metric == 'f1':
            return f1_score(y_true, y_pred, average='weighted')
        elif self.optimization_metric == 'mse':
            return mean_squared_error(y_true, y_pred)
        elif self.optimization_metric == 'rmse':
            return np.sqrt(mean_squared_error(y_true, y_pred))
        else:
            # Default to accuracy for classification
            return accuracy_score(y_true, y_pred)
    
    def export_optimization_results(self, filepath: str) -> None:
        """Export optimization results to file."""
        results = {
            'optimization_metric': self.optimization_metric,
            'best_config': self.best_config,
            'best_score': self.best_score,
            'optimization_history': self.optimization_history,
            'timestamp': datetime.now().isoformat()
        }
        
        with open(filepath, 'w') as f:
            json.dump(results, f, indent=2, default=str)
        
        logger.info(f"Optimization results exported to {filepath}")

def run_comprehensive_optimization():
    """Run comprehensive ensemble optimization demonstration."""
    from ensemble_implementation import EnsembleManager, EnsembleConfig
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.svm import SVC
    from sklearn.model_selection import train_test_split
    
    print("Running comprehensive ensemble optimization...")
    
    # Generate dataset
    X, y = make_classification(
        n_samples=1500, n_features=20, n_informative=15,
        n_redundant=3, n_classes=3, random_state=42
    )
    
    # Split data
    X_train, X_temp, y_train, y_temp = train_test_split(X, y, test_size=0.4, random_state=42)
    X_val, X_test, y_val, y_test = train_test_split(X_temp, y_temp, test_size=0.5, random_state=42)
    
    # Create ensemble manager
    config = EnsembleConfig()
    manager = EnsembleManager(config)
    
    # Add diverse base models
    manager.add_model("rf", RandomForestClassifier(n_estimators=50, random_state=42))
    manager.add_model("gb", GradientBoostingClassifier(n_estimators=50, random_state=42))
    manager.add_model("lr", LogisticRegression(random_state=42, max_iter=1000))
    manager.add_model("svm", SVC(probability=True, random_state=42))
    
    # Create optimizer
    optimizer = EnsembleOptimizer(manager, optimization_metric='accuracy')
    
    # 1. Grid Search Optimization
    print("\n1. Grid Search Optimization")
    param_grid = {
        'voting_strategy': ['hard', 'soft', 'weighted'],
        'cv_folds': [3, 5],
    }
    
    grid_results = optimizer.grid_search_optimization(X_train, y_train, X_val, y_val, param_grid)
    print(f"Grid search best score: {grid_results['best_score']:.4f}")
    
    # 2. Bayesian Optimization
    print("\n2. Bayesian Optimization")
    bayesian_results = optimizer.bayesian_optimization(
        X_train, y_train, X_val, y_val, n_trials=20  # Reduced for demo
    )
    print(f"Bayesian optimization best score: {bayesian_results['best_score']:.4f}")
    
    # 3. Evolutionary Optimization
    print("\n3. Evolutionary Optimization")
    evolution_results = optimizer.evolutionary_optimization(
        X_train, y_train, X_val, y_val, 
        population_size=10, generations=5  # Reduced for demo
    )
    print(f"Evolutionary optimization best score: {evolution_results['best_score']:.4f}")
    
    # Apply best configuration and test on hold-out set
    print("\n4. Final Evaluation")
    
    # Use best configuration from all methods
    all_scores = [
        grid_results['best_score'],
        bayesian_results['best_score'], 
        evolution_results['best_score']
    ]
    
    all_configs = [
        grid_results['best_config'],
        bayesian_results['best_config'],
        evolution_results['best_config']
    ]
    
    best_method_idx = np.argmax(all_scores)
    final_config = all_configs[best_method_idx]
    final_score = all_scores[best_method_idx]
    
    method_names = ['Grid Search', 'Bayesian', 'Evolutionary']
    print(f"Best method: {method_names[best_method_idx]} (Score: {final_score:.4f})")
    print(f"Best configuration: {final_config}")
    
    # Apply best configuration and test
    for key, value in final_config.items():
        if hasattr(manager.config, key):
            setattr(manager.config, key, value)
    
    # Create final optimized ensemble
    if final_config.get('ensemble_type') == 'voting' or 'voting_strategy' in final_config:
        final_ensemble = manager.create_voting_ensemble("optimized_final")
    elif final_config.get('ensemble_type') == 'stacking' or 'stacking_meta_learner' in final_config:
        final_ensemble = manager.create_stacking_ensemble("optimized_final")
    else:
        final_ensemble = manager.create_blending_ensemble("optimized_final")
    
    final_ensemble.fit(X_train, y_train)
    test_predictions = final_ensemble.predict(X_test)
    test_accuracy = accuracy_score(y_test, test_predictions)
    
    print(f"Final test accuracy: {test_accuracy:.4f}")
    
    # Export results
    optimizer.export_optimization_results("optimization_results.json")
    
    return {
        'grid_results': grid_results,
        'bayesian_results': bayesian_results,
        'evolution_results': evolution_results,
        'final_test_accuracy': test_accuracy,
        'best_config': final_config
    }

if __name__ == "__main__":
    # Run comprehensive optimization
    results = run_comprehensive_optimization()
    print("\nOptimization completed! Check 'optimization_results.json' for detailed results.")