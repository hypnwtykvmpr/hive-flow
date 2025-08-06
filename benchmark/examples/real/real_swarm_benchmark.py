#!/usr/bin/env python3
"""
Real swarm benchmark with actual claude-flow execution and comprehensive metrics.

This example demonstrates:
- Real claude-flow swarm execution
- Comprehensive metrics collection
- Performance monitoring
- Production-ready benchmarking
"""

import subprocess
import sys
import json
import time
import psutil
import threading
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import List, Dict, Any, Optional
from contextlib import contextmanager

@dataclass
class RealSwarmConfig:
    """Configuration for real swarm benchmark."""
    benchmark_id: str
    task_description: str
    strategy: str
    coordination_mode: str
    max_agents: int
    timeout_seconds: int = 300
    enable_metrics: bool = True
    save_artifacts: bool = True

@dataclass
class SwarmMetrics:
    """Comprehensive swarm metrics."""
    benchmark_id: str
    start_time: float
    end_time: float
    execution_time: float
    success: bool
    agents_spawned: int
    coordination_events: int
    task_completion_rate: float
    token_consumption: int
    memory_usage_mb: float
    cpu_usage_percent: float
    disk_io_bytes: int
    network_requests: int
    error_count: int
    warning_count: int
    quality_indicators: Dict[str, int]
    performance_score: float

