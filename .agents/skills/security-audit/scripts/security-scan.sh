#!/bin/bash
# Security Audit - Full Scan Script
# Run comprehensive security scan pipeline

set -e

echo "Running full security scan..."

# Input validation
echo "Checking input validation..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security scan --check input-validation

# Path traversal
echo "Checking path traversal..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security scan --check path-traversal

# SQL injection
echo "Checking SQL injection..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security scan --check sql-injection

# XSS
echo "Checking XSS..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security scan --check xss

# Secrets
echo "Checking for hardcoded secrets..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security validate --check secrets

# CVE scan
echo "Scanning dependencies for CVEs..."
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js security cve --scan

echo "Security scan complete"
