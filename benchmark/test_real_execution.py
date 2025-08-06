#!/usr/bin/env python3
"""Test real command execution functionality."""

import subprocess
import sys
import json
import time
from pathlib import Path


def test_real_command_structure():
    """Test that real command structure is working."""
    print("🔧 Testing real command structure...")
    
    # Test real command group help
    result = subprocess.run([
        "swarm-benchmark", "real", "--help"
    ], capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"❌ Real command group failed: {result.stderr}")
        return False
    
    if "Real claude-flow command execution" not in result.stdout:
        print("❌ Real command group help text missing")
        return False
    
    # Test real swarm subcommand help
    result = subprocess.run([
        "swarm-benchmark", "real", "swarm", "--help"
    ], capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"❌ Real swarm command failed: {result.stderr}")
        return False
    
    if "OBJECTIVE:" not in result.stdout:
        print("❌ Real swarm command help text missing")
        return False
    
    print("✅ Real command structure working correctly")
    return True


def test_global_options():
    """Test that global options are working."""
    print("🌐 Testing global options...")
    
    # Test with global options
    result = subprocess.run([
        "swarm-benchmark", 
        "--verbose",
        "--real",
        "--claude-flow-path", "/custom/path",
        "--timeout", "10",
        "--no-stream",
        "list", 
        "--limit", "1"
    ], capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"❌ Global options test failed: {result.stderr}")
        return False
    
    print("✅ Global options working correctly")
    return True


def test_real_execution_dry_run():
    """Test real execution in dry-run mode."""
    print("🧪 Testing real execution (mock mode)...")
    
    try:
        # Import and test the CLI directly to avoid actual execution
        sys.path.insert(0, str(Path(__file__).parent / "src"))
        from swarm_benchmark.cli.main import cli
        from click.testing import CliRunner
        from unittest.mock import patch
        
        runner = CliRunner()
        
        # Mock the real benchmark engine to avoid actual execution
        with patch('swarm_benchmark.cli.main._run_real_benchmark') as mock_run:
            mock_run.return_value = {
                'summary': 'Mock real execution completed',
                'status': 'success'
            }
            
            result = runner.invoke(cli, [
                'real', 'swarm', 'Simple test task',
                '--strategy', 'auto',
                '--max-agents', '1',
                '--timeout', '1'
            ])
            
            if result.exit_code != 0:
                print(f"❌ Real execution test failed: {result.output}")
                return False
            
            if 'Real benchmark completed successfully' not in result.output:
                print(f"❌ Expected success message not found: {result.output}")
                return False
            
            print("✅ Real execution dry-run working correctly")
            return True
    
    except Exception as e:
        print(f"❌ Real execution test failed with exception: {e}")
        return False


def main():
    """Main test function."""
    print("🚀 Testing Real Command Execution")
    print("=" * 50)
    
    success = True
    
    # Test 1: Command structure
    if not test_real_command_structure():
        success = False
    
    # Test 2: Global options
    if not test_global_options():
        success = False
    
    # Test 3: Real execution dry-run
    if not test_real_execution_dry_run():
        success = False
    
    print("\n" + "=" * 50)
    
    if success:
        print("🎉 ALL REAL EXECUTION TESTS PASSED!")
        return 0
    else:
        print("❌ SOME REAL EXECUTION TESTS FAILED!")
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)