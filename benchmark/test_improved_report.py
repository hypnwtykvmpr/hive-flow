#!/usr/bin/env python3
"""Test improved reporting."""

import subprocess
import sys

# Test swarm command
print("Testing improved swarm reporting...")
cmd = [
    "swarm-benchmark", "real", "swarm",
    "Design hello world",
    "--strategy", "development",
    "--timeout", "1"
]

result = subprocess.run(cmd, capture_output=True, text=True)
print(result.stdout)
if result.stderr:
    print("Stderr:", result.stderr[:500], file=sys.stderr)

print("\n" + "="*60)
print("Testing hive-mind reporting...")

# Test hive-mind
cmd2 = [
    "swarm-benchmark", "real", "hive-mind",
    "Create API",
    "--max-workers", "2",
    "--timeout", "1"
]

result2 = subprocess.run(cmd2, capture_output=True, text=True)
print(result2.stdout)

sys.exit(0)