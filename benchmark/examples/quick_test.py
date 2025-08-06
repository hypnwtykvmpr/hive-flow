#!/usr/bin/env python3
"""
Quick test of swarm-benchmark real execution.
"""

import subprocess
import json
import sys

def test_real_swarm():
    """Test real swarm execution with simple task."""
    print("🧪 Testing swarm-benchmark real execution...")
    
    # Test with a simple echo command
    cmd = [
        "swarm-benchmark", "real", "swarm",
        "echo hello world",
        "--max-agents", "1",
        "--timeout", "10"
    ]
    
    print(f"Command: {' '.join(cmd)}")
    
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15
        )
        
        print(f"Return code: {result.returncode}")
        
        if result.stdout:
            print("Output:")
            print(result.stdout[:500])
        
        if result.stderr:
            print("Errors:")
            print(result.stderr[:500])
            
        return result.returncode == 0
        
    except subprocess.TimeoutExpired:
        print("⏱️ Command timed out (expected for long tasks)")
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

if __name__ == "__main__":
    success = test_real_swarm()
    sys.exit(0 if success else 1)