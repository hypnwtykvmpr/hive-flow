#!/usr/bin/env python3
"""
Test Suite for MLE-STAR Ensemble System
Comprehensive testing of ensemble strategies and implementations
"""

import numpy as np
import pytest
from sklearn.datasets import make_classification, make_regression
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.svm import SVC, SVR
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, mean_squared_error
import sys
import os

# Add the current directory to the Python path
sys.path.append(os.path.dirname(__file__))

from ensemble_implementation import (
    EnsembleManager, EnsembleConfig, WrappedModel,
    VotingEnsemble, StackingEnsemble, BlendingEnsemble
)

class TestEnsembleSystem:
    """Test suite for ensemble system components."""
    
    def setup_method(self):
        """Set up test fixtures."""
        # Classification data
        self.X_clf, self.y_clf = make_classification(
            n_samples=500, n_features=10, n_informative=5,
            n_redundant=2, n_classes=3, random_state=42
        )
        self.X_clf_train, self.X_clf_test, self.y_clf_train, self.y_clf_test = train_test_split(
            self.X_clf, self.y_clf, test_size=0.3, random_state=42
        )
        
        # Regression data
        self.X_reg, self.y_reg = make_regression(
            n_samples=500, n_features=10, noise=0.1, random_state=42
        )
        self.X_reg_train, self.X_reg_test, self.y_reg_train, self.y_reg_test = train_test_split(
            self.X_reg, self.y_reg, test_size=0.3, random_state=42
        )
        
        # Configuration
        self.config = EnsembleConfig(
            voting_strategy="soft",
            stacking_meta_learner="linear",
            blending_method="simple",
            cv_folds=3  # Reduced for faster testing
        )
        
    def test_wrapped_model_classification(self):
        """Test WrappedModel with classification."""
        model = WrappedModel("rf_clf", RandomForestClassifier(n_estimators=10, random_state=42))
        
        # Test fitting
        model.fit(self.X_clf_train, self.y_clf_train)
        assert model.is_trained
        assert model.performance.training_time > 0
        
        # Test prediction
        predictions = model.predict(self.X_clf_test)
        assert len(predictions) == len(self.y_clf_test)
        
        # Test probability prediction
        probabilities = model.predict_proba(self.X_clf_test)
        assert probabilities is not None
        assert probabilities.shape[0] == len(self.y_clf_test)
        
    def test_wrapped_model_regression(self):
        """Test WrappedModel with regression."""
        model = WrappedModel("rf_reg", RandomForestRegressor(n_estimators=10, random_state=42))
        
        # Test fitting
        model.fit(self.X_reg_train, self.y_reg_train)
        assert model.is_trained
        assert model.performance.r2_score is not None
        
        # Test prediction
        predictions = model.predict(self.X_reg_test)
        assert len(predictions) == len(self.y_reg_test)
        
    def test_voting_ensemble_hard(self):
        """Test hard voting ensemble."""
        config = EnsembleConfig(voting_strategy="hard")
        
        models = [
            WrappedModel("rf", RandomForestClassifier(n_estimators=10, random_state=42)),
            WrappedModel("lr", LogisticRegression(random_state=42, max_iter=1000))
        ]
        
        ensemble = VotingEnsemble(models, config)
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        predictions = ensemble.predict(self.X_clf_test)
        assert len(predictions) == len(self.y_clf_test)
        
        # Check accuracy is reasonable
        accuracy = accuracy_score(self.y_clf_test, predictions)
        assert accuracy > 0.5  # Should be better than random
        
    def test_voting_ensemble_soft(self):
        """Test soft voting ensemble."""
        config = EnsembleConfig(voting_strategy="soft")
        
        models = [
            WrappedModel("rf", RandomForestClassifier(n_estimators=10, random_state=42)),
            WrappedModel("lr", LogisticRegression(random_state=42, max_iter=1000))
        ]
        
        ensemble = VotingEnsemble(models, config)
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        predictions = ensemble.predict(self.X_clf_test)
        assert len(predictions) == len(self.y_clf_test)
        
    def test_voting_ensemble_weighted(self):
        """Test weighted voting ensemble."""
        config = EnsembleConfig(voting_strategy="weighted")
        
        models = [
            WrappedModel("rf", RandomForestClassifier(n_estimators=10, random_state=42)),
            WrappedModel("lr", LogisticRegression(random_state=42, max_iter=1000))
        ]
        
        ensemble = VotingEnsemble(models, config)
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        assert ensemble.weights is not None
        assert len(ensemble.weights) == len(models)
        assert abs(sum(ensemble.weights) - 1.0) < 1e-6  # Weights should sum to 1
        
    def test_stacking_ensemble(self):
        """Test stacking ensemble."""
        models = [
            WrappedModel("rf", RandomForestClassifier(n_estimators=10, random_state=42)),
            WrappedModel("lr", LogisticRegression(random_state=42, max_iter=1000))
        ]
        
        ensemble = StackingEnsemble(models, self.config)
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        predictions = ensemble.predict(self.X_clf_test)
        assert len(predictions) == len(self.y_clf_test)
        
        # Check that meta-learner is trained
        assert ensemble.meta_learner is not None
        
    def test_blending_ensemble(self):
        """Test blending ensemble."""
        models = [
            WrappedModel("rf", RandomForestClassifier(n_estimators=10, random_state=42)),
            WrappedModel("lr", LogisticRegression(random_state=42, max_iter=1000))
        ]
        
        ensemble = BlendingEnsemble(models, self.config)
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        predictions = ensemble.predict(self.X_clf_test)
        assert len(predictions) == len(self.y_clf_test)
        
        # Check that blend weights are learned
        assert ensemble.blend_weights is not None
        assert len(ensemble.blend_weights) == len(models)
        
    def test_ensemble_manager(self):
        """Test EnsembleManager functionality."""
        manager = EnsembleManager(self.config)
        
        # Add models
        manager.add_model("rf", RandomForestClassifier(n_estimators=10, random_state=42))
        manager.add_model("lr", LogisticRegression(random_state=42, max_iter=1000))
        
        assert len(manager.models) == 2
        
        # Create ensembles
        voting_ensemble = manager.create_voting_ensemble("voting")
        stacking_ensemble = manager.create_stacking_ensemble("stacking")
        blending_ensemble = manager.create_blending_ensemble("blending")
        
        assert len(manager.ensembles) == 3
        
        # Train ensembles
        voting_ensemble.fit(self.X_clf_train, self.y_clf_train)
        stacking_ensemble.fit(self.X_clf_train, self.y_clf_train)
        blending_ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        # Evaluate ensembles
        voting_metrics = manager.evaluate_ensemble("voting", self.X_clf_test, self.y_clf_test)
        stacking_metrics = manager.evaluate_ensemble("stacking", self.X_clf_test, self.y_clf_test)
        blending_metrics = manager.evaluate_ensemble("blending", self.X_clf_test, self.y_clf_test)
        
        assert 'accuracy' in voting_metrics
        assert 'accuracy' in stacking_metrics
        assert 'accuracy' in blending_metrics
        
        # Check accuracies are reasonable
        assert voting_metrics['accuracy'] > 0.5
        assert stacking_metrics['accuracy'] > 0.5
        assert blending_metrics['accuracy'] > 0.5
        
    def test_regression_ensemble(self):
        """Test ensemble with regression models."""
        manager = EnsembleManager(self.config)
        
        # Add regression models
        manager.add_model("rf_reg", RandomForestRegressor(n_estimators=10, random_state=42))
        manager.add_model("lr_reg", LinearRegression())
        
        # Create voting ensemble for regression
        ensemble = manager.create_voting_ensemble("reg_voting")
        ensemble.fit(self.X_reg_train, self.y_reg_train)
        
        predictions = ensemble.predict(self.X_reg_test)
        mse = mean_squared_error(self.y_reg_test, predictions)
        
        # MSE should be reasonable
        assert mse < 1000  # Adjust threshold based on data scale
        
    def test_ensemble_serialization(self):
        """Test ensemble save/load functionality."""
        import tempfile
        
        manager = EnsembleManager(self.config)
        manager.add_model("rf", RandomForestClassifier(n_estimators=10, random_state=42))
        
        ensemble = manager.create_voting_ensemble("test_ensemble")
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        # Save ensemble
        with tempfile.NamedTemporaryFile(suffix='.pkl', delete=False) as tmp_file:
            manager.save_ensemble("test_ensemble", tmp_file.name)
            
            # Create new manager and load ensemble
            new_manager = EnsembleManager(self.config)
            new_manager.load_ensemble("loaded_ensemble", tmp_file.name)
            
            assert "loaded_ensemble" in new_manager.ensembles
            
        # Clean up
        os.unlink(tmp_file.name)
        
    def test_performance_reporting(self):
        """Test performance reporting functionality."""
        import tempfile
        import json
        
        manager = EnsembleManager(self.config)
        manager.add_model("rf", RandomForestClassifier(n_estimators=10, random_state=42))
        
        ensemble = manager.create_voting_ensemble("test_ensemble")
        ensemble.fit(self.X_clf_train, self.y_clf_train)
        
        # Export performance report
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as tmp_file:
            manager.export_performance_report(tmp_file.name)
            
            # Verify report was created and contains expected data
            with open(tmp_file.name, 'r') as f:
                report = json.load(f)
                
            assert 'timestamp' in report
            assert 'models' in report
            assert 'ensembles' in report
            assert len(report['models']) == 1
            assert len(report['ensembles']) == 1
            
        # Clean up
        os.unlink(tmp_file.name)

