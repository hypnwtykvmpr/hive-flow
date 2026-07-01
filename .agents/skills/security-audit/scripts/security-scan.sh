#!/bin/bash
# Security Audit - Full Scan Script
# Run comprehensive security scan pipeline

set -e

echo "Running full security scan..."

# Input validation
echo "Checking input validation..."
hive-flow security scan --check input-validation

# Path traversal
echo "Checking path traversal..."
hive-flow security scan --check path-traversal

# SQL injection
echo "Checking SQL injection..."
hive-flow security scan --check sql-injection

# XSS
echo "Checking XSS..."
hive-flow security scan --check xss

# Secrets
echo "Checking for hardcoded secrets..."
hive-flow security validate --check secrets

# CVE scan
echo "Scanning dependencies for CVEs..."
hive-flow security cve --scan

echo "Security scan complete"
