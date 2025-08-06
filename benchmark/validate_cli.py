#!/usr/bin/env python3
"""Validate CLI is working correctly."""

import subprocess
import sys
import json
import time
from pathlib import Path


def run_command(cmd, timeout=10):
    """Run a command and return result."""
    try:
        print(f"  Running: {' '.join(cmd)}")
        result = subprocess.run(
            cmd, 
            capture_output=True, 
            text=True, 
            timeout=timeout,
            cwd=Path(__file__).parent
        )
        return result
    except subprocess.TimeoutExpired:
        print(f"  ⏰ Command timed out after {timeout}s")
        return None
    except FileNotFoundError:
        print(f"  ❌ Command not found: {cmd[0]}")
        return None


def validate_cli():
    """Validate CLI is working correctly."""
    print("🔍 Validating CLI functionality...")
    print("=" * 50)
    
    failed_tests = []
    
    # Test cases: [command, expected_in_output, should_succeed]
    test_cases = [
        # Basic help and version
        (["swarm-benchmark", "--version"], "", True),
        (["swarm-benchmark", "--help"], "Claude Flow Advanced Swarm Benchmarking Tool", True),
        
        # Global options in help
        (["swarm-benchmark", "--help"], "--real / --mock", True),
        (["swarm-benchmark", "--help"], "--claude-flow-path", True),
        (["swarm-benchmark", "--help"], "--timeout", True),
        (["swarm-benchmark", "--help"], "--stream / --no-stream", True),
        
        # Command help tests
        (["swarm-benchmark", "run", "--help"], "Run a swarm benchmark", True),
        (["swarm-benchmark", "list", "--help"], "List recent benchmark runs", True),
        (["swarm-benchmark", "show", "--help"], "Show details for a specific benchmark", True),
        (["swarm-benchmark", "clean", "--help"], "Clean up benchmark results", True),
        (["swarm-benchmark", "serve", "--help"], "Start the benchmark web interface", True),
        
        # Real command group
        (["swarm-benchmark", "real", "--help"], "Real claude-flow command execution", True),
        (["swarm-benchmark", "real", "swarm", "--help"], "Run real claude-flow swarm benchmarks", True),
        
        # Strategy and mode options
        (["swarm-benchmark", "run", "--help"], "--strategy", True),
        (["swarm-benchmark", "run", "--help"], "--mode", True),
        (["swarm-benchmark", "real", "swarm", "--help"], "--strategy", True),
        (["swarm-benchmark", "real", "swarm", "--help"], "--mode", True),
        
        # Invalid commands should fail gracefully
        (["swarm-benchmark", "nonexistent"], "No such command", False),
    ]
    
    print(f"📋 Running {len(test_cases)} validation tests...\n")
    
    for i, (cmd, expected_output, should_succeed) in enumerate(test_cases, 1):
        print(f"Test {i:2}/{len(test_cases)}: {' '.join(cmd[:3])}{'...' if len(cmd) > 3 else ''}")
        
        result = run_command(cmd)
        
        if result is None:
            failed_tests.append(f"Test {i}: Command failed to run")
            continue
        
        # Check if command succeeded as expected
        if should_succeed and result.returncode != 0:
            failed_tests.append(f"Test {i}: Expected success but got exit code {result.returncode}")
            print(f"    ❌ Expected success but failed with code {result.returncode}")
            if result.stderr:
                print(f"    Error: {result.stderr.strip()}")
            continue
        
        if not should_succeed and result.returncode == 0:
            failed_tests.append(f"Test {i}: Expected failure but command succeeded")
            print(f"    ❌ Expected failure but command succeeded")
            continue
        
        # Check expected output if provided
        if expected_output:
            output = result.stdout + result.stderr
            if expected_output not in output:
                failed_tests.append(f"Test {i}: Expected '{expected_output}' not found in output")
                print(f"    ❌ Expected '{expected_output}' not found")
                continue
        
        print(f"    ✅ Passed")
    
    print("\n" + "=" * 50)
    
    if failed_tests:
        print(f"❌ {len(failed_tests)} test(s) failed:")
        for failure in failed_tests:
            print(f"  • {failure}")
        return False
    else:
        print(f"🎉 All {len(test_cases)} tests passed!")
        return True


def validate_installation():
    """Validate that the CLI tool is properly installed."""
    print("📦 Validating installation...")
    print("=" * 50)
    
    # Check if swarm-benchmark command is available
    result = run_command(["which", "swarm-benchmark"])
    if result and result.returncode == 0:
        cli_path = result.stdout.strip()
        print(f"✅ CLI found at: {cli_path}")
    else:
        print("⚠️  CLI not found in PATH, trying direct execution...")
        
        # Try running from local setup
        project_root = Path(__file__).parent
        setup_py = project_root / "setup.py"
        
        if setup_py.exists():
            print("📦 Installing in development mode...")
            install_result = run_command([
                sys.executable, "-m", "pip", "install", "-e", "."
            ], timeout=60)
            
            if install_result and install_result.returncode == 0:
                print("✅ Development installation successful")
            else:
                print("❌ Development installation failed")
                return False
        else:
            print("❌ No setup.py found for installation")
            return False
    
    return True


def run_integration_test():
    """Run a simple integration test."""
    print("\n🔧 Running integration test...")
    print("=" * 50)
    
    # Try to run a simple benchmark command (should not crash)
    test_cmd = [
        "swarm-benchmark", 
        "--verbose", 
        "--mock",
        "list",
        "--format", "json",
        "--limit", "1"
    ]
    
    result = run_command(test_cmd, timeout=30)
    
    if result is None:
        print("❌ Integration test failed - command timeout")
        return False
    
    if result.returncode != 0:
        print(f"❌ Integration test failed with exit code {result.returncode}")
        if result.stderr:
            print(f"Error output: {result.stderr}")
        return False
    
    print("✅ Integration test passed")
    return True


def main():
    """Main validation function."""
    print("🚀 Claude Flow Swarm Benchmark CLI Validation")
    print("=" * 50)
    print(f"Python: {sys.version}")
    print(f"Working directory: {Path.cwd()}")
    print()
    
    success = True
    
    # Step 1: Validate installation
    if not validate_installation():
        print("\n❌ Installation validation failed")
        success = False
    
    # Step 2: Validate CLI commands
    if not validate_cli():
        print("\n❌ CLI validation failed")
        success = False
    
    # Step 3: Run integration test
    if not run_integration_test():
        print("\n❌ Integration test failed")
        success = False
    
    print("\n" + "=" * 50)
    
    if success:
        print("🎉 ALL VALIDATIONS PASSED!")
        print("The CLI is working correctly and ready for use.")
        return 0
    else:
        print("❌ SOME VALIDATIONS FAILED!")
        print("Please check the errors above and fix the issues.")
        return 1


if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)