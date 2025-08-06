#!/usr/bin/env python3
import subprocess

cmd = ['swarm-benchmark', 'real', 'hive-mind', 'hello', '--max-workers', '2', '--timeout', '1']
print(f"Running: {' '.join(cmd)}")
result = subprocess.run(cmd, capture_output=True, text=True)
print('Return code:', result.returncode)
if result.stdout:
    print('Output:', result.stdout[:500])
if result.stderr:
    print('Stderr:', result.stderr[:500])