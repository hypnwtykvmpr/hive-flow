# 🛠️ Claude-Flow Development Workflow Guide

## Table of Contents

- [Getting Started](#getting-started)
- [Development Environment](#development-environment)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing Strategy](#testing-strategy)
- [Code Standards](#code-standards)
- [CI/CD Pipeline](#cicd-pipeline)
- [Contributing](#contributing)
- [Release Process](#release-process)
- [Best Practices](#best-practices)

---

## Getting Started

### Prerequisites for Development

```bash
# Required tools
node --version  # v20.0.0 or higher
npm --version   # v9.0.0 or higher
git --version   # v2.30.0 or higher

# Recommended tools
pnpm --version  # Alternative package manager
docker --version  # For containerized development
code --version  # VS Code for development
```

### Setting Up Development Environment

```bash
# Clone the repository
git clone https://github.com/ruvnet/claude-flow.git
cd claude-flow

# Install dependencies
npm install

# Setup git hooks
npm run prepare

# Initialize development configuration
npm run dev:init

# Start development mode
npm run dev
```

### Development Scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/cli/main.ts",
    "build": "npm run clean && tsc",
    "clean": "rm -rf dist",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "eslint src --ext .ts",
    "format": "prettier --write 'src/**/*.{ts,js,json}'",
    "typecheck": "tsc --noEmit",
    "prepare": "husky install",
    "commit": "cz"
  }
}
```

---

## Development Environment

### VS Code Configuration

```json
// .vscode/settings.json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "typescript.tsdk": "node_modules/typescript/lib",
  "jest.autoRun": {
    "watch": true,
    "onSave": "test-src-file"
  },
  "files.exclude": {
    "**/dist": true,
    "**/node_modules": true,
    "**/.swarm": true
  }
}
```

### VS Code Extensions

```json
// .vscode/extensions.json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "ms-vscode.vscode-typescript-next",
    "orta.vscode-jest",
    "streetsidesoftware.code-spell-checker",
    "wayou.vscode-todo-highlight",
    "gruntfuggly.todo-tree",
    "eamodio.gitlens"
  ]
}
```

### Debug Configuration

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug CLI",
      "program": "${workspaceFolder}/src/cli/main.ts",
      "args": ["swarm", "test task"],
      "runtimeArgs": ["-r", "ts-node/register"],
      "sourceMaps": true,
      "env": {
        "NODE_ENV": "development",
        "CLAUDE_FLOW_DEBUG": "true"
      }
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Debug Tests",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": ["--runInBand", "--no-cache"],
      "console": "integratedTerminal",
      "internalConsoleOptions": "neverOpen"
    }
  ]
}
```

---

## Project Structure

### Directory Structure

```
claude-flow/
├── src/                    # Source code
│   ├── cli/               # CLI commands and entry points
│   ├── core/              # Core orchestration logic
│   ├── agents/            # Agent implementations
│   ├── swarm/             # Swarm coordination
│   ├── task/              # Task management
│   ├── memory/            # Memory system
│   ├── providers/         # LLM provider integrations
│   ├── api/               # REST API implementation
│   ├── mcp/               # MCP protocol implementation
│   ├── hooks/             # Hook system
│   ├── utils/             # Utility functions
│   └── types/             # TypeScript type definitions
├── tests/                  # Test suites
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   ├── e2e/               # End-to-end tests
│   └── fixtures/          # Test fixtures and mocks
├── docs/                   # Documentation
│   ├── api/               # API documentation
│   ├── guides/            # User guides
│   └── technical/         # Technical documentation
├── examples/               # Example code and tutorials
├── scripts/                # Build and utility scripts
├── config/                 # Configuration files
└── .github/                # GitHub workflows and templates
```

### Module Organization

```typescript
// src/core/orchestrator.ts
export class Orchestrator {
  // Main orchestration logic
}

// src/agents/base.ts
export abstract class BaseAgent {
  // Base agent implementation
}

// src/agents/specialized/coder.ts
export class CoderAgent extends BaseAgent {
  // Specialized coder agent
}

// src/swarm/coordinator.ts
export class SwarmCoordinator {
  // Swarm coordination logic
}

// src/memory/manager.ts
export class MemoryManager {
  // Memory management system
}
```

---

## Development Workflow

### Git Workflow

#### Branch Strategy

```bash
main                # Production-ready code
├── develop         # Integration branch
│   ├── feature/*   # Feature branches
│   ├── fix/*       # Bug fix branches
│   └── refactor/*  # Refactoring branches
├── release/*       # Release preparation
└── hotfix/*        # Emergency fixes
```

#### Creating a Feature

```bash
# Create feature branch
git checkout -b feature/agent-improvements

# Make changes
npm run dev  # Start development mode
# ... make your changes ...

# Run tests
npm test

# Commit changes
git add .
git commit -m "feat: improve agent selection algorithm"

# Push to remote
git push origin feature/agent-improvements

# Create pull request
gh pr create --title "Improve agent selection" --body "..."
```

### Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format
<type>(<scope>): <subject>

# Types
feat:     # New feature
fix:      # Bug fix
docs:     # Documentation
style:    # Code style
refactor: # Refactoring
test:     # Tests
chore:    # Maintenance
perf:     # Performance

# Examples
feat(agents): add new ml-developer agent type
fix(swarm): resolve coordination deadlock issue
docs(api): update REST API documentation
test(memory): add unit tests for memory manager
```

### Code Review Process

```markdown
## Pull Request Template

### Description
Brief description of changes

### Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

### Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

### Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings
```

---

## Testing Strategy

### Test Structure

```typescript
// tests/unit/agents/coder.test.ts
import { CoderAgent } from '../../../src/agents/specialized/coder';

describe('CoderAgent', () => {
  let agent: CoderAgent;
  
  beforeEach(() => {
    agent = new CoderAgent();
  });
  
  describe('execute', () => {
    it('should generate code for given task', async () => {
      const task = {
        type: 'code_generation',
        description: 'Create hello world function'
      };
      
      const result = await agent.execute(task);
      
      expect(result.success).toBe(true);
      expect(result.output).toContain('function');
    });
    
    it('should handle errors gracefully', async () => {
      const task = { type: 'invalid' };
      
      await expect(agent.execute(task)).rejects.toThrow();
    });
  });
});
```

### Test Categories

#### Unit Tests

```bash
# Run unit tests
npm run test:unit

# Run with coverage
npm run test:unit:coverage

# Run specific test
npm test -- agents/coder.test.ts
```

#### Integration Tests

```bash
# Run integration tests
npm run test:integration

# Test API endpoints
npm run test:api

# Test database operations
npm run test:db
```

#### End-to-End Tests

```bash
# Run E2E tests
npm run test:e2e

# Run with UI
npm run test:e2e:ui

# Run specific scenario
npm run test:e2e -- --grep "swarm coordination"
```

### Test Coverage Requirements

```yaml
# .github/codecov.yml
coverage:
  status:
    project:
      default:
        target: 80%
        threshold: 5%
    patch:
      default:
        target: 90%
```

---

## Code Standards

### TypeScript Configuration

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### ESLint Configuration

```json
// .eslintrc.json
{
  "parser": "@typescript-eslint/parser",
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:jest/recommended",
    "prettier"
  ],
  "plugins": ["@typescript-eslint", "jest"],
  "env": {
    "node": true,
    "jest": true
  },
  "rules": {
    "@typescript-eslint/explicit-function-return-type": "warn",
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "prefer-const": "error",
    "no-var": "error"
  }
}
```

### Prettier Configuration

```json
// .prettierrc.json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

---

## CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 21]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

  build:
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v3
        with:
          name: dist
          path: dist/

  e2e:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'
      - uses: actions/download-artifact@v3
        with:
          name: dist
          path: dist/
      - run: npm ci
      - run: npm run test:e2e
```

### Release Workflow

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish --tag alpha
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - uses: softprops/action-gh-release@v1
        with:
          files: |
            dist/**
            README.md
            CHANGELOG.md
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Contributing

### Setting Up for Contribution

```bash
# Fork the repository on GitHub

# Clone your fork
git clone https://github.com/YOUR_USERNAME/claude-flow.git
cd claude-flow

# Add upstream remote
git remote add upstream https://github.com/ruvnet/claude-flow.git

# Keep your fork updated
git fetch upstream
git checkout main
git merge upstream/main
```

### Development Process

```bash
# 1. Create feature branch
git checkout -b feature/your-feature

# 2. Make changes and test
npm run dev
npm test
npm run lint

# 3. Commit changes
git add .
git commit -m "feat: add amazing feature"

# 4. Push to your fork
git push origin feature/your-feature

# 5. Create pull request
gh pr create --repo ruvnet/claude-flow
```

### Code Review Guidelines

#### For Contributors

1. **Write clear PR descriptions**
2. **Include tests for new features**
3. **Update documentation**
4. **Follow code style guidelines**
5. **Respond to review feedback**

#### For Reviewers

1. **Test the changes locally**
2. **Check code quality and style**
3. **Verify test coverage**
4. **Provide constructive feedback**
5. **Approve when ready**

---

## Release Process

### Version Management

```bash
# Semantic versioning: MAJOR.MINOR.PATCH

# Patch release (bug fixes)
npm version patch  # 2.0.0 -> 2.0.1

# Minor release (new features)
npm version minor  # 2.0.0 -> 2.1.0

# Major release (breaking changes)
npm version major  # 2.0.0 -> 3.0.0

# Pre-release versions
npm version prerelease --preid=alpha  # 2.0.0 -> 2.0.1-alpha.0
npm version prerelease --preid=beta   # 2.0.0 -> 2.0.1-beta.0
```

### Release Checklist

```markdown
## Release Checklist

### Pre-release
- [ ] All tests passing
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Version bumped
- [ ] Dependencies updated

### Release
- [ ] Tag created
- [ ] GitHub release created
- [ ] NPM package published
- [ ] Docker image pushed
- [ ] Announcement prepared

### Post-release
- [ ] Documentation site updated
- [ ] Community notified
- [ ] Issues triaged
- [ ] Next version planned
```

### Changelog Generation

```bash
# Install conventional-changelog
npm install -g conventional-changelog-cli

# Generate changelog
conventional-changelog -p angular -i CHANGELOG.md -s

# Or use npm script
npm run changelog
```

---

## Best Practices

### Code Organization

```typescript
// ✅ Good: Single responsibility
export class TaskQueue {
  private queue: Task[] = [];
  
  enqueue(task: Task): void {
    this.queue.push(task);
  }
  
  dequeue(): Task | undefined {
    return this.queue.shift();
  }
}

// ❌ Bad: Multiple responsibilities
export class TaskManager {
  private queue: Task[] = [];
  private agents: Agent[] = [];
  private memory: Memory;
  
  // Too many responsibilities in one class
  enqueueTask() { /* ... */ }
  assignAgent() { /* ... */ }
  saveMemory() { /* ... */ }
}
```

### Error Handling

```typescript
// ✅ Good: Specific error types
export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

// ✅ Good: Proper error handling
async function executeTask(task: Task): Promise<TaskResult> {
  try {
    const agent = await selectAgent(task);
    return await agent.execute(task);
  } catch (error) {
    if (error instanceof AgentNotFoundError) {
      // Handle specific error
      return createFailureResult('No suitable agent');
    }
    // Re-throw unexpected errors
    throw error;
  }
}
```

### Testing Best Practices

```typescript
// ✅ Good: Descriptive test names
describe('SwarmCoordinator', () => {
  describe('when coordinating agents', () => {
    it('should distribute tasks evenly among available agents', () => {
      // Test implementation
    });
    
    it('should handle agent failures gracefully', () => {
      // Test implementation
    });
  });
});

// ✅ Good: Use test fixtures
const createTestAgent = (overrides?: Partial<Agent>): Agent => {
  return {
    id: 'test-agent',
    type: 'coder',
    status: 'active',
    ...overrides
  };
};
```

### Performance Optimization

```typescript
// ✅ Good: Efficient data structures
class AgentPool {
  private availableAgents = new Set<Agent>();
  private busyAgents = new Map<string, Agent>();
  
  getAvailable(): Agent | undefined {
    const agent = this.availableAgents.values().next().value;
    if (agent) {
      this.availableAgents.delete(agent);
      this.busyAgents.set(agent.id, agent);
    }
    return agent;
  }
}

// ✅ Good: Avoid unnecessary operations
async function processTask(tasks: Task[]): Promise<void> {
  // Process in parallel when possible
  await Promise.all(
    tasks.map(task => processIndividualTask(task))
  );
}
```

### Documentation

```typescript
/**
 * Coordinates multiple agents to achieve a complex objective
 * @param objective - The high-level goal to achieve
 * @param options - Configuration options for coordination
 * @returns Promise resolving to the coordination result
 * @example
 * ```typescript
 * const result = await coordinator.coordinate(
 *   'Build REST API',
 *   { topology: 'mesh', maxAgents: 10 }
 * );
 * ```
 */
export async function coordinate(
  objective: string,
  options?: CoordinationOptions
): Promise<CoordinationResult> {
  // Implementation
}
```

---

## Development Tools

### Useful Scripts

```bash
#!/bin/bash
# scripts/dev-setup.sh

# Setup development environment
echo "Setting up Claude-Flow development environment..."

# Install dependencies
npm install

# Setup git hooks
npx husky install

# Create local config
cp .env.example .env

# Initialize database
npm run db:init

# Run initial tests
npm test

echo "Development environment ready!"
```

### Debug Utilities

```typescript
// src/utils/debug.ts
export const debug = {
  log: (message: string, data?: any) => {
    if (process.env.CLAUDE_FLOW_DEBUG === 'true') {
      console.log(`[DEBUG] ${message}`, data || '');
    }
  },
  
  time: (label: string) => {
    if (process.env.CLAUDE_FLOW_DEBUG === 'true') {
      console.time(label);
    }
  },
  
  timeEnd: (label: string) => {
    if (process.env.CLAUDE_FLOW_DEBUG === 'true') {
      console.timeEnd(label);
    }
  }
};
```

### Performance Profiling

```bash
# Profile CPU usage
node --prof dist/cli/main.js swarm "complex task"
node --prof-process isolate-*.log > profile.txt

# Memory profiling
node --trace-gc dist/cli/main.js swarm "memory intensive"
node --expose-gc --inspect dist/cli/main.js

# Heap snapshot
node --heapsnapshot-signal=SIGUSR2 dist/cli/main.js
```

---

## Troubleshooting Development Issues

### Common Development Problems

#### TypeScript Compilation Errors

```bash
# Clear TypeScript cache
rm -rf dist tsconfig.tsbuildinfo

# Rebuild
npm run clean && npm run build

# Check for type errors
npm run typecheck
```

#### Test Failures

```bash
# Clear Jest cache
npx jest --clearCache

# Run tests in band (sequential)
npm test -- --runInBand

# Debug specific test
npm test -- --verbose path/to/test.ts
```

#### Dependency Issues

```bash
# Clear all caches
npm cache clean --force
rm -rf node_modules package-lock.json

# Reinstall
npm install

# Check for outdated packages
npm outdated

# Update dependencies
npm update
```

---

## Resources

### Documentation

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)
- [Conventional Commits](https://www.conventionalcommits.org/)

### Tools

- [VS Code](https://code.visualstudio.com/)
- [Postman](https://www.postman.com/) - API testing
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- [GitHub CLI](https://cli.github.com/)

### Community

- [Discord Server](https://discord.gg/claude-flow)
- [GitHub Discussions](https://github.com/ruvnet/claude-flow/discussions)
- [Stack Overflow](https://stackoverflow.com/questions/tagged/claude-flow)

---

<div align="center">

**Claude-Flow Development Workflow v2.0.0**

[Back to README](../README.md) | [Contributing](../CONTRIBUTING.md) | [Code of Conduct](../CODE_OF_CONDUCT.md)

</div>