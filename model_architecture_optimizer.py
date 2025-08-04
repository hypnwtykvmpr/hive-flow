#!/usr/bin/env python3
"""
MLE-STAR Model Architecture Optimization
Advanced architecture refinement based on ablation analysis

Agent: Refinement Specialist
Session: automation-session-1754319839721-scewi2uw3
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Any, Optional, Union
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.ensemble import VotingClassifier, StackingClassifier
from sklearn.model_selection import cross_val_score, StratifiedKFold
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.feature_selection import SelectKBest, RFE, mutual_info_classif
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score, classification_report
import joblib
import json
import logging
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class AblationAnalyzer:
    """
    Systematic ablation analysis to identify high-impact pipeline components.
    """
    
    def __init__(self, base_pipeline: Pipeline, cv_folds: int = 5, random_state: int = 42):
        self.base_pipeline = base_pipeline
        self.cv_folds = cv_folds
        self.random_state = random_state
        self.component_impacts = {}
        self.baseline_score = 0.0
        
    def run_ablation_analysis(self, X: np.ndarray, y: np.ndarray) -> Dict[str, Any]:
        """
        Perform systematic ablation analysis on pipeline components.
        """
        logger.info("Starting ablation analysis...")
        
        # Establish baseline performance
        self.baseline_score = self._evaluate_pipeline(self.base_pipeline, X, y)
        logger.info(f"Baseline score: {self.baseline_score:.4f}")
        
        # Analyze each component type
        component_results = {}
        
        # 1. Data Preprocessing Components
        component_results['preprocessing'] = self._analyze_preprocessing_components(X, y)
        
        # 2. Feature Engineering Components  
        component_results['feature_engineering'] = self._analyze_feature_engineering_components(X, y)
        
        # 3. Model Architecture Components
        component_results['model_architecture'] = self._analyze_model_architecture_components(X, y)
        
        # 4. Hyperparameter Components
        component_results['hyperparameters'] = self._analyze_hyperparameter_components(X, y)
        
        # Rank components by impact
        self.component_impacts = self._rank_components_by_impact(component_results)
        
        logger.info("Ablation analysis completed")
        return {
            'baseline_score': self.baseline_score,
            'component_results': component_results,
            'component_rankings': self.component_impacts,
            'recommendations': self._generate_recommendations()
        }
    
    def _evaluate_pipeline(self, pipeline: Pipeline, X: np.ndarray, y: np.ndarray) -> float:
        """Evaluate pipeline performance using cross-validation."""
        try:
            scores = cross_val_score(
                pipeline, X, y,
                cv=StratifiedKFold(n_splits=self.cv_folds, shuffle=True, random_state=self.random_state),
                scoring='accuracy',
                n_jobs=-1
            )
            return np.mean(scores)
        except Exception as e:
            logger.warning(f"Pipeline evaluation failed: {str(e)}")
            return 0.0
    
    def _analyze_preprocessing_components(self, X: np.ndarray, y: np.ndarray) -> Dict[str, float]:
        """Analyze impact of different preprocessing components."""
        logger.info("Analyzing preprocessing components...")
        
        from sklearn.preprocessing import MinMaxScaler, RobustScaler, StandardScaler
        
        results = {}
        scalers = {
            'no_scaling': None,
            'standard_scaler': StandardScaler(),
            'minmax_scaler': MinMaxScaler(),
            'robust_scaler': RobustScaler()
        }
        
        base_model = self.base_pipeline.named_steps.get('model', self.base_pipeline.steps[-1][1])
        
        for scaler_name, scaler in scalers.items():
            if scaler is None:
                # No scaling pipeline
                pipeline = Pipeline([('model', base_model)])
            else:
                pipeline = Pipeline([
                    ('scaler', scaler),
                    ('model', base_model)
                ])
            
            score = self._evaluate_pipeline(pipeline, X, y)
            impact = score - self.baseline_score
            results[scaler_name] = {
                'score': score,
                'impact': impact,
                'relative_improvement': (impact / self.baseline_score) * 100 if self.baseline_score > 0 else 0
            }
            
            logger.info(f"Preprocessing - {scaler_name}: {score:.4f} (impact: {impact:+.4f})")
        
        return results
    
    def _analyze_feature_engineering_components(self, X: np.ndarray, y: np.ndarray) -> Dict[str, float]:
        """Analyze impact of feature engineering components."""
        logger.info("Analyzing feature engineering components...")
        
        results = {}
        base_model = self.base_pipeline.named_steps.get('model', self.base_pipeline.steps[-1][1])
        
        # Feature selection methods
        feature_selectors = {
            'no_selection': None,
            'select_k_best_10': SelectKBest(k=min(10, X.shape[1])),
            'select_k_best_20': SelectKBest(k=min(20, X.shape[1])),
            'mutual_info': SelectKBest(score_func=mutual_info_classif, k=min(15, X.shape[1]))
        }
        
        for selector_name, selector in feature_selectors.items():
            steps = [('scaler', StandardScaler())]
            
            if selector is not None:
                steps.append(('feature_selector', selector))
            
            steps.append(('model', base_model))
            pipeline = Pipeline(steps)
            
            score = self._evaluate_pipeline(pipeline, X, y)
            impact = score - self.baseline_score
            results[selector_name] = {
                'score': score,
                'impact': impact,
                'relative_improvement': (impact / self.baseline_score) * 100 if self.baseline_score > 0 else 0
            }
            
            logger.info(f"Feature Engineering - {selector_name}: {score:.4f} (impact: {impact:+.4f})")
        
        # Polynomial features (if dataset is small enough)
        if X.shape[1] <= 10:  # Only for small feature sets
            try:
                poly_pipeline = Pipeline([
                    ('scaler', StandardScaler()),
                    ('poly', PolynomialFeatures(degree=2, include_bias=False)),
                    ('feature_selector', SelectKBest(k=min(20, X.shape[1] * 2))),
                    ('model', base_model)
                ])
                
                score = self._evaluate_pipeline(poly_pipeline, X, y)
                impact = score - self.baseline_score
                results['polynomial_features'] = {
                    'score': score,
                    'impact': impact,
                    'relative_improvement': (impact / self.baseline_score) * 100 if self.baseline_score > 0 else 0
                }
                
                logger.info(f"Feature Engineering - polynomial_features: {score:.4f} (impact: {impact:+.4f})")
            except Exception as e:
                logger.warning(f"Polynomial features analysis failed: {str(e)}")
        
        return results
    
    def _analyze_model_architecture_components(self, X: np.ndarray, y: np.ndarray) -> Dict[str, float]:
        """Analyze impact of different model architectures."""
        logger.info("Analyzing model architecture components...")
        
        from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
        from sklearn.linear_model import LogisticRegression
        from sklearn.svm import SVC
        
        results = {}
        models = {
            'random_forest': RandomForestClassifier(n_estimators=100, random_state=self.random_state),
            'gradient_boosting': GradientBoostingClassifier(n_estimators=100, random_state=self.random_state),
            'logistic_regression': LogisticRegression(random_state=self.random_state, max_iter=1000),
            'svm': SVC(random_state=self.random_state, probability=True)
        }
        
        for model_name, model in models.items():
            pipeline = Pipeline([
                ('scaler', StandardScaler()),
                ('model', model)
            ])
            
            score = self._evaluate_pipeline(pipeline, X, y)
            impact = score - self.baseline_score
            results[model_name] = {
                'score': score,
                'impact': impact,
                'relative_improvement': (impact / self.baseline_score) * 100 if self.baseline_score > 0 else 0
            }
            
            logger.info(f"Model Architecture - {model_name}: {score:.4f} (impact: {impact:+.4f})")
        
        return results
    
    def _analyze_hyperparameter_components(self, X: np.ndarray, y: np.ndarray) -> Dict[str, float]:
        """Analyze impact of hyperparameter variations."""
        logger.info("Analyzing hyperparameter components...")
        
        results = {}
        base_model_name = type(self.base_pipeline.steps[-1][1]).__name__.lower()
        
        if 'randomforest' in base_model_name:
            # Random Forest hyperparameter variations
            from sklearn.ensemble import RandomForestClassifier
            
            hyperparameter_configs = {
                'default': RandomForestClassifier(random_state=self.random_state),
                'deep_trees': RandomForestClassifier(n_estimators=200, max_depth=20, random_state=self.random_state),
                'shallow_trees': RandomForestClassifier(n_estimators=300, max_depth=5, random_state=self.random_state),
                'min_samples_tuned': RandomForestClassifier(n_estimators=150, min_samples_split=5, min_samples_leaf=2, random_state=self.random_state)
            }
        else:
            # Default hyperparameter variations for other models
            from sklearn.linear_model import LogisticRegression
            
            hyperparameter_configs = {
                'default': LogisticRegression(random_state=self.random_state, max_iter=1000),
                'high_regularization': LogisticRegression(C=0.1, random_state=self.random_state, max_iter=1000),
                'low_regularization': LogisticRegression(C=10.0, random_state=self.random_state, max_iter=1000)
            }
        
        for config_name, model in hyperparameter_configs.items():
            pipeline = Pipeline([
                ('scaler', StandardScaler()),
                ('model', model)
            ])
            
            score = self._evaluate_pipeline(pipeline, X, y)
            impact = score - self.baseline_score
            results[config_name] = {
                'score': score,
                'impact': impact,
                'relative_improvement': (impact / self.baseline_score) * 100 if self.baseline_score > 0 else 0
            }
            
            logger.info(f"Hyperparameters - {config_name}: {score:.4f} (impact: {impact:+.4f})")
        
        return results
    
    def _rank_components_by_impact(self, component_results: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Rank all components by their performance impact."""
        all_components = []
        
        for category, components in component_results.items():
            for component_name, metrics in components.items():
                all_components.append({
                    'category': category,
                    'component': component_name,
                    'impact': metrics['impact'],
                    'relative_improvement': metrics['relative_improvement'],
                    'absolute_score': metrics['score']
                })
        
        # Sort by impact (descending)
        all_components.sort(key=lambda x: x['impact'], reverse=True)
        
        return all_components
    
    def _generate_recommendations(self) -> List[str]:
        """Generate optimization recommendations based on ablation analysis."""
        recommendations = []
        
        # Get top 3 components with highest positive impact
        top_components = [comp for comp in self.component_impacts if comp['impact'] > 0][:3]
        
        if not top_components:
            recommendations.append("No components showed significant positive impact. Consider collecting more data or trying different model types.")
            return recommendations
        
        for i, comp in enumerate(top_components, 1):
            recommendations.append(
                f"{i}. Focus on optimizing {comp['category']} - {comp['component']} "
                f"(+{comp['impact']:.4f} score improvement, {comp['relative_improvement']:.1f}% relative)"
            )
        
        # Check for negative impact components
        negative_components = [comp for comp in self.component_impacts if comp['impact'] < -0.01]
        if negative_components:
            recommendations.append(
                f"Consider removing or modifying these components with negative impact: "
                f"{[comp['component'] for comp in negative_components[:3]]}"
            )
        
        return recommendations

