#!/usr/bin/env python3
"""
Comprehensive Test Suite for Validation & Debugging
==================================================
Tests for all validation components and strategies
"""

import unittest
import numpy as np
import pandas as pd
from sklearn.datasets import make_classification, make_regression
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.ensemble import RandomForestClassifier
from datetime import datetime, timedelta
import json
import sys
from pathlib import Path

# Import our validation framework
sys.path.append('/workspaces/claude-code-flow')
from validation_agent_main import (
    DataLeakageDetector, CrossValidationStrategies,
    ModelValidator, ProductionReadinessChecker, ValidationMetrics
)


class TestDataLeakageDetector(unittest.TestCase):
    """Test data leakage detection capabilities"""
    
    def setUp(self):
        self.detector = DataLeakageDetector()
        # Create sample data
        self.X, self.y = make_classification(n_samples=1000, n_features=20, random_state=42)
        
    def test_no_train_test_overlap(self):
        """Test detection of clean train/test split"""
        X_train, X_test = self.X[:800], self.X[800:]
        y_train, y_test = self.y[:800], self.y[800:]
        
        result = self.detector.check_train_test_overlap(X_train, X_test, y_train, y_test)
        self.assertTrue(result, "Should detect no overlap in clean split")
        
    def test_detect_train_test_overlap(self):
        """Test detection of overlapping samples"""
        # Create overlap by including some training samples in test set
        X_train = self.X[:800]
        X_test = np.vstack([self.X[750:850], self.X[850:]])  # 50 overlapping samples
        y_train = self.y[:800]
        y_test = np.hstack([self.y[750:850], self.y[850:]])
        
        result = self.detector.check_train_test_overlap(X_train, X_test, y_train, y_test)
        self.assertFalse(result, "Should detect overlap between train and test sets")
        
    def test_temporal_leakage_detection(self):
        """Test temporal data leakage detection"""
        # Create temporal data
        dates = pd.date_range(start='2023-01-01', periods=1000, freq='D')
        df = pd.DataFrame({
            'date': dates,
            'feature1': np.random.randn(1000),
            'feature2': np.random.randn(1000),
            'target': np.random.randint(0, 2, 1000)
        })
        
        # Shuffle to create temporal leakage
        df_shuffled = df.sample(frac=1, random_state=42)
        
        result = self.detector.check_temporal_leakage(df_shuffled, 'date')
        self.assertFalse(result, "Should detect temporal leakage in shuffled data")
        
    def test_feature_leakage_detection(self):
        """Test feature leakage detection"""
        # Test with suspicious feature names
        suspicious_features = ['user_id', 'actual_target', 'y_true_value', 'label_encoded']
        result = self.detector.check_feature_leakage(suspicious_features)
        self.assertFalse(result, "Should detect suspicious feature names")
        
        # Test with clean feature names
        clean_features = ['age', 'income', 'education_level', 'experience_years']
        result = self.detector.check_feature_leakage(clean_features)
        self.assertTrue(result, "Should pass clean feature names")


class TestCrossValidationStrategies(unittest.TestCase):
    """Test cross-validation strategies"""
    
    def setUp(self):
        self.cv = CrossValidationStrategies()
        self.X, self.y = make_classification(n_samples=100, n_features=10, random_state=42)
        
    def test_stratified_kfold(self):
        """Test stratified K-fold cross-validation"""
        folds = self.cv.stratified_kfold(self.X, self.y, n_splits=5)
        
        self.assertEqual(len(folds), 5, "Should create 5 folds")
        
        # Check fold sizes
        for fold in folds:
            self.assertAlmostEqual(len(fold['train_idx']), 80, delta=5)
            self.assertAlmostEqual(len(fold['val_idx']), 20, delta=5)
            
        # Check no overlap between train and val
        for fold in folds:
            train_set = set(fold['train_idx'])
            val_set = set(fold['val_idx'])
            self.assertEqual(len(train_set.intersection(val_set)), 0)
            
    def test_time_series_split(self):
        """Test time series split"""
        folds = self.cv.time_series_split(self.X, self.y, n_splits=5)
        
        self.assertEqual(len(folds), 5, "Should create 5 folds")
        
        # Check that validation indices are always after training indices
        for fold in folds:
            max_train_idx = max(fold['train_idx'])
            min_val_idx = min(fold['val_idx'])
            self.assertLess(max_train_idx, min_val_idx, 
                          "Validation should come after training in time series")
            
    def test_leave_one_out(self):
        """Test leave-one-out cross-validation"""
        X_small = self.X[:10]  # Use smaller dataset for LOO
        y_small = self.y[:10]
        
        folds = self.cv.leave_one_out(X_small, y_small)
        
        self.assertEqual(len(folds), 10, "Should create as many folds as samples")
        
        for fold in folds:
            self.assertEqual(len(fold['train_idx']), 9)
            self.assertEqual(len(fold['val_idx']), 1)


