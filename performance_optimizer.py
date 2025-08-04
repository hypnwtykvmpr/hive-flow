#!/usr/bin/env python3
"""
MLE-STAR Performance Optimization Framework
System-level performance enhancements and bottleneck resolution

Agent: Refinement Specialist
Session: automation-session-1754319839721-scewi2uw3
"""

import numpy as np
import pandas as pd
import psutil
import time
import gc
from typing import Dict, List, Tuple, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
from sklearn.model_selection import cross_val_score
from sklearn.pipeline import Pipeline
import joblib
import json
import logging
from datetime import datetime
import multiprocessing as mp

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class SystemPerformanceMonitor:
    """
    Real-time system performance monitoring and optimization.
    """
    
    def __init__(self, monitoring_interval: float = 1.0):
        self.monitoring_interval = monitoring_interval
        self.metrics_history = []
        self.performance_alerts = []
        self.optimization_suggestions = []
        
    def collect_system_metrics(self) -> Dict[str, Any]:
        """Collect comprehensive system performance metrics."""
        try:
            # CPU metrics
            cpu_percent = psutil.cpu_percent(interval=None)
            cpu_count = psutil.cpu_count()
            cpu_freq = psutil.cpu_freq()
            
            # Memory metrics
            memory = psutil.virtual_memory()
            swap = psutil.swap_memory()
            
            # Disk I/O metrics
            disk_io = psutil.disk_io_counters()
            
            # Network I/O metrics (if available)
            try:
                net_io = psutil.net_io_counters()
                network_metrics = {
                    'bytes_sent': net_io.bytes_sent,
                    'bytes_recv': net_io.bytes_recv,
                    'packets_sent': net_io.packets_sent,
                    'packets_recv': net_io.packets_recv
                }
            except:
                network_metrics = {}
            
            # Process-specific metrics
            process = psutil.Process()
            process_memory = process.memory_info()
            
            metrics = {
                'timestamp': time.time(),
                'cpu': {
                    'percent': cpu_percent,
                    'count': cpu_count,
                    'frequency_mhz': cpu_freq.current if cpu_freq else 0
                },
                'memory': {
                    'total_gb': memory.total / (1024**3),
                    'available_gb': memory.available / (1024**3),
                    'used_gb': memory.used / (1024**3),
                    'percent': memory.percent,
                    'swap_total_gb': swap.total / (1024**3),
                    'swap_used_gb': swap.used / (1024**3)
                },
                'disk': {
                    'read_bytes': disk_io.read_bytes if disk_io else 0,
                    'write_bytes': disk_io.write_bytes if disk_io else 0,
                    'read_count': disk_io.read_count if disk_io else 0,
                    'write_count': disk_io.write_count if disk_io else 0
                },
                'network': network_metrics,
                'process': {
                    'memory_rss_mb': process_memory.rss / (1024**2),
                    'memory_vms_mb': process_memory.vms / (1024**2),
                    'cpu_percent': process.cpu_percent()
                }
            }
            
            return metrics
            
        except Exception as e:
            logger.warning(f"Failed to collect system metrics: {str(e)}")
            return {}
    
    def analyze_performance_bottlenecks(self, metrics: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Analyze metrics to identify performance bottlenecks."""
        bottlenecks = []
        
        # CPU bottlenecks
        if metrics.get('cpu', {}).get('percent', 0) > 90:
            bottlenecks.append({
                'type': 'cpu_overload',
                'severity': 'high',
                'message': f"CPU utilization at {metrics['cpu']['percent']:.1f}%",
                'suggestion': 'Consider reducing batch size or enabling parallel processing'
            })
        elif metrics.get('cpu', {}).get('percent', 0) < 30:
            bottlenecks.append({
                'type': 'cpu_underutilization',
                'severity': 'medium',
                'message': f"CPU utilization only {metrics['cpu']['percent']:.1f}%",
                'suggestion': 'Consider increasing batch size or enabling more parallel workers'
            })
        
        # Memory bottlenecks
        memory_percent = metrics.get('memory', {}).get('percent', 0)
        if memory_percent > 85:
            bottlenecks.append({
                'type': 'memory_pressure',
                'severity': 'high',
                'message': f"Memory usage at {memory_percent:.1f}%",
                'suggestion': 'Consider reducing data batch size or implementing data streaming'
            })
        
        # Swap usage
        swap_used = metrics.get('memory', {}).get('swap_used_gb', 0)
        if swap_used > 1.0:
            bottlenecks.append({
                'type': 'swap_usage',
                'severity': 'high',
                'message': f"Swap usage at {swap_used:.1f}GB",
                'suggestion': 'Memory pressure detected - reduce memory footprint'
            })
        
        return bottlenecks
    
    def generate_optimization_recommendations(self, bottlenecks: List[Dict[str, Any]]) -> List[str]:
        """Generate specific optimization recommendations."""
        recommendations = []
        
        cpu_issues = [b for b in bottlenecks if 'cpu' in b['type']]
        memory_issues = [b for b in bottlenecks if 'memory' in b['type'] or 'swap' in b['type']]
        
        if cpu_issues:
            if any('underutilization' in b['type'] for b in cpu_issues):
                recommendations.extend([
                    "Enable parallel processing with n_jobs=-1 in sklearn models",
                    "Increase batch size for model training",
                    "Consider using more CPU-intensive algorithms",
                    "Implement multi-threading for independent tasks"
                ])
            
            if any('overload' in b['type'] for b in cpu_issues):
                recommendations.extend([
                    "Reduce batch size to lower CPU load",
                    "Implement data streaming to reduce memory pressure",
                    "Consider using GPU acceleration if available",
                    "Optimize algorithm complexity"
                ])
        
        if memory_issues:
            recommendations.extend([
                "Implement incremental learning approaches",
                "Use data generators instead of loading full datasets",
                "Optimize data types (e.g., float32 instead of float64)",
                "Clear unused variables and call gc.collect()",
                "Consider dimensionality reduction techniques"
            ])
        
        if not bottlenecks:
            recommendations.append("System performance is optimal - consider scaling up workload")
        
        return recommendations

class ModelPerformanceOptimizer:
    """
    ML model-specific performance optimization.
    """
    
    def __init__(self, random_state: int = 42):
        self.random_state = random_state
        self.optimization_history = []
        
    def optimize_pipeline_performance(self, pipeline: Pipeline, X: np.ndarray, y: np.ndarray) -> Tuple[Pipeline, Dict[str, Any]]:
        """Optimize ML pipeline for better performance."""
        logger.info("Starting pipeline performance optimization...")
        
        optimization_results = {
            'original_pipeline': str(pipeline),
            'optimizations_applied': [],
            'performance_improvements': {}
        }
        
        # Baseline performance
        start_time = time.time()
        baseline_score = np.mean(cross_val_score(pipeline, X, y, cv=3, n_jobs=-1))
        baseline_time = time.time() - start_time
        
        logger.info(f"Baseline: {baseline_score:.4f} in {baseline_time:.2f}s")
        
        optimized_pipeline = pipeline
        best_score = baseline_score
        
        # Optimization 1: Enable parallel processing
        optimized_pipeline = self._enable_parallel_processing(optimized_pipeline)
        
        # Optimization 2: Optimize data types
        X_optimized = self._optimize_data_types(X)
        
        # Optimization 3: Feature preprocessing optimization
        optimized_pipeline = self._optimize_preprocessing(optimized_pipeline)
        
        # Optimization 4: Model-specific optimizations
        optimized_pipeline = self._optimize_model_parameters(optimized_pipeline)
        
        # Evaluate optimized pipeline
        start_time = time.time()
        optimized_score = np.mean(cross_val_score(optimized_pipeline, X_optimized, y, cv=3, n_jobs=-1))
        optimized_time = time.time() - start_time
        
        optimization_results['performance_improvements'] = {
            'baseline_score': baseline_score,
            'optimized_score': optimized_score,
            'score_improvement': optimized_score - baseline_score,
            'baseline_time': baseline_time,
            'optimized_time': optimized_time,
            'time_improvement': baseline_time - optimized_time,
            'speedup_factor': baseline_time / optimized_time if optimized_time > 0 else 1.0
        }
        
        logger.info(f"Optimized: {optimized_score:.4f} in {optimized_time:.2f}s")
        logger.info(f"Improvement: {optimized_score - baseline_score:+.4f} score, {baseline_time - optimized_time:+.2f}s")
        
        return optimized_pipeline, optimization_results
    
    def _enable_parallel_processing(self, pipeline: Pipeline) -> Pipeline:
        """Enable parallel processing in pipeline components."""
        logger.info("Enabling parallel processing...")
        
        optimized_steps = []
        for name, step in pipeline.steps:
            # Enable parallel processing in sklearn estimators
            if hasattr(step, 'n_jobs'):
                step.set_params(n_jobs=-1)
                logger.info(f"Enabled parallel processing for {name}")
            
            optimized_steps.append((name, step))
        
        return Pipeline(optimized_steps)
    
    def _optimize_data_types(self, X: np.ndarray) -> np.ndarray:
        """Optimize data types for better memory usage and speed."""
        logger.info("Optimizing data types...")
        
        if X.dtype == np.float64:
            X_optimized = X.astype(np.float32)
            logger.info("Converted float64 to float32")
            return X_optimized
        
        return X
    
    def _optimize_preprocessing(self, pipeline: Pipeline) -> Pipeline:
        """Optimize preprocessing steps."""
        logger.info("Optimizing preprocessing steps...")
        
        optimized_steps = []
        for name, step in pipeline.steps:
            if name == 'scaler':
                # Use copy=False for in-place transformations when safe
                if hasattr(step, 'copy'):
                    step.set_params(copy=False)
                    logger.info("Enabled in-place scaling")
            
            optimized_steps.append((name, step))
        
        return Pipeline(optimized_steps)
    
    def _optimize_model_parameters(self, pipeline: Pipeline) -> Pipeline:
        """Optimize model-specific parameters for performance."""
        logger.info("Optimizing model parameters...")
        
        optimized_steps = []
        for name, step in pipeline.steps:
            if name == 'model':
                model_name = type(step).__name__.lower()
                
                if 'randomforest' in model_name:
                    # Optimize Random Forest
                    step.set_params(
                        warm_start=True,  # Enable incremental training
                        oob_score=True,   # Use out-of-bag score
                        n_jobs=-1         # Parallel processing
                    )
                    logger.info("Optimized Random Forest parameters")
                
                elif 'gradientboosting' in model_name:
                    # Optimize Gradient Boosting
                    step.set_params(
                        warm_start=True,  # Enable incremental training
                        validation_fraction=0.1  # Early stopping
                    )
                    logger.info("Optimized Gradient Boosting parameters")
                
                elif 'mlp' in model_name:
                    # Optimize Neural Network
                    step.set_params(
                        early_stopping=True,
                        validation_fraction=0.1,
                        n_iter_no_change=10
                    )
                    logger.info("Optimized MLP parameters")
            
            optimized_steps.append((name, step))
        
        return Pipeline(optimized_steps)

class MemoryOptimizer:
    """
    Memory usage optimization and management.
    """
    
    def __init__(self):
        self.memory_snapshots = []
        
    def optimize_memory_usage(self, data_dict: Dict[str, Any]) -> Dict[str, Any]:
        """Optimize memory usage of data structures."""
        logger.info("Optimizing memory usage...")
        
        optimized_data = {}
        memory_savings = {}
        
        for key, data in data_dict.items():
            original_size = self._get_memory_size(data)
            
            if isinstance(data, pd.DataFrame):
                optimized_data[key] = self._optimize_dataframe_memory(data)
            elif isinstance(data, np.ndarray):
                optimized_data[key] = self._optimize_array_memory(data)
            else:
                optimized_data[key] = data
            
            optimized_size = self._get_memory_size(optimized_data[key])
            memory_savings[key] = {
                'original_mb': original_size,
                'optimized_mb': optimized_size,
                'savings_mb': original_size - optimized_size,
                'savings_percent': ((original_size - optimized_size) / original_size * 100) if original_size > 0 else 0
            }
        
        total_savings = sum(s['savings_mb'] for s in memory_savings.values())
        logger.info(f"Total memory savings: {total_savings:.1f}MB")
        
        return optimized_data, memory_savings
    
    def _get_memory_size(self, obj: Any) -> float:
        """Get memory size of object in MB."""
        if isinstance(obj, pd.DataFrame):
            return obj.memory_usage(deep=True).sum() / (1024**2)
        elif isinstance(obj, np.ndarray):
            return obj.nbytes / (1024**2)
        else:
            import sys
            return sys.getsizeof(obj) / (1024**2)
    
    def _optimize_dataframe_memory(self, df: pd.DataFrame) -> pd.DataFrame:
        """Optimize pandas DataFrame memory usage."""
        df_optimized = df.copy()
        
        for col in df_optimized.columns:
            col_type = df_optimized[col].dtype
            
            if col_type != 'object':
                c_min = df_optimized[col].min()
                c_max = df_optimized[col].max()
                
                if str(col_type)[:3] == 'int':
                    if c_min > np.iinfo(np.int8).min and c_max < np.iinfo(np.int8).max:
                        df_optimized[col] = df_optimized[col].astype(np.int8)
                    elif c_min > np.iinfo(np.int16).min and c_max < np.iinfo(np.int16).max:
                        df_optimized[col] = df_optimized[col].astype(np.int16)
                    elif c_min > np.iinfo(np.int32).min and c_max < np.iinfo(np.int32).max:
                        df_optimized[col] = df_optimized[col].astype(np.int32)
                
                else:
                    if c_min > np.finfo(np.float32).min and c_max < np.finfo(np.float32).max:
                        df_optimized[col] = df_optimized[col].astype(np.float32)
        
        return df_optimized
    
    def _optimize_array_memory(self, arr: np.ndarray) -> np.ndarray:
        """Optimize numpy array memory usage."""
        if arr.dtype == np.float64:
            # Check if we can safely convert to float32
            if np.allclose(arr, arr.astype(np.float32), rtol=1e-6):
                return arr.astype(np.float32)
        
        elif arr.dtype == np.int64:
            # Check if we can use smaller integer types
            if arr.min() >= np.iinfo(np.int32).min and arr.max() <= np.iinfo(np.int32).max:
                return arr.astype(np.int32)
        
        return arr
    
    def setup_memory_monitoring(self) -> None:
        """Setup continuous memory monitoring."""
        def monitor_memory():
            memory_info = psutil.virtual_memory()
            self.memory_snapshots.append({
                'timestamp': time.time(),
                'available_gb': memory_info.available / (1024**3),
                'percent_used': memory_info.percent
            })
            
            # Keep only last 100 snapshots
            if len(self.memory_snapshots) > 100:
                self.memory_snapshots = self.memory_snapshots[-100:]
        
        # Could be run in a separate thread for continuous monitoring
        monitor_memory()

class ComprehensivePerformanceOptimizer:
    """
    Comprehensive performance optimization combining system and model optimizations.
    """
    
    def __init__(self, random_state: int = 42):
        self.random_state = random_state
        self.system_monitor = SystemPerformanceMonitor()
        self.model_optimizer = ModelPerformanceOptimizer(random_state)
        self.memory_optimizer = MemoryOptimizer()
        
    def optimize_complete_workflow(self, 
                                 pipeline: Pipeline, 
                                 X: np.ndarray, 
                                 y: np.ndarray) -> Dict[str, Any]:
        """
        Perform comprehensive optimization of the entire ML workflow.
        """
        logger.info("Starting comprehensive performance optimization...")
        
        optimization_results = {
            'timestamp': datetime.now().isoformat(),
            'system_metrics': {},
            'model_optimization': {},
            'memory_optimization': {},
            'recommendations': []
        }
        
        # 1. System performance analysis
        logger.info("Analyzing system performance...")
        system_metrics = self.system_monitor.collect_system_metrics()
        bottlenecks = self.system_monitor.analyze_performance_bottlenecks(system_metrics)
        system_recommendations = self.system_monitor.generate_optimization_recommendations(bottlenecks)
        
        optimization_results['system_metrics'] = {
            'current_metrics': system_metrics,
            'bottlenecks': bottlenecks,
            'recommendations': system_recommendations
        }
        
        # 2. Memory optimization
        logger.info("Optimizing memory usage...")
        data_dict = {'X': X, 'y': y}
        optimized_data, memory_savings = self.memory_optimizer.optimize_memory_usage(data_dict)
        X_optimized = optimized_data['X']
        y_optimized = optimized_data['y']
        
        optimization_results['memory_optimization'] = memory_savings
        
        # 3. Model pipeline optimization
        logger.info("Optimizing model pipeline...")
        optimized_pipeline, model_results = self.model_optimizer.optimize_pipeline_performance(
            pipeline, X_optimized, y_optimized
        )
        
        optimization_results['model_optimization'] = model_results
        
        # 4. Generate comprehensive recommendations
        all_recommendations = []
        all_recommendations.extend(system_recommendations)
        
        if model_results['performance_improvements']['score_improvement'] > 0:
            all_recommendations.append(f"Model optimization improved accuracy by {model_results['performance_improvements']['score_improvement']:.4f}")
        
        if model_results['performance_improvements']['time_improvement'] > 0:
            all_recommendations.append(f"Model optimization reduced training time by {model_results['performance_improvements']['time_improvement']:.2f}s")
        
        total_memory_savings = sum(s['savings_mb'] for s in memory_savings.values())
        if total_memory_savings > 0:
            all_recommendations.append(f"Memory optimization saved {total_memory_savings:.1f}MB")
        
        optimization_results['recommendations'] = all_recommendations
        
        # 5. Performance summary
        optimization_results['summary'] = {
            'total_score_improvement': model_results['performance_improvements']['score_improvement'],
            'total_time_improvement': model_results['performance_improvements']['time_improvement'],
            'total_memory_savings_mb': total_memory_savings,
            'optimization_successful': len(bottlenecks) == 0 and model_results['performance_improvements']['score_improvement'] >= 0
        }
        
        logger.info("Comprehensive optimization completed")
        logger.info(f"Score improvement: {model_results['performance_improvements']['score_improvement']:+.4f}")
        logger.info(f"Time improvement: {model_results['performance_improvements']['time_improvement']:+.2f}s")
        logger.info(f"Memory savings: {total_memory_savings:.1f}MB")
        
        return optimization_results, optimized_pipeline

def main():
    """Example usage of comprehensive performance optimizer."""
    
    # Generate sample data
    from sklearn.datasets import make_classification
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.preprocessing import StandardScaler
    
    X, y = make_classification(
        n_samples=5000,
        n_features=50,
        n_informative=30,
        n_redundant=10,
        random_state=42
    )
    
    # Create pipeline
    pipeline = Pipeline([
        ('scaler', StandardScaler()),
        ('model', RandomForestClassifier(n_estimators=100, random_state=42))
    ])
    
    # Optimize performance
    optimizer = ComprehensivePerformanceOptimizer()
    results, optimized_pipeline = optimizer.optimize_complete_workflow(pipeline, X, y)
    
    # Save results
    with open('performance_optimization_results.json', 'w') as f:
        json.dump(results, f, indent=2, default=str)
    
    # Save optimized pipeline
    joblib.dump(optimized_pipeline, 'optimized_pipeline.pkl')
    
    print("Performance optimization completed!")
    print(f"Results saved to performance_optimization_results.json")

if __name__ == "__main__":
    main()