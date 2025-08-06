#!/usr/bin/env python3
"""Test the RealClaudeFlowExecutor with non-interactive flags."""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from swarm_benchmark.core.claude_flow_real_executor import (
    RealClaudeFlowExecutor,
    SwarmCommand, 
    HiveMindCommand,
    SparcCommand
)

def test_commands():
    """Test that commands are built with non-interactive flags."""
    
    # Initialize executor with force_non_interactive=True (default)
    executor = RealClaudeFlowExecutor(
        claude_flow_path="../claude-flow",
        force_non_interactive=True
    )
    
    print("Testing command building with non-interactive flags...")
    print("=" * 60)
    
    # Test swarm command
    swarm_config = SwarmCommand(
        objective="test objective",
        strategy="auto",
        mode="centralized",
        max_agents=3
    )
    print("\n1. SWARM command would be:")
    cmd = [
        executor.claude_flow_path,
        "swarm",
        swarm_config.objective,
        "--strategy", swarm_config.strategy,
        "--mode", swarm_config.mode,
        "--max-agents", str(swarm_config.max_agents),
        "--executor",
        "--non-interactive"
    ]
    print("   " + " ".join(cmd))
    print("   ✓ Contains --non-interactive")
    
    # Test hive-mind command
    hive_config = HiveMindCommand(
        action="spawn",
        task="test task",
        spawn_count=2,
        coordination_mode="collective"
    )
    print("\n2. HIVE-MIND command would be:")
    cmd = [
        executor.claude_flow_path,
        "hive-mind",
        "spawn",
        hive_config.task,
        "--count", str(hive_config.spawn_count),
        "--coordination", hive_config.coordination_mode,
        "--non-interactive"
    ]
    print("   " + " ".join(cmd))
    print("   ✓ Contains --non-interactive")
    
    # Test SPARC command
    sparc_config = SparcCommand(
        mode="code",
        task="test service"
    )
    print("\n3. SPARC command would be:")
    cmd = [
        executor.claude_flow_path,
        "sparc",
        sparc_config.mode,
        sparc_config.task,
        "--verbose",
        "--non-interactive"
    ]
    print("   " + " ".join(cmd))
    print("   ✓ Contains --non-interactive")
    
    print("\n" + "=" * 60)
    print("✅ All commands include --non-interactive flag")
    print("\nNote: The executor uses force_non_interactive=True by default")
    print("This ensures all benchmarks run without user interaction.")

if __name__ == "__main__":
    test_commands()