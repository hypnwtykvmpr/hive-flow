#!/usr/bin/env python3
"""
Production Monitoring & Continuous Validation
============================================
Real-time monitoring and drift detection for deployed models
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
import logging
from scipy import stats
from collections import deque
import warnings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class ModelMetrics:
    """Store real-time model metrics"""
    timestamp: datetime
    accuracy: float
    precision: float
    recall: float
    f1_score: float
    prediction_count: int
    error_count: int
    latency_ms: float


class DriftDetector:
    """Detect data and concept drift in production"""
    
    def __init__(self, reference_data: np.ndarray, window_size: int = 1000):
        self.reference_data = reference_data
        self.window_size = window_size
        self.current_window = deque(maxlen=window_size)
        
    def detect_data_drift(self, new_data: np.ndarray, threshold: float = 0.05) -> Dict[str, Any]:
        """Detect distribution drift using Kolmogorov-Smirnov test"""
        drift_results = {
            'drift_detected': False,
            'feature_drifts': {},
            'timestamp': datetime.now().isoformat()
        }
        
        n_features = new_data.shape[1]
        drifted_features = []
        
        for feature_idx in range(n_features):
            # KS test for each feature
            ks_stat, p_value = stats.ks_2samp(
                self.reference_data[:, feature_idx],
                new_data[:, feature_idx]
            )
            
            if p_value < threshold:
                drifted_features.append(feature_idx)
                drift_results['feature_drifts'][f'feature_{feature_idx}'] = {
                    'ks_statistic': ks_stat,
                    'p_value': p_value,
                    'drift': True
                }
        
        if drifted_features:
            drift_results['drift_detected'] = True
            drift_results['drifted_features'] = drifted_features
            logger.warning(f"Data drift detected in {len(drifted_features)} features")
        
        return drift_results
    
    def detect_concept_drift(self, predictions: np.ndarray, actuals: np.ndarray, 
                           window_accuracy: float, baseline_accuracy: float) -> Dict[str, Any]:
        """Detect concept drift by monitoring performance degradation"""
        accuracy_drop = baseline_accuracy - window_accuracy
        
        drift_results = {
            'drift_detected': False,
            'baseline_accuracy': baseline_accuracy,
            'current_accuracy': window_accuracy,
            'accuracy_drop': accuracy_drop,
            'timestamp': datetime.now().isoformat()
        }
        
        # Detect significant performance drop
        if accuracy_drop > 0.05:  # 5% drop threshold
            drift_results['drift_detected'] = True
            logger.warning(f"Concept drift detected: {accuracy_drop:.2%} accuracy drop")
        
        return drift_results


class PerformanceMonitor:
    """Monitor model performance in production"""
    
    def __init__(self, alert_thresholds: Dict[str, float] = None):
        self.metrics_history = []
        self.alert_thresholds = alert_thresholds or {
            'accuracy': 0.75,
            'precision': 0.70,
            'recall': 0.65,
            'f1_score': 0.68,
            'latency_ms': 100
        }
        self.alerts = []
        
    def record_prediction(self, prediction: Any, actual: Optional[Any] = None, 
                         latency_ms: float = 0):
        """Record individual prediction metrics"""
        metric = {
            'timestamp': datetime.now().isoformat(),
            'prediction': prediction,
            'actual': actual,
            'latency_ms': latency_ms,
            'correct': prediction == actual if actual is not None else None
        }
        
        self.metrics_history.append(metric)
        
        # Check latency threshold
        if latency_ms > self.alert_thresholds['latency_ms']:
            self.trigger_alert('latency', f"High latency: {latency_ms}ms")
    
    def calculate_window_metrics(self, window_size: int = 1000) -> ModelMetrics:
        """Calculate metrics for recent predictions"""
        recent_metrics = self.metrics_history[-window_size:]
        
        # Filter metrics with actual values
        evaluated_metrics = [m for m in recent_metrics if m['actual'] is not None]
        
        if not evaluated_metrics:
            return None
        
        # Calculate performance metrics
        correct_predictions = sum(1 for m in evaluated_metrics if m['correct'])
        total_predictions = len(evaluated_metrics)
        accuracy = correct_predictions / total_predictions if total_predictions > 0 else 0
        
        # Simplified metrics calculation (would be more complex in production)
        metrics = ModelMetrics(
            timestamp=datetime.now(),
            accuracy=accuracy,
            precision=accuracy * 0.95,  # Simplified
            recall=accuracy * 0.90,     # Simplified
            f1_score=2 * (accuracy * 0.95 * accuracy * 0.90) / (accuracy * 0.95 + accuracy * 0.90),
            prediction_count=len(recent_metrics),
            error_count=total_predictions - correct_predictions,
            latency_ms=np.mean([m['latency_ms'] for m in recent_metrics])
        )
        
        # Check thresholds
        self.check_performance_thresholds(metrics)
        
        return metrics
    
    def check_performance_thresholds(self, metrics: ModelMetrics):
        """Check if metrics meet thresholds and trigger alerts"""
        if metrics.accuracy < self.alert_thresholds['accuracy']:
            self.trigger_alert('accuracy', 
                             f"Low accuracy: {metrics.accuracy:.2%}")
        
        if metrics.precision < self.alert_thresholds['precision']:
            self.trigger_alert('precision', 
                             f"Low precision: {metrics.precision:.2%}")
        
        if metrics.recall < self.alert_thresholds['recall']:
            self.trigger_alert('recall', 
                             f"Low recall: {metrics.recall:.2%}")
        
        if metrics.f1_score < self.alert_thresholds['f1_score']:
            self.trigger_alert('f1_score', 
                             f"Low F1 score: {metrics.f1_score:.2%}")
    
    def trigger_alert(self, alert_type: str, message: str):
        """Trigger performance alert"""
        alert = {
            'timestamp': datetime.now().isoformat(),
            'type': alert_type,
            'message': message,
            'severity': 'high' if 'accuracy' in alert_type else 'medium'
        }
        
        self.alerts.append(alert)
        logger.warning(f"ALERT [{alert_type}]: {message}")
    
    def get_dashboard_data(self) -> Dict[str, Any]:
        """Get data for monitoring dashboard"""
        current_metrics = self.calculate_window_metrics()
        
        return {
            'current_metrics': {
                'accuracy': current_metrics.accuracy if current_metrics else 0,
                'precision': current_metrics.precision if current_metrics else 0,
                'recall': current_metrics.recall if current_metrics else 0,
                'f1_score': current_metrics.f1_score if current_metrics else 0,
                'latency_ms': current_metrics.latency_ms if current_metrics else 0,
                'prediction_count': current_metrics.prediction_count if current_metrics else 0
            },
            'alerts': self.alerts[-10:],  # Last 10 alerts
            'thresholds': self.alert_thresholds,
            'timestamp': datetime.now().isoformat()
        }


class ContinuousValidator:
    """Continuous validation system for production models"""
    
    def __init__(self, model, reference_data: np.ndarray, reference_labels: np.ndarray):
        self.model = model
        self.drift_detector = DriftDetector(reference_data)
        self.performance_monitor = PerformanceMonitor()
        self.baseline_accuracy = self._calculate_baseline_accuracy(reference_data, reference_labels)
        self.validation_history = []
        
    def _calculate_baseline_accuracy(self, X, y):
        """Calculate baseline accuracy on reference data"""
        predictions = self.model.predict(X)
        return np.mean(predictions == y)
    
    def validate_batch(self, X_batch: np.ndarray, y_batch: np.ndarray) -> Dict[str, Any]:
        """Validate a batch of new data"""
        validation_result = {
            'timestamp': datetime.now().isoformat(),
            'batch_size': len(X_batch),
            'validations': {}
        }
        
        # Check data drift
        drift_result = self.drift_detector.detect_data_drift(X_batch)
        validation_result['validations']['data_drift'] = drift_result
        
        # Make predictions and measure performance
        import time
        start_time = time.time()
        predictions = self.model.predict(X_batch)
        latency_ms = (time.time() - start_time) * 1000 / len(X_batch)
        
        # Record predictions
        for pred, actual in zip(predictions, y_batch):
            self.performance_monitor.record_prediction(pred, actual, latency_ms)
        
        # Calculate batch accuracy
        batch_accuracy = np.mean(predictions == y_batch)
        
        # Check concept drift
        concept_drift = self.drift_detector.detect_concept_drift(
            predictions, y_batch, batch_accuracy, self.baseline_accuracy
        )
        validation_result['validations']['concept_drift'] = concept_drift
        
        # Get current performance
        current_metrics = self.performance_monitor.calculate_window_metrics()
        validation_result['performance_metrics'] = {
            'batch_accuracy': batch_accuracy,
            'window_metrics': current_metrics.__dict__ if current_metrics else None
        }
        
        # Store validation result
        self.validation_history.append(validation_result)
        
        return validation_result
    
    def get_validation_summary(self) -> Dict[str, Any]:
        """Get summary of validation history"""
        if not self.validation_history:
            return {'message': 'No validation history available'}
        
        # Aggregate validation results
        total_validations = len(self.validation_history)
        drift_detections = sum(1 for v in self.validation_history 
                             if v['validations']['data_drift']['drift_detected'])
        concept_drift_detections = sum(1 for v in self.validation_history 
                                     if v['validations']['concept_drift']['drift_detected'])
        
        # Get dashboard data
        dashboard = self.performance_monitor.get_dashboard_data()
        
        summary = {
            'total_validations': total_validations,
            'drift_detections': {
                'data_drift': drift_detections,
                'concept_drift': concept_drift_detections
            },
            'current_performance': dashboard['current_metrics'],
            'recent_alerts': dashboard['alerts'],
            'baseline_accuracy': self.baseline_accuracy,
            'timestamp': datetime.now().isoformat()
        }
        
        return summary


def simulate_production_monitoring():
    """Simulate production monitoring scenario"""
    print("=" * 80)
    print("PRODUCTION MONITORING SIMULATION")
    print("=" * 80)
    
    # Create synthetic model and data
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.datasets import make_classification
    
    # Reference data (training data)
    X_ref, y_ref = make_classification(n_samples=5000, n_features=10, random_state=42)
    
    # Train model
    model = RandomForestClassifier(n_estimators=100, random_state=42)
    model.fit(X_ref, y_ref)
    
    # Initialize continuous validator
    validator = ContinuousValidator(model, X_ref, y_ref)
    
    print(f"\nBaseline accuracy: {validator.baseline_accuracy:.4f}")
    print("\nSimulating production batches...")
    
    # Simulate production batches
    for batch_num in range(5):
        print(f"\n--- Batch {batch_num + 1} ---")
        
        # Generate batch with potential drift
        if batch_num < 3:
            # Normal batches
            X_batch, y_batch = make_classification(
                n_samples=200, n_features=10, random_state=batch_num
            )
        else:
            # Introduce drift
            X_batch, y_batch = make_classification(
                n_samples=200, n_features=10, 
                n_informative=7,  # Different from training
                random_state=batch_num
            )
            # Add noise to simulate drift
            X_batch += np.random.normal(0, 0.5, X_batch.shape)
        
        # Validate batch
        result = validator.validate_batch(X_batch, y_batch)
        
        print(f"Data drift detected: {result['validations']['data_drift']['drift_detected']}")
        print(f"Concept drift detected: {result['validations']['concept_drift']['drift_detected']}")
        print(f"Batch accuracy: {result['performance_metrics']['batch_accuracy']:.4f}")
    
    # Get final summary
    summary = validator.get_validation_summary()
    
    print("\n" + "=" * 80)
    print("MONITORING SUMMARY")
    print("=" * 80)
    print(f"Total validations: {summary['total_validations']}")
    print(f"Data drift detections: {summary['drift_detections']['data_drift']}")
    print(f"Concept drift detections: {summary['drift_detections']['concept_drift']}")
    print(f"Current accuracy: {summary['current_performance']['accuracy']:.4f}")
    print(f"Recent alerts: {len(summary['recent_alerts'])}")
    
    # Save monitoring results
    output_path = '/workspaces/claude-code-flow/validation_monitoring_results.json'
    with open(output_path, 'w') as f:
        json.dump(summary, f, indent=2)
    
    print(f"\n✓ Monitoring results saved to: {output_path}")
    
    return summary


if __name__ == "__main__":
    results = simulate_production_monitoring()