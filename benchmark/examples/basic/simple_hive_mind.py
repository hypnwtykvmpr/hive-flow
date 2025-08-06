#!/usr/bin/env python3
"""
Simple hive-mind benchmark example using collective intelligence.

This example demonstrates:
- Hive-mind initialization
- Collective decision making
- Neural pattern coordination
- Performance tracking
"""

import subprocess
import sys
import json
from pathlib import Path

def run_hive_mind_benchmark():
    """Run a simple hive-mind benchmark."""
    print("🧠 Starting Simple Hive-Mind Benchmark")
    print("=" * 50)
    
    # Example 1: CLI approach
    print("\n📋 Method 1: CLI with Hive-Mind Strategy")
    cmd = [
        "swarm-benchmark", "real", "hive-mind",
        "Analyze code patterns and suggest optimizations",
        "--agents", "5",
        "--thinking-pattern", "collective",
        "--coordination", "mesh"
    ]
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, cwd="/workspaces/claude-code-flow/benchmark")
        if result.returncode == 0:
            print(f"✅ Hive-mind CLI execution successful")
            print(f"🧠 Collective output: {result.stdout[:200]}...")
        else:
            print(f"❌ CLI execution failed: {result.stderr}")
    except Exception as e:
        print(f"⚠️  CLI execution error: {e}")
    
    # Example 2: Python API with collective intelligence
    print("\n📋 Method 2: Python API with Collective Intelligence")
    try:
        from swarm_benchmark.collective import HiveMindCoordinator
        
        # Initialize hive-mind coordinator
        coordinator = HiveMindCoordinator(
            agents=5,
            coordination_pattern="mesh",
            thinking_mode="collective"
        )
        
        # Configure collective task
        task_config = {
            "objective": "Code analysis and optimization suggestions",
            "domain": "software_engineering",
            "collective_threshold": 0.8,  # 80% agreement required
            "iteration_limit": 3
        }
        
        # Execute with collective intelligence
        result = coordinator.execute_collective_task(**task_config)
        
        print(f"✅ Collective intelligence execution successful")
        print(f"🎯 Consensus reached: {result.get('consensus_achieved', False)}")
        print(f"🧠 Collective confidence: {result.get('confidence_score', 0):.2f}")
        
    except ImportError:
        print("⚠️  Hive-mind components not available")
        demonstrate_mock_collective_behavior()
    except Exception as e:
        print(f"❌ Collective intelligence error: {e}")

def demonstrate_mock_collective_behavior():
    """Demonstrate collective behavior patterns."""
    print("\n🧠 Mock Collective Intelligence Demo")
    print("=" * 40)
    
    # Simulate collective decision making
    agents_opinions = [
        {"agent_id": "alpha", "confidence": 0.85, "decision": "optimize_loops"},
        {"agent_id": "beta", "confidence": 0.92, "decision": "optimize_loops"},
        {"agent_id": "gamma", "confidence": 0.78, "decision": "refactor_functions"},
        {"agent_id": "delta", "confidence": 0.88, "decision": "optimize_loops"},
        {"agent_id": "epsilon", "confidence": 0.76, "decision": "optimize_loops"}
    ]
    
    # Calculate collective decision
    decisions = {}
    for opinion in agents_opinions:
        decision = opinion["decision"]
        confidence = opinion["confidence"]
        if decision not in decisions:
            decisions[decision] = {"votes": 0, "total_confidence": 0}
        decisions[decision]["votes"] += 1
        decisions[decision]["total_confidence"] += confidence
    
    # Find consensus
    best_decision = max(decisions.items(), key=lambda x: x[1]["votes"])
    consensus_strength = best_decision[1]["total_confidence"] / best_decision[1]["votes"]
    
    print(f"🎯 Collective Decision: {best_decision[0]}")
    print(f"📊 Consensus Strength: {consensus_strength:.2f}")
    print(f"🗳️  Votes: {best_decision[1]['votes']}/5")
    
    return {
        "collective_decision": best_decision[0],
        "consensus_strength": consensus_strength,
        "participation_rate": 1.0
    }

def demonstrate_neural_patterns():
    """Show neural coordination patterns."""
    print("\n🔗 Neural Coordination Patterns")
    print("=" * 35)
    
    patterns = {
        "convergent": "Focused problem solving, single optimal solution",
        "divergent": "Creative exploration, multiple solution paths",
        "lateral": "Cross-domain thinking, unexpected connections",
        "systems": "Holistic analysis, system-wide optimization",
        "collective": "Group consensus, distributed decision making"
    }
    
    print("Available thinking patterns:")
    for pattern, description in patterns.items():
        print(f"  🧠 {pattern}: {description}")
    
    # Example coordination topology
    print("\nCoordination Topologies:")
    topologies = {
        "mesh": "Full connectivity, maximum information sharing",
        "hierarchical": "Tree structure, efficient coordination",
        "ring": "Sequential processing, ordered execution",
        "star": "Central coordinator, hub-and-spoke model"
    }
    
    for topology, description in topologies.items():
        print(f"  🔗 {topology}: {description}")

def collect_hive_mind_metrics():
    """Collect and save hive-mind specific metrics."""
    print("\n📊 Hive-Mind Metrics Collection")
    print("=" * 35)
    
    # Sample hive-mind metrics
    hive_metrics = {
        "benchmark_id": "simple-hive-mind-demo",
        "execution_time": 62.8,
        "agents_count": 5,
        "coordination_topology": "mesh",
        "thinking_pattern": "collective",
        "consensus_achieved": True,
        "consensus_strength": 0.87,
        "iteration_count": 2,
        "collective_confidence": 0.89,
        "neural_coordination_efficiency": 92.3,
        "information_sharing_rate": 0.95,
        "decision_coherence": 0.91
    }
    
    print("Hive-mind specific metrics:")
    print(json.dumps(hive_metrics, indent=2))
    
    # Save metrics
    output_dir = Path("/workspaces/claude-code-flow/benchmark/examples/output")
    output_dir.mkdir(exist_ok=True)
    
    with open(output_dir / "simple_hive_mind_metrics.json", "w") as f:
        json.dump(hive_metrics, f, indent=2)
    
    print(f"📁 Hive-mind metrics saved to: {output_dir / 'simple_hive_mind_metrics.json'}")

if __name__ == "__main__":
    run_hive_mind_benchmark()
    demonstrate_neural_patterns()
    mock_result = demonstrate_mock_collective_behavior()
    collect_hive_mind_metrics()
    
    print("\n🧠 Simple Hive-Mind Benchmark Complete!")
    print(f"🎯 Final collective decision confidence: {mock_result['consensus_strength']:.2f}")
    print("\nNext steps:")
    print("- Explore advanced collective intelligence in ../advanced/")
    print("- Run real hive-mind benchmarks in ../real/")
    print("- Compare with other coordination patterns")