class TestModelValidator(unittest.TestCase):
    """Test model validation functionality"""
    
    def setUp(self):
        self.validator = ModelValidator()
        self.X, self.y = make_classification(n_samples=200, n_features=10, 
                                           n_informative=5, random_state=42)
        self.model = LogisticRegression(random_state=42)
        
    def test_validate_model_stratified(self):
        """Test model validation with stratified K-fold"""
        cv_scores = self.validator.validate_model(
            self.model, self.X, self.y, 
            cv_strategy='stratified_kfold', n_splits=5
        )
        
        self.assertEqual(len(cv_scores), 5)
        self.assertTrue(all(0 <= score <= 1 for score in cv_scores))
        
    def test_debug_predictions(self):
        """Test prediction debugging"""
        # Train model
        self.model.fit(self.X[:150], self.y[:150])
        
        # Debug predictions
        error_analysis = self.validator.debug_predictions(
            self.model, self.X[150:], self.y[150:]
        )
        
        self.assertIn('total_errors', error_analysis)
        self.assertIn('error_rate', error_analysis)
        self.assertIn('error_indices', error_analysis)
        
    def test_generate_validation_report(self):
        """Test validation report generation"""
        # Train model
        self.model.fit(self.X[:150], self.y[:150])
        
        # Generate report
        report = self.validator.generate_validation_report(
            self.model, self.X[150:], self.y[150:], 
            model_name="Test Logistic Regression"
        )
        
        self.assertIn('model_name', report)
        self.assertIn('metrics', report)
        self.assertIn('confusion_matrix', report)
        
        # Check metrics are in valid range
        metrics = report['metrics']
        for metric_name, value in metrics.items():
            self.assertTrue(0 <= value <= 1, f"{metric_name} should be between 0 and 1")


class TestProductionReadinessChecker(unittest.TestCase):
    """Test production readiness checks"""
    
    def setUp(self):
        self.checker = ProductionReadinessChecker()
        
    def test_check_performance_thresholds_pass(self):
        """Test performance threshold check - passing"""
        metrics = {
            'accuracy': 0.90,
            'precision': 0.88,
            'recall': 0.85,
            'f1_score': 0.86
        }
        
        passed, failures = self.checker.check_performance_thresholds(metrics)
        self.assertTrue(passed)
        self.assertEqual(len(failures), 0)
        
    def test_check_performance_thresholds_fail(self):
        """Test performance threshold check - failing"""
        metrics = {
            'accuracy': 0.75,  # Below threshold
            'precision': 0.70,  # Below threshold
            'recall': 0.85,
            'f1_score': 0.77  # Below threshold
        }
        
        passed, failures = self.checker.check_performance_thresholds(metrics)
        self.assertFalse(passed)
        self.assertEqual(len(failures), 3)
        
    def test_check_model_robustness_stable(self):
        """Test model robustness check - stable model"""
        cv_scores = [0.88, 0.89, 0.87, 0.88, 0.90]
        
        is_robust, message = self.checker.check_model_robustness(cv_scores)
        self.assertTrue(is_robust)
        self.assertIn("stable", message.lower())
        
    def test_check_model_robustness_unstable(self):
        """Test model robustness check - unstable model"""
        cv_scores = [0.65, 0.92, 0.78, 0.85, 0.70]  # High variance
        
        is_robust, message = self.checker.check_model_robustness(cv_scores)
        self.assertFalse(is_robust)
        self.assertIn("variance", message.lower())
        
    def test_generate_checklist(self):
        """Test production checklist generation"""
        checklist = self.checker.generate_checklist()
        
        expected_items = [
            'data_validation', 'model_validation', 'performance_thresholds',
            'cross_validation', 'error_analysis', 'robustness_check',
            'documentation', 'monitoring_setup'
        ]
        
        for item in expected_items:
            self.assertIn(item, checklist)


class TestIntegrationWorkflow(unittest.TestCase):
    """Test complete validation workflow integration"""
    
    def test_full_validation_workflow(self):
        """Test complete validation pipeline"""
        # Create dataset
        X, y = make_classification(n_samples=500, n_features=20, 
                                 n_informative=10, random_state=42)
        
        # Initialize components
        validator = ModelValidator()
        prod_checker = ProductionReadinessChecker()
        
        # Create and validate model
        model = RandomForestClassifier(n_estimators=10, random_state=42)
        
        # Cross-validation
        cv_scores = validator.validate_model(model, X[:400], y[:400], n_splits=5)
        
        # Train final model
        model.fit(X[:400], y[:400])
        
        # Generate validation report
        report = validator.generate_validation_report(
            model, X[400:], y[400:], 
            model_name="Random Forest Classifier"
        )
        
        # Check production readiness
        metrics = report['metrics']
        threshold_pass, failures = prod_checker.check_performance_thresholds(metrics)
        robustness_pass, message = prod_checker.check_model_robustness(cv_scores)
        
        # Assertions
        self.assertIsNotNone(cv_scores)
        self.assertIsNotNone(report)
        self.assertIn('metrics', report)
        self.assertIn('confusion_matrix', report)
        
        # Save integration test results
        results = {
            'test': 'full_validation_workflow',
            'timestamp': datetime.now().isoformat(),
            'cv_scores': cv_scores,
            'metrics': metrics,
            'production_ready': threshold_pass and robustness_pass
        }
        
        with open('/workspaces/claude-code-flow/validation_integration_test.json', 'w') as f:
            json.dump(results, f, indent=2)


def run_all_tests():
    """Run all validation tests"""
    # Create test suite
    test_suite = unittest.TestSuite()
    
    # Add all test classes
    test_classes = [
        TestDataLeakageDetector,
        TestCrossValidationStrategies,
        TestModelValidator,
        TestProductionReadinessChecker,
        TestIntegrationWorkflow
    ]
    
    for test_class in test_classes:
        tests = unittest.TestLoader().loadTestsFromTestCase(test_class)
        test_suite.addTests(tests)
    
    # Run tests
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(test_suite)
    
    # Save test results
    test_results = {
        'total_tests': result.testsRun,
        'failures': len(result.failures),
        'errors': len(result.errors),
        'success': result.wasSuccessful(),
        'timestamp': datetime.now().isoformat()
    }
    
    with open('/workspaces/claude-code-flow/validation_test_results.json', 'w') as f:
        json.dump(test_results, f, indent=2)
    
    return result


if __name__ == "__main__":
    print("Running comprehensive validation tests...")
    result = run_all_tests()
    print(f"\nTests completed: {result.testsRun} tests, "
          f"{len(result.failures)} failures, {len(result.errors)} errors")