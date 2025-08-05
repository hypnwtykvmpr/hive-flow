#!/bin/bash

# Test script for stream-json chaining capabilities

echo "🔗 Testing Stream-JSON Chaining in Claude Flow"
echo "=============================================="
echo

# Create test data
mkdir -p data
cat > data/chaining-test.csv << EOF
id,value,category
1,100,A
2,200,B
3,150,A
4,250,B
5,300,A
EOF

echo "📊 Created test dataset: data/chaining-test.csv"
echo

echo "Test 1: Stream Chaining with Custom Workflow"
echo "--------------------------------------------"
echo "Command: ./claude-flow automation run-workflow test-stream-chaining-workflow.json --claude --non-interactive --output-format stream-json"
echo
echo "This will:"
echo "1. Analyzer agent analyzes data and outputs stream-json"
echo "2. Processor agent receives analyzer's output via stdin and continues the chain"
echo "3. Reporter agent receives processor's output and completes the workflow"
echo
echo "Expected behavior: Each agent should show '🔗 Chaining:' messages"
echo

echo "Test 2: MLE-STAR with Stream Chaining"
echo "-------------------------------------"
echo "Command: ./claude-flow automation mle-star --dataset data/chaining-test.csv --target category --claude --output-format stream-json"
echo
echo "This will run the full MLE-STAR workflow with stream chaining enabled"
echo "Dependencies will automatically pipe outputs between agents"
echo

echo "Test 3: Disable Chaining"
echo "------------------------"
echo "Command: ./claude-flow automation mle-star --dataset data/chaining-test.csv --target category --claude --output-format stream-json --no-chaining"
echo
echo "This runs with stream-json output but WITHOUT chaining (agents run independently)"
echo

echo "Test 4: Manual Stream Chaining (Traditional)"
echo "--------------------------------------------"
echo "You can also manually chain Claude instances:"
echo
echo "# Agent 1"
echo 'claude --print --output-format stream-json "Analyze data" > agent1.jsonl'
echo
echo "# Agent 2 (receives Agent 1's output)"
echo 'cat agent1.jsonl | claude --print --input-format stream-json --output-format stream-json "Continue analysis" > agent2.jsonl'
echo
echo "# Agent 3 (receives Agent 2's output)"
echo 'cat agent2.jsonl | claude --print --input-format stream-json "Generate report"'
echo

echo "✅ Test commands prepared. Run them to see stream chaining in action!"
echo "   Look for '🔗 Enabling stream chaining' messages in the output."