class RealSwarmBenchmark:
    """Real swarm benchmark execution with comprehensive monitoring."""
    
    def __init__(self):
        self.metrics_history: List[SwarmMetrics] = []
        self.monitoring_active = False
        self.resource_data = []
        self.claude_flow_path = "/workspaces/claude-code-flow"
        
    def create_real_benchmark_configs(self) -> List[RealSwarmConfig]:
        """Create real-world benchmark configurations."""
        configs = [
            RealSwarmConfig(
                benchmark_id="api_development_swarm",
                task_description="Create a complete REST API with authentication, CRUD operations, input validation, and comprehensive error handling",
                strategy="development",
                coordination_mode="hierarchical",
                max_agents=5,
                timeout_seconds=300
            ),
            RealSwarmConfig(
                benchmark_id="optimization_analysis_swarm", 
                task_description="Analyze existing codebase for performance bottlenecks, suggest optimizations, and implement improvements",
                strategy="optimization",
                coordination_mode="mesh",
                max_agents=6,
                timeout_seconds=240
            ),
            RealSwarmConfig(
                benchmark_id="research_documentation_swarm",
                task_description="Research best practices for microservices architecture and create comprehensive documentation with examples",
                strategy="research",
                coordination_mode="distributed",
                max_agents=4,
                timeout_seconds=180
            ),
            RealSwarmConfig(
                benchmark_id="testing_automation_swarm",
                task_description="Design and implement comprehensive test suite with unit tests, integration tests, and automated CI/CD pipeline",
                strategy="testing",
                coordination_mode="hierarchical", 
                max_agents=4,
                timeout_seconds=200
            )
        ]
        return configs
    
    @contextmanager
    def system_monitoring(self, interval: float = 2.0):
        """Monitor system resources during benchmark execution."""
        self.resource_data.clear()
        self.monitoring_active = True
        
        def monitor():
            while self.monitoring_active:
                try:
                    cpu_percent = psutil.cpu_percent(interval=0.1)
                    memory = psutil.virtual_memory()
                    disk_io = psutil.disk_io_counters()
                    net_io = psutil.net_io_counters()
                    
                    self.resource_data.append({
                        "timestamp": time.time(),
                        "cpu_percent": cpu_percent,
                        "memory_mb": memory.used / 1024 / 1024,
                        "memory_percent": memory.percent,
                        "disk_read": disk_io.read_bytes if disk_io else 0,
                        "disk_write": disk_io.write_bytes if disk_io else 0,
                        "net_sent": net_io.bytes_sent if net_io else 0,
                        "net_recv": net_io.bytes_recv if net_io else 0
                    })
                    time.sleep(interval)
                except Exception as e:
                    print(f"⚠️  Monitoring error: {e}")
                    break
        
        monitor_thread = threading.Thread(target=monitor, daemon=True)
        monitor_thread.start()
        
        try:
            yield
        finally:
            self.monitoring_active = False
            monitor_thread.join(timeout=5.0)
    
    def execute_real_swarm_benchmark(self, config: RealSwarmConfig) -> SwarmMetrics:
        """Execute a real swarm benchmark with full monitoring."""
        print(f"🚀 Starting real swarm benchmark: {config.benchmark_id}")
        print(f"   📋 Task: {config.task_description[:60]}...")
        print(f"   🎯 Strategy: {config.strategy}")
        print(f"   🔗 Coordination: {config.coordination_mode}")
        print(f"   👥 Max Agents: {config.max_agents}")
        
        start_time = time.time()
        
        with self.system_monitoring():
            try:
                # Execute real claude-flow command
                cmd = [
                    "npx", "claude-flow@alpha", "swarm",
                    config.task_description,
                    "--strategy", config.strategy,
                    "--coordination", config.coordination_mode,
                    "--max-agents", str(config.max_agents),
                    "--output-format", "json",
                    "--enable-metrics", "true"
                ]
                
                print(f"   🔧 Executing: {' '.join(cmd[:3])} ...")
                
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=config.timeout_seconds,
                    cwd=self.claude_flow_path
                )
                
                end_time = time.time()
                execution_time = end_time - start_time
                
                # Parse results and create metrics
                metrics = self._create_swarm_metrics(
                    config, start_time, end_time, execution_time,
                    result.returncode == 0, result.stdout, result.stderr
                )
                
                status = "✅" if metrics.success else "❌"
                print(f"   {status} Completed in {execution_time:.1f}s")
                print(f"   📊 Performance Score: {metrics.performance_score:.1f}/100")
                print(f"   🧠 Tokens: {metrics.token_consumption}")
                print(f"   💾 Memory Peak: {metrics.memory_usage_mb:.1f}MB")
                
                return metrics
                
            except subprocess.TimeoutExpired:
                end_time = time.time()
                execution_time = end_time - start_time
                print(f"   ⏰ Timeout after {execution_time:.1f}s")
                
                return self._create_timeout_metrics(config, start_time, end_time, execution_time)
                
            except Exception as e:
                end_time = time.time()
                execution_time = end_time - start_time
                print(f"   ❌ Exception: {e}")
                
                return self._create_error_metrics(config, start_time, end_time, execution_time, str(e))
    
    def _create_swarm_metrics(
        self, 
        config: RealSwarmConfig,
        start_time: float, 
        end_time: float,
        execution_time: float,
        success: bool,
        stdout: str,
        stderr: str
    ) -> SwarmMetrics:
        """Create comprehensive metrics from benchmark execution."""
        
        # Parse output for specific metrics
        output_analysis = self._analyze_swarm_output(stdout, stderr)
        
        # Calculate resource metrics
        resource_metrics = self._calculate_resource_metrics()
        
        # Calculate performance score
        performance_score = self._calculate_performance_score(
            execution_time, success, output_analysis, resource_metrics
        )
        
        return SwarmMetrics(
            benchmark_id=config.benchmark_id,
            start_time=start_time,
            end_time=end_time,
            execution_time=execution_time,
            success=success,
            agents_spawned=output_analysis.get("agents_spawned", config.max_agents),
            coordination_events=output_analysis.get("coordination_events", 0),
            task_completion_rate=output_analysis.get("completion_rate", 1.0 if success else 0.0),
            token_consumption=output_analysis.get("token_consumption", 0),
            memory_usage_mb=resource_metrics.get("peak_memory_mb", 0),
            cpu_usage_percent=resource_metrics.get("avg_cpu_percent", 0),
            disk_io_bytes=resource_metrics.get("total_disk_io", 0),
            network_requests=output_analysis.get("network_requests", 0),
            error_count=output_analysis.get("error_count", 0),
            warning_count=output_analysis.get("warning_count", 0),
            quality_indicators=output_analysis.get("quality_indicators", {}),
            performance_score=performance_score
        )
    
    def _analyze_swarm_output(self, stdout: str, stderr: str) -> Dict[str, Any]:
        """Analyze swarm output for metrics extraction."""
        analysis = {
            "agents_spawned": 0,
            "coordination_events": 0,
            "completion_rate": 0.0,
            "token_consumption": 0,
            "network_requests": 0,
            "error_count": 0,
            "warning_count": 0,
            "quality_indicators": {}
        }
        
        combined_output = stdout + stderr
        
        # Count various indicators
        analysis["error_count"] = combined_output.count("❌") + combined_output.count("Error") + combined_output.count("error")
        analysis["warning_count"] = combined_output.count("⚠️") + combined_output.count("Warning") + combined_output.count("warning")
        
        # Success indicators
        success_indicators = combined_output.count("✅") + combined_output.count("Complete") + combined_output.count("Success")
        analysis["quality_indicators"]["success_markers"] = success_indicators
        analysis["quality_indicators"]["code_blocks"] = combined_output.count("```")
        analysis["quality_indicators"]["bullet_points"] = combined_output.count("•") + combined_output.count("- ")
        
        # Try to parse JSON metrics if present
        try:
            lines = stdout.split('\n')
            for line in lines:
                stripped = line.strip()
                if stripped.startswith('{') and stripped.endswith('}'):
                    json_data = json.loads(stripped)
                    if "token_consumption" in json_data:
                        analysis["token_consumption"] = json_data["token_consumption"]
                    if "agents_spawned" in json_data:
                        analysis["agents_spawned"] = json_data["agents_spawned"]
                    break
        except:
            pass
        
        # Estimate token consumption if not found
        if analysis["token_consumption"] == 0:
            word_count = len(combined_output.split())
            analysis["token_consumption"] = int(word_count * 1.3)  # Rough estimate
        
        # Calculate completion rate
        if success_indicators > 0:
            analysis["completion_rate"] = min(1.0, success_indicators / 5.0)  # Normalize to 0-1
        
        return analysis
    
    def _calculate_resource_metrics(self) -> Dict[str, float]:
        """Calculate resource usage metrics from monitoring data."""
        if not self.resource_data:
            return {}
        
        cpu_values = [d["cpu_percent"] for d in self.resource_data]
        memory_values = [d["memory_mb"] for d in self.resource_data]
        
        # Calculate disk I/O delta
        if len(self.resource_data) > 1:
            start_disk = self.resource_data[0]["disk_read"] + self.resource_data[0]["disk_write"]
            end_disk = self.resource_data[-1]["disk_read"] + self.resource_data[-1]["disk_write"]
            total_disk_io = end_disk - start_disk
        else:
            total_disk_io = 0
        
        return {
            "avg_cpu_percent": sum(cpu_values) / len(cpu_values),
            "peak_cpu_percent": max(cpu_values),
            "avg_memory_mb": sum(memory_values) / len(memory_values),
            "peak_memory_mb": max(memory_values),
            "total_disk_io": total_disk_io,
            "sample_count": len(self.resource_data)
        }
    
    def _calculate_performance_score(
        self, 
        execution_time: float,
        success: bool,
        output_analysis: Dict[str, Any],
        resource_metrics: Dict[str, float]
    ) -> float:
        """Calculate overall performance score."""
        score = 0.0
        
        # Base score for success
        if success:
            score += 40.0
        
        # Time efficiency (faster is better, up to 30 points)
        # Assume 120s is baseline, scale accordingly
        baseline_time = 120.0
        if execution_time > 0:
            time_score = min(30.0, (baseline_time / execution_time) * 30.0)
            score += time_score
        
        # Quality indicators (up to 20 points)
        quality_score = 0
        quality_indicators = output_analysis.get("quality_indicators", {})
        quality_score += min(10, quality_indicators.get("success_markers", 0) * 2)
        quality_score += min(5, quality_indicators.get("code_blocks", 0))
        quality_score += min(5, quality_indicators.get("bullet_points", 0) * 0.5)
        score += quality_score
        
        # Resource efficiency (up to 10 points)
        if resource_metrics:
            cpu_efficiency = max(0, 10 - (resource_metrics.get("avg_cpu_percent", 50) / 10))
            score += cpu_efficiency
        
        # Penalty for errors and warnings
        error_penalty = output_analysis.get("error_count", 0) * 5
        warning_penalty = output_analysis.get("warning_count", 0) * 2
        score -= error_penalty + warning_penalty
        
        return max(0.0, min(100.0, score))
    
    def _create_timeout_metrics(
        self, 
        config: RealSwarmConfig,
        start_time: float,
        end_time: float,
        execution_time: float
    ) -> SwarmMetrics:
        """Create metrics for timed out benchmark."""
        resource_metrics = self._calculate_resource_metrics()
        
        return SwarmMetrics(
            benchmark_id=config.benchmark_id,
            start_time=start_time,
            end_time=end_time,
            execution_time=execution_time,
            success=False,
            agents_spawned=0,
            coordination_events=0,
            task_completion_rate=0.0,
            token_consumption=0,
            memory_usage_mb=resource_metrics.get("peak_memory_mb", 0),
            cpu_usage_percent=resource_metrics.get("avg_cpu_percent", 0),
            disk_io_bytes=resource_metrics.get("total_disk_io", 0),
            network_requests=0,
            error_count=1,  # Timeout is an error
            warning_count=0,
            quality_indicators={},
            performance_score=0.0
        )
    
    def _create_error_metrics(
        self,
        config: RealSwarmConfig,
        start_time: float,
        end_time: float,
        execution_time: float,
        error_msg: str
    ) -> SwarmMetrics:
        """Create metrics for failed benchmark."""
        resource_metrics = self._calculate_resource_metrics()
        
        return SwarmMetrics(
            benchmark_id=config.benchmark_id,
            start_time=start_time,
            end_time=end_time,
            execution_time=execution_time,
            success=False,
            agents_spawned=0,
            coordination_events=0,
            task_completion_rate=0.0,
            token_consumption=0,
            memory_usage_mb=resource_metrics.get("peak_memory_mb", 0),
            cpu_usage_percent=resource_metrics.get("avg_cpu_percent", 0),
            disk_io_bytes=resource_metrics.get("total_disk_io", 0),
            network_requests=0,
            error_count=1,
            warning_count=0,
            quality_indicators={},
            performance_score=0.0
        )
    
    def run_real_benchmark_suite(self) -> Dict[str, Any]:
        """Run complete real benchmark suite."""
        print("🔥 Real Swarm Benchmark Suite")
        print("=" * 50)
        
        configs = self.create_real_benchmark_configs()
        all_metrics = []
        
        for i, config in enumerate(configs, 1):
            print(f"\n[{i}/{len(configs)}] Running {config.benchmark_id}")
            print("-" * 40)
            
            metrics = self.execute_real_swarm_benchmark(config)
            all_metrics.append(metrics)
            self.metrics_history.append(metrics)
        
        # Generate suite analysis
        suite_analysis = self._analyze_benchmark_suite(all_metrics)
        
        # Save results
        self._save_benchmark_results(all_metrics, suite_analysis)
        
        return {
            "suite_metrics": [asdict(m) for m in all_metrics],
            "suite_analysis": suite_analysis,
            "timestamp": time.time()
        }
    
    def _analyze_benchmark_suite(self, metrics_list: List[SwarmMetrics]) -> Dict[str, Any]:
        """Analyze complete benchmark suite results."""
        if not metrics_list:
            return {}
        
        successful_metrics = [m for m in metrics_list if m.success]
        failed_metrics = [m for m in metrics_list if not m.success]
        
        analysis = {
            "total_benchmarks": len(metrics_list),
            "successful_benchmarks": len(successful_metrics),
            "failed_benchmarks": len(failed_metrics),
            "success_rate": len(successful_metrics) / len(metrics_list),
            "average_execution_time": sum(m.execution_time for m in successful_metrics) / len(successful_metrics) if successful_metrics else 0,
            "average_performance_score": sum(m.performance_score for m in successful_metrics) / len(successful_metrics) if successful_metrics else 0,
            "total_token_consumption": sum(m.token_consumption for m in metrics_list),
            "average_memory_usage": sum(m.memory_usage_mb for m in metrics_list) / len(metrics_list),
            "best_performer": None,
            "strategy_analysis": {},
            "coordination_analysis": {}
        }
        
        # Find best performer
        if successful_metrics:
            best = max(successful_metrics, key=lambda m: m.performance_score)
            analysis["best_performer"] = {
                "benchmark_id": best.benchmark_id,
                "performance_score": best.performance_score,
                "execution_time": best.execution_time,
                "token_consumption": best.token_consumption
            }
        
        # Strategy analysis
        strategy_groups = {}
        for metrics in successful_metrics:
            # Extract strategy from benchmark_id
            if "development" in metrics.benchmark_id:
                strategy = "development"
            elif "optimization" in metrics.benchmark_id:
                strategy = "optimization"
            elif "research" in metrics.benchmark_id:
                strategy = "research"
            elif "testing" in metrics.benchmark_id:
                strategy = "testing"
            else:
                strategy = "unknown"
            
            if strategy not in strategy_groups:
                strategy_groups[strategy] = []
            strategy_groups[strategy].append(metrics)
        
        for strategy, strategy_metrics in strategy_groups.items():
            avg_score = sum(m.performance_score for m in strategy_metrics) / len(strategy_metrics)
            avg_time = sum(m.execution_time for m in strategy_metrics) / len(strategy_metrics)
            analysis["strategy_analysis"][strategy] = {
                "average_score": avg_score,
                "average_time": avg_time,
                "benchmark_count": len(strategy_metrics)
            }
        
        return analysis
    
    def _save_benchmark_results(self, metrics_list: List[SwarmMetrics], analysis: Dict[str, Any]):
        """Save benchmark results to files."""
        output_dir = Path("/workspaces/claude-code-flow/benchmark/examples/output")
        output_dir.mkdir(exist_ok=True)
        
        # Save individual metrics  
        timestamp = int(time.time())
        
        for metrics in metrics_list:
            filename = f"real_swarm_{metrics.benchmark_id}_{timestamp}.json"
            with open(output_dir / filename, "w") as f:
                json.dump(asdict(metrics), f, indent=2)
        
        # Save suite analysis
        with open(output_dir / f"real_swarm_suite_analysis_{timestamp}.json", "w") as f:
            json.dump(analysis, f, indent=2)
        
        # Save summary CSV for easy analysis
        summary_file = output_dir / f"real_swarm_summary_{timestamp}.csv"
        with open(summary_file, "w") as f:
            f.write("benchmark_id,success,execution_time,performance_score,token_consumption,memory_mb,cpu_percent\n")
            for metrics in metrics_list:
                f.write(f"{metrics.benchmark_id},{metrics.success},{metrics.execution_time:.2f},"
                       f"{metrics.performance_score:.2f},{metrics.token_consumption},"
                       f"{metrics.memory_usage_mb:.2f},{metrics.cpu_usage_percent:.2f}\n")
        
        print(f"\n📁 Results saved to: {output_dir}")
        print(f"   📊 Individual metrics: real_swarm_*_{timestamp}.json")
        print(f"   📈 Suite analysis: real_swarm_suite_analysis_{timestamp}.json") 
        print(f"   📋 Summary CSV: real_swarm_summary_{timestamp}.csv")

