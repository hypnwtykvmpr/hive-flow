#!/bin/bash
# Docker test for MCP stdio mode fix
# This runs in a clean container to verify the npm package works correctly

set -e

echo "🐳 Testing hive-flow@2.7.8 MCP stdio mode in Docker..."
echo ""

# Create a temporary Dockerfile
cat > /tmp/Dockerfile.hive-flow-test <<'EOF'
FROM node:20-alpine

# Install hive-flow@2.7.8
RUN npm install -g hive-flow@2.7.8

# Create test script
RUN echo '#!/bin/sh' > /test-stdio.sh && \
    echo 'echo "Testing MCP stdio mode..."' >> /test-stdio.sh && \
    echo 'timeout 2s hive-flow mcp start > stdout.txt 2> stderr.txt || true' >> /test-stdio.sh && \
    echo 'echo ""' >> /test-stdio.sh && \
    echo "echo '=== STDOUT (should be clean JSON-RPC) ==='" >> /test-stdio.sh && \
    echo 'cat stdout.txt' >> /test-stdio.sh && \
    echo 'echo ""' >> /test-stdio.sh && \
    echo "echo '=== STDERR (should have startup messages) ==='" >> /test-stdio.sh && \
    echo 'head -5 stderr.txt' >> /test-stdio.sh && \
    echo 'echo ""' >> /test-stdio.sh && \
    echo 'if grep -q "✅ Starting" stdout.txt; then' >> /test-stdio.sh && \
    echo '  echo "❌ FAIL: Startup message found on stdout"' >> /test-stdio.sh && \
    echo '  exit 1' >> /test-stdio.sh && \
    echo 'elif grep -q "jsonrpc" stdout.txt; then' >> /test-stdio.sh && \
    echo '  echo "✅ PASS: JSON-RPC on stdout, startup messages on stderr"' >> /test-stdio.sh && \
    echo '  exit 0' >> /test-stdio.sh && \
    echo 'else' >> /test-stdio.sh && \
    echo '  echo "⚠️  WARNING: No JSON-RPC found (server may not have started)"' >> /test-stdio.sh && \
    echo '  exit 1' >> /test-stdio.sh && \
    echo 'fi' >> /test-stdio.sh && \
    chmod +x /test-stdio.sh

CMD ["/test-stdio.sh"]
EOF

# Build and run the test
docker build -t hive-flow-stdio-test -f /tmp/Dockerfile.hive-flow-test /tmp

echo ""
echo "Running test in container..."
docker run --rm hive-flow-stdio-test

echo ""
echo "✅ Docker test completed successfully!"
