#!/usr/bin/env python3
"""
Real Hive-Flow Benchmark Test
Tests actual hive-flow execution with --non-interactive flag
"""

import subprocess
import time
import json
import os
from pathlib import Path
import sys

# Add parent directory to path to access hive-flow
sys.path.insert(0, str(Path(__file__).parent.parent))

class RealHiveFlowBenchmark:
    def __init__(self):
        self.hive_flow_path = Path(__file__).parent.parent / "hive-flow"
        self.results = []
        
    def run_command(self, command, description):
        """Execute a hive-flow command and measure performance"""
        print(f"\n{'='*60}")
        print(f"Running: {description}")
        print(f"Command: {' '.join(command)}")
        print(f"{'='*60}")
        
        start_time = time.time()
        
        try:
            # Run the command
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=30  # 30 second timeout
            )
            
            end_time = time.time()
            duration = end_time - start_time
            
            # Prepare result
            benchmark_result = {
                "description": description,
                "command": " ".join(command),
                "duration": duration,
                "success": result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "return_code": result.returncode
            }
            
            self.results.append(benchmark_result)
            
            # Print summary
            status = "✅ SUCCESS" if result.returncode == 0 else "❌ FAILED"
            print(f"{status} - Duration: {duration:.2f}s")
            
            if result.stdout:
                print(f"\nOutput:\n{result.stdout[:500]}...")
            if result.stderr:
                print(f"\nErrors:\n{result.stderr[:500]}...")
                
            return benchmark_result
            
        except subprocess.TimeoutExpired:
            print("❌ TIMEOUT - Command took too long")
            return {
                "description": description,
                "command": " ".join(command),
                "duration": 30,
                "success": False,
                "error": "Timeout after 30 seconds"
            }
        except Exception as e:
            print(f"❌ ERROR - {str(e)}")
            return {
                "description": description,
                "command": " ".join(command),
                "duration": 0,
                "success": False,
                "error": str(e)
            }
    
    def test_basic_commands(self):
        """Test basic hive-flow commands"""
        print("\n🧪 Testing Basic Hive-Flow Commands")
        
        # Test 1: Version check
        self.run_command(
            [str(self.hive_flow_path), "--version"],
            "Version Check"
        )
        
        # Test 2: Help command
        self.run_command(
            [str(self.hive_flow_path), "--help"],
            "Help Command"
        )
        
        # Test 3: Status command
        self.run_command(
            [str(self.hive_flow_path), "status", "--non-interactive"],
            "Status Command (Non-Interactive)"
        )
    
    def test_sparc_commands(self):
        """Test SPARC mode commands"""
        print("\n🧪 Testing SPARC Mode Commands")
        
        # Test 1: SPARC list
        self.run_command(
            [str(self.hive_flow_path), "sparc", "list", "--non-interactive"],
            "SPARC List Modes"
        )
        
        # Test 2: SPARC coder mode
        self.run_command(
            [str(self.hive_flow_path), "sparc", "coder", 
             "Create a simple hello world function", "--non-interactive"],
            "SPARC Coder Mode"
        )
        
        # Test 3: SPARC researcher mode
        self.run_command(
            [str(self.hive_flow_path), "sparc", "researcher",
             "Research best practices for Python testing", "--non-interactive"],
            "SPARC Researcher Mode"
        )
    
    def test_swarm_commands(self):
        """Test Swarm commands"""
        print("\n🧪 Testing Swarm Commands")
        
        # Test 1: Simple swarm with auto strategy
        self.run_command(
            [str(self.hive_flow_path), "swarm",
             "Create a basic calculator", 
             "--strategy", "auto",
             "--non-interactive"],
            "Swarm Auto Strategy"
        )
        
        # Test 2: Research swarm
        self.run_command(
            [str(self.hive_flow_path), "swarm",
             "Research cloud computing trends",
             "--strategy", "research",
             "--mode", "distributed",
             "--non-interactive"],
            "Swarm Research Strategy (Distributed)"
        )
        
        # Test 3: Development swarm
        self.run_command(
            [str(self.hive_flow_path), "swarm",
             "Build a REST API endpoint",
             "--strategy", "development",
             "--mode", "hierarchical",
             "--non-interactive"],
            "Swarm Development Strategy (Hierarchical)"
        )
    
    def generate_report(self):
        """Generate benchmark report"""
        print("\n" + "="*60)
        print("📊 BENCHMARK SUMMARY REPORT")
        print("="*60)
        
        total_tests = len(self.results)
        successful_tests = sum(1 for r in self.results if r.get("success", False))
        failed_tests = total_tests - successful_tests
        
        print(f"\n✅ Successful Tests: {successful_tests}/{total_tests}")
        print(f"❌ Failed Tests: {failed_tests}/{total_tests}")
        
        if self.results:
            avg_duration = sum(r.get("duration", 0) for r in self.results) / len(self.results)
            print(f"⏱️  Average Duration: {avg_duration:.2f}s")
        
        print("\n📋 Test Results:")
        for result in self.results:
            status = "✅" if result.get("success", False) else "❌"
            duration = result.get("duration", 0)
            print(f"  {status} {result['description']}: {duration:.2f}s")
        
        # Save results to JSON
        output_file = Path(__file__).parent / "real_benchmark_results.json"
        with open(output_file, "w") as f:
            json.dump({
                "timestamp": time.time(),
                "summary": {
                    "total_tests": total_tests,
                    "successful_tests": successful_tests,
                    "failed_tests": failed_tests,
                    "average_duration": avg_duration if self.results else 0
                },
                "results": self.results
            }, f, indent=2)
        
        print(f"\n💾 Results saved to: {output_file}")
    
    def run_all_tests(self):
        """Run all benchmark tests"""
        print("🚀 Starting Real Hive-Flow Benchmark Tests")
        print(f"Using: {self.hive_flow_path}")
        
        self.test_basic_commands()
        self.test_sparc_commands()
        self.test_swarm_commands()
        
        self.generate_report()


if __name__ == "__main__":
    benchmark = RealHiveFlowBenchmark()
    benchmark.run_all_tests()