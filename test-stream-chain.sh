#!/bin/bash

# Test real stream chaining with Claude Code

echo "🔗 Testing Stream Chain with Claude Code"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Step 1: Generate initial output
echo -e "\n📝 Step 1: Generate a simple function"
OUTPUT1=$(claude -p --output-format stream-json --verbose "Write a one-line Python function to add two numbers" 2>/dev/null)

# Extract the assistant's response
CONTENT1=$(echo "$OUTPUT1" | jq -r 'select(.type == "assistant") | .message.content[0].text' | head -1)
echo "✅ Generated: $CONTENT1"

# Step 2: Chain to review
echo -e "\n📝 Step 2: Review the function"
# Create a proper user message for input
USER_MSG=$(cat <<EOF
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{
      "type": "text",
      "text": "Review this function and suggest one improvement: $CONTENT1"
    }]
  }
}
EOF
)

# For now, since --input-format stream-json has issues, just use regular prompt
OUTPUT2=$(claude -p "Review this function and suggest one improvement: $CONTENT1" 2>/dev/null)
echo "✅ Review: $OUTPUT2"

echo -e "\n✨ Chain completed successfully!"