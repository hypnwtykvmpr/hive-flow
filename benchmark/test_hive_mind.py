#!/usr/bin/env python3
"""Test hive-mind command directly."""

import subprocess
import sys

# Test command
cmd = [
    "swarm-benchmark", 
    "real", 
    "hive-mind",
    "Design hello world",
    "--max-workers", "2",
    "--timeout", "1"
]

print(f"Running: {' '.join(cmd)}")
result = subprocess.run(cmd, capture_output=True, text=True)

print("STDOUT:")
print(result.stdout[:1000] if result.stdout else "(empty)")

print("\nSTDERR:")  
print(result.stderr[:1000] if result.stderr else "(empty)")

print(f"\nReturn code: {result.returncode}")
sys.exit(result.returncode)