if __name__ == "__main__":
    print("🔥 Real Swarm Benchmark Execution")
    print("=" * 50)
    
    # Initialize benchmark
    benchmark = RealSwarmBenchmark()
    
    # Run benchmark suite
    results = benchmark.run_real_benchmark_suite()
    
    # Display summary
    analysis = results.get("suite_analysis", {})
    print(f"\n📊 Benchmark Suite Summary")
    print("=" * 35)
    print(f"Total benchmarks: {analysis.get('total_benchmarks', 0)}")
    print(f"Success rate: {analysis.get('success_rate', 0):.1%}")
    print(f"Average execution time: {analysis.get('average_execution_time', 0):.1f}s")
    print(f"Average performance score: {analysis.get('average_performance_score', 0):.1f}/100")
    print(f"Total tokens consumed: {analysis.get('total_token_consumption', 0):,}")
    
    # Best performer
    best = analysis.get("best_performer")
    if best:
        print(f"\n🏆 Best Performer: {best['benchmark_id']}")
        print(f"   Score: {best['performance_score']:.1f}/100")
        print(f"   Time: {best['execution_time']:.1f}s")
        print(f"   Tokens: {best['token_consumption']:,}")
    
    # Strategy analysis
    strategy_analysis = analysis.get("strategy_analysis", {})
    if strategy_analysis:
        print(f"\n📈 Strategy Performance:")
        for strategy, perf in strategy_analysis.items():
            print(f"   {strategy}: {perf['average_score']:.1f}/100 ({perf['average_time']:.1f}s avg)")
    
    print(f"\n🎉 Real Swarm Benchmark Complete!")
    print("This benchmark provides:")
    print("- Actual claude-flow execution results")
    print("- Comprehensive performance metrics")
    print("- Resource utilization analysis")
    print("- Production readiness insights")