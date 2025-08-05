#!/bin/bash

# Test script to verify MLE-STAR single spawn fix

echo "🧪 Testing MLE-STAR automation fix for multiple Claude spawns"
echo "================================================"
echo

# Create a minimal test dataset
mkdir -p data
cat > data/test.csv << EOF
feature1,feature2,price
1.0,2.0,100
2.0,3.0,200
3.0,4.0,300
4.0,5.0,400
5.0,6.0,500
EOF

echo "📊 Created test dataset: data/test.csv"
echo

# Test 1: Default behavior (should be non-interactive)
echo "Test 1: Default MLE-STAR (should use non-interactive mode)"
echo "./claude-flow automation mle-star --dataset data/test.csv --target price --claude"
echo
echo "Expected: Non-interactive mode with independent agent spawns"
echo "Press Ctrl+C to stop if multiple interactive Claude sessions appear"
echo

# Test 2: Explicit non-interactive
echo "Test 2: Explicit non-interactive mode"
echo "./claude-flow automation mle-star --dataset data/test.csv --target price --claude --non-interactive"
echo
echo "Expected: Same as Test 1 - non-interactive mode"
echo

# Test 3: Interactive mode (should spawn single master coordinator)
echo "Test 3: Interactive mode (single master coordinator)"
echo "./claude-flow automation mle-star --dataset data/test.csv --target price --claude --interactive"
echo
echo "Expected: Single Claude interactive session as master coordinator"
echo "⚠️  WARNING: This will spawn one interactive Claude session"
echo

# Test 4: Without Claude integration (simulation only)
echo "Test 4: Simulation mode (no Claude integration)"
echo "./claude-flow automation mle-star --dataset data/test.csv --target price"
echo
echo "Expected: Simulation only, no Claude instances spawned"
echo

echo "✅ Test commands prepared. Run them individually to verify the fix."
echo "   The default behavior should now prevent multiple interactive Claude spawns."