class ArchitectureOptimizer:
    """
    Advanced model architecture optimization based on ablation analysis results.
    """
    
    def __init__(self, ablation_results: Dict[str, Any], random_state: int = 42):
        self.ablation_results = ablation_results
        self.random_state = random_state
        self.optimized_pipeline = None
        
    def create_optimized_architecture(self, X: np.ndarray, y: np.ndarray) -> Pipeline:
        """
        Create optimized model architecture based on ablation analysis.
        """
        logger.info("Creating optimized architecture...")
        
        # Get top performing components from each category
        top_components = self._select_top_components()
        
        # Build optimized pipeline
        pipeline_steps = []
        
        # Add preprocessing
        if 'preprocessing' in top_components:
            preprocessing_component = top_components['preprocessing']
            if preprocessing_component != 'no_scaling':
                if preprocessing_component == 'standard_scaler':
                    pipeline_steps.append(('scaler', StandardScaler()))
                elif preprocessing_component == 'minmax_scaler':
                    from sklearn.preprocessing import MinMaxScaler
                    pipeline_steps.append(('scaler', MinMaxScaler()))
                elif preprocessing_component == 'robust_scaler':
                    from sklearn.preprocessing import RobustScaler
                    pipeline_steps.append(('scaler', RobustScaler()))
        
        # Add feature engineering
        if 'feature_engineering' in top_components:
            fe_component = top_components['feature_engineering']
            if fe_component == 'select_k_best_10':
                pipeline_steps.append(('feature_selector', SelectKBest(k=min(10, X.shape[1]))))
            elif fe_component == 'select_k_best_20':
                pipeline_steps.append(('feature_selector', SelectKBest(k=min(20, X.shape[1]))))
            elif fe_component == 'mutual_info':
                pipeline_steps.append(('feature_selector', SelectKBest(score_func=mutual_info_classif, k=min(15, X.shape[1]))))
            elif fe_component == 'polynomial_features':
                pipeline_steps.extend([
                    ('poly', PolynomialFeatures(degree=2, include_bias=False)),
                    ('feature_selector', SelectKBest(k=min(20, X.shape[1] * 2)))
                ])
        
        # Add model
        if 'model_architecture' in top_components:
            model_component = top_components['model_architecture']
            
            if model_component == 'random_forest':
                from sklearn.ensemble import RandomForestClassifier
                model = RandomForestClassifier(n_estimators=200, max_depth=15, random_state=self.random_state)
            elif model_component == 'gradient_boosting':
                from sklearn.ensemble import GradientBoostingClassifier
                model = GradientBoostingClassifier(n_estimators=150, learning_rate=0.1, random_state=self.random_state)
            elif model_component == 'logistic_regression':
                from sklearn.linear_model import LogisticRegression
                model = LogisticRegression(C=1.0, random_state=self.random_state, max_iter=1000)
            else:
                # Default fallback
                from sklearn.ensemble import RandomForestClassifier
                model = RandomForestClassifier(random_state=self.random_state)
            
            pipeline_steps.append(('model', model))
        
        # Create pipeline
        self.optimized_pipeline = Pipeline(pipeline_steps)
        
        logger.info(f"Optimized architecture created with {len(pipeline_steps)} steps")
        return self.optimized_pipeline
    
    def _select_top_components(self) -> Dict[str, str]:
        """Select the best performing component from each category."""
        top_components = {}
        
        for category in ['preprocessing', 'feature_engineering', 'model_architecture', 'hyperparameters']:
            if category in self.ablation_results['component_results']:
                components = self.ablation_results['component_results'][category]
                best_component = max(components.items(), key=lambda x: x[1]['score'])
                top_components[category] = best_component[0]
        
        return top_components
    
    def create_ensemble_architecture(self, X: np.ndarray, y: np.ndarray) -> Pipeline:
        """Create advanced ensemble architecture."""
        logger.info("Creating ensemble architecture...")
        
        # Get top 3 individual models
        model_results = self.ablation_results['component_results'].get('model_architecture', {})
        top_models = sorted(model_results.items(), key=lambda x: x[1]['score'], reverse=True)[:3]
        
        if len(top_models) < 2:
            logger.warning("Not enough models for ensemble - returning single optimized model")
            return self.create_optimized_architecture(X, y)
        
        # Create ensemble models
        estimators = []
        for model_name, _ in top_models:
            if model_name == 'random_forest':
                from sklearn.ensemble import RandomForestClassifier
                model = RandomForestClassifier(n_estimators=100, random_state=self.random_state)
            elif model_name == 'gradient_boosting':
                from sklearn.ensemble import GradientBoostingClassifier
                model = GradientBoostingClassifier(n_estimators=100, random_state=self.random_state)
            elif model_name == 'logistic_regression':
                from sklearn.linear_model import LogisticRegression
                model = LogisticRegression(random_state=self.random_state, max_iter=1000)
            else:
                continue
            
            estimators.append((model_name, model))
        
        # Create stacking ensemble
        from sklearn.ensemble import StackingClassifier
        from sklearn.linear_model import LogisticRegression
        
        ensemble = StackingClassifier(
            estimators=estimators,
            final_estimator=LogisticRegression(random_state=self.random_state),
            cv=5,
            n_jobs=-1
        )
        
        # Create ensemble pipeline
        ensemble_pipeline = Pipeline([
            ('scaler', StandardScaler()),
            ('ensemble', ensemble)
        ])
        
        logger.info(f"Ensemble architecture created with {len(estimators)} base models")
        return ensemble_pipeline

