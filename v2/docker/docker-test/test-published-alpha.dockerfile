FROM node:20-alpine

LABEL description="Test published hive-flow@alpha.50 package"
LABEL test_type="npm-package-validation"

# Install system dependencies
RUN apk add --no-cache \
    git \
    bash \
    curl

# Create test directory
WORKDIR /test-app

# Install the published alpha package
RUN npm install -g hive-flow@alpha

# Test basic functionality
RUN echo '#!/bin/bash\necho "=== Testing hive-flow@alpha.50 ===" && \
hive-flow --version && \
echo "=== Version check passed ===" && \
hive-flow --help && \
echo "=== Help command passed ===" && \
echo "✅ Package installation and basic commands working"' > /test-script.sh && chmod +x /test-script.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD hive-flow --version || exit 1

# Default command
CMD ["/test-script.sh"]