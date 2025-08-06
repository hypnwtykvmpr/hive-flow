#!/usr/bin/env python3
"""Test swarm command directly."""

import subprocess
import sys

# Test command
cmd = [
    "swarm-benchmark", 
    "real", 
    "swarm",
    "echo hello",
    "--strategy", "development",
    "--timeout", "1"
]

print(f"Running: {' '.join(cmd)}")
result = subprocess.run(cmd, capture_output=True, text=True)

print("STDOUT:")
print(result.stdout[:2000] if result.stdout else "(empty)")

print("\nSTDERR:")  
print(result.stderr[:1000] if result.stderr else "(empty)")

print(f"\nReturn code: {result.returncode}")
sys.exit(result.returncode)