def main():
    """Example usage of architecture optimization."""
    
    # Generate sample data
    from sklearn.datasets import make_classification
    from sklearn.ensemble import RandomForestClassifier
    
    X, y = make_classification(
        n_samples=1000,
        n_features=20,
        n_informative=15,
        n_redundant=5,
        random_state=42
    )
    
    # Create base pipeline
    base_pipeline = Pipeline([
        ('scaler', StandardScaler()),
        ('model', RandomForestClassifier(random_state=42))
    ])
    
    # Run ablation analysis
    analyzer = AblationAnalyzer(base_pipeline)
    ablation_results = analyzer.run_ablation_analysis(X, y)
    
    # Create optimized architecture
    optimizer = ArchitectureOptimizer(ablation_results)
    optimized_pipeline = optimizer.create_optimized_architecture(X, y)
    ensemble_pipeline = optimizer.create_ensemble_architecture(X, y)
    
    # Evaluate optimized architectures
    from sklearn.model_selection import cross_val_score
    
    base_score = np.mean(cross_val_score(base_pipeline, X, y, cv=5))
    optimized_score = np.mean(cross_val_score(optimized_pipeline, X, y, cv=5))
    ensemble_score = np.mean(cross_val_score(ensemble_pipeline, X, y, cv=5))
    
    print(f"Base pipeline score: {base_score:.4f}")
    print(f"Optimized pipeline score: {optimized_score:.4f}")
    print(f"Ensemble pipeline score: {ensemble_score:.4f}")
    
    # Save results
    with open('architecture_optimization_results.json', 'w') as f:
        json.dump({
            'ablation_results': ablation_results,
            'scores': {
                'base': base_score,
                'optimized': optimized_score,
                'ensemble': ensemble_score
            },
            'timestamp': datetime.now().isoformat()
        }, f, indent=2, default=str)

if __name__ == "__main__":
    main()