def run_performance_comparison():
    """Run performance comparison between different ensemble methods."""
    print("Running performance comparison...")
    
    # Generate larger dataset for better comparison
    X, y = make_classification(
        n_samples=2000, n_features=20, n_informative=10,
        n_redundant=5, n_classes=3, random_state=42
    )
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.3, random_state=42)
    
    config = EnsembleConfig(cv_folds=5)
    manager = EnsembleManager(config)
    
    # Add diverse base models
    manager.add_model("rf", RandomForestClassifier(n_estimators=100, random_state=42))
    manager.add_model("lr", LogisticRegression(random_state=42, max_iter=1000))
    manager.add_model("svm", SVC(probability=True, random_state=42))
    
    # Create and train different ensemble types
    ensembles = {
        "voting_hard": manager.create_voting_ensemble("voting_hard"),
        "voting_soft": manager.create_voting_ensemble("voting_soft"),
        "stacking": manager.create_stacking_ensemble("stacking"),
        "blending": manager.create_blending_ensemble("blending")
    }
    
    # Update configurations for different voting strategies
    ensembles["voting_hard"].config.voting_strategy = "hard"
    ensembles["voting_soft"].config.voting_strategy = "soft"
    
    results = {}
    
    for name, ensemble in ensembles.items():
        print(f"Training {name}...")
        ensemble.fit(X_train, y_train)
        
        predictions = ensemble.predict(X_test)
        accuracy = accuracy_score(y_test, predictions)
        
        results[name] = accuracy
        print(f"{name}: {accuracy:.4f}")
    
    # Compare with individual models
    print("\nIndividual model performance:")
    for model in manager.models:
        model.fit(X_train, y_train)
        predictions = model.predict(X_test)
        accuracy = accuracy_score(y_test, predictions)
        results[f"individual_{model.model_id}"] = accuracy
        print(f"{model.model_id}: {accuracy:.4f}")
    
    # Find best performing method
    best_method = max(results.items(), key=lambda x: x[1])
    print(f"\nBest performing method: {best_method[0]} ({best_method[1]:.4f})")
    
    return results

if __name__ == "__main__":
    # Run tests
    print("Running ensemble system tests...")
    
    test_suite = TestEnsembleSystem()
    test_suite.setup_method()
    
    # Run individual tests
    test_methods = [
        test_suite.test_wrapped_model_classification,
        test_suite.test_wrapped_model_regression,
        test_suite.test_voting_ensemble_hard,
        test_suite.test_voting_ensemble_soft,
        test_suite.test_voting_ensemble_weighted,
        test_suite.test_stacking_ensemble,
        test_suite.test_blending_ensemble,
        test_suite.test_ensemble_manager,
        test_suite.test_regression_ensemble,
        test_suite.test_ensemble_serialization,
        test_suite.test_performance_reporting
    ]
    
    passed = 0
    failed = 0
    
    for test_method in test_methods:
        try:
            test_method()
            print(f"✓ {test_method.__name__}")
            passed += 1
        except Exception as e:
            print(f"✗ {test_method.__name__}: {str(e)}")
            failed += 1
    
    print(f"\nTest Results: {passed} passed, {failed} failed")
    
    if failed == 0:
        print("\nAll tests passed! Running performance comparison...")
        run_performance_comparison()
    else:
        print("\nSome tests failed. Please check the implementation.")