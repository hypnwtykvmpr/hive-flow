# Coder Agent Test Suite 🧪

Comprehensive testing framework for the coder agent functionality in Claude Flow.

## Features

- ✅ Unit tests for core coder agent functionality
- 🔗 Integration tests with swarm orchestration
- ⚡ Performance benchmarks
- 📊 Code coverage reporting
- 🔄 Parallel task execution tests
- 🛡️ Error handling and recovery tests
- 💾 Memory sharing validation

## Quick Start

```bash
# Install dependencies
npm install

# Run all tests
npm run test:all

# Run specific test suites
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests
npm run test:performance # Performance benchmarks

# Watch mode for development
npm run test:watch

# Generate coverage report
npm test -- --coverage
```

## Test Structure

### Unit Tests (`test-coder-agent.ts`)
- Core functionality validation
- Parallel execution testing
- Error handling scenarios
- Performance under load
- Advanced features (refactoring, test generation)

### Integration Tests (`integration-test.ts`)
- Swarm initialization
- Multi-agent coordination
- Task orchestration
- Memory sharing between agents
- Error recovery
- Performance metrics collection

### Performance Benchmarks (`performance-benchmark.ts`)
- Simple function generation speed
- Complex class generation
- Parallel task processing
- Code refactoring performance
- Test generation efficiency
- Memory operations
- Code analysis speed

## Test Results

### Expected Performance Metrics
- **Success Rate**: > 95%
- **Average Execution Time**: < 500ms per task
- **Memory Usage**: < 100MB under load
- **Parallel Efficiency**: 3-5x faster than sequential

### Coverage Goals
- **Branches**: 80%
- **Functions**: 80%
- **Lines**: 80%
- **Statements**: 80%

## Running with Claude Flow

```bash
# Initialize swarm for testing
npx claude-flow swarm init --topology mesh --agents 5

# Spawn coder agent
npx claude-flow agent spawn --type coder --name test-coder

# Run orchestrated test
npx claude-flow task orchestrate "Run coder agent test suite"

# Check performance metrics
npx claude-flow performance report --format detailed
```

## CI/CD Integration

The test suite is designed to integrate with CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Coder Tests
  run: |
    npm install
    npm run test:all
    npm run test -- --coverage
```

## Debugging

Enable verbose logging:
```bash
DEBUG=coder:* npm test
```

View real-time metrics:
```bash
npx claude-flow monitor --agent coder-test-agent
```

## Contributing

When adding new tests:
1. Follow the existing test structure
2. Ensure tests are isolated and reproducible
3. Add performance benchmarks for new features
4. Update documentation

## License

MIT