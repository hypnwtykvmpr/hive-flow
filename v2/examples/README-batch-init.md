# Batch Initialization Examples

This directory contains comprehensive examples demonstrating the powerful batch initialization features of Hive-Flow.

## Quick Start

1. **Simple Batch Setup**
   ```bash
   hive-flow init --batch-init project1,project2,project3 --sparc
   ```

2. **Template-Based Setup**
   ```bash
   hive-flow init --batch-init api-v1,api-v2 --template web-api --environments dev,staging
   ```

3. **Configuration File Setup**
   ```bash
   hive-flow init --config examples/batch-config-enterprise.json
   ```

## Example Files

### Configuration Files

#### `batch-config-simple.json`
Basic configuration for 3 projects with web-api template across dev and staging environments.

**Usage:**
```bash
hive-flow init --config examples/batch-config-simple.json
```

**Creates:**
- `api-service-dev/` and `api-service-staging/`
- `web-frontend-dev/` and `web-frontend-staging/`
- `admin-dashboard-dev/` and `admin-dashboard-staging/`

#### `batch-config-advanced.json`
Advanced configuration with project-specific templates and customizations.

**Usage:**
```bash
hive-flow init --config examples/batch-config-advanced.json
```

**Creates:**
- `user-api/` (Web API with PostgreSQL)
- `notification-service/` (Microservice with RabbitMQ)
- `admin-portal/` (React app with Material-UI)
- `cli-tools/` (CLI tool for Node/Deno)
- `payment-gateway/` (High-security microservice)

#### `batch-config-enterprise.json`
Enterprise-scale configuration with 12 projects across all environments.

**Usage:**
```bash
hive-flow init --config examples/batch-config-enterprise.json --max-concurrent 8
```

**Creates:**
- Core API (prod, staging, dev versions)
- Web applications (prod, staging, dev versions)
- Microservices (user, notification, payment)
- Tools (admin CLI, monitoring dashboard, load testing)

### Demo and Test Files

#### `batch-init-demo.js`
Interactive demonstration of all batch initialization features.

**Usage:**
```bash
deno run --allow-all examples/batch-init-demo.js
```

**Shows:**
- All available templates and environments
- Command examples and use cases
- Performance features and benefits
- Integration with SPARC methodology

#### `../tests/batch-init.test.js`
Comprehensive test suite for batch initialization functionality.

**Usage:**
```bash
deno run --allow-all tests/batch-init.test.js
```

**Tests:**
- Options validation
- Template functionality
- Environment configurations
- Error handling
- Performance monitoring

## Use Cases by Scale

### Small Teams (1-5 projects)
```bash
# Quick setup for small team
hive-flow init --batch-init api,web,mobile --template web-api --sparc
```

**Best for:**
- Startups
- Small development teams
- Proof of concepts
- Personal projects

### Medium Teams (5-15 projects)
```bash
# Use configuration file for better organization
hive-flow init --config batch-config-advanced.json --parallel
```

**Best for:**
- Growing companies
- Multi-service architectures
- Cross-functional teams
- Product development

### Enterprise (15+ projects)
```bash
# Enterprise-scale with high concurrency
hive-flow init --config batch-config-enterprise.json --max-concurrent 8 --parallel
```

**Best for:**
- Large organizations
- Microservice architectures
- Multi-team coordination
- Complex deployments

## Performance Examples

### Sequential vs Parallel Comparison
```bash
# Sequential (slower but lower resource usage)
hive-flow init --batch-init project1,project2,project3,project4,project5 --no-parallel

# Parallel (faster with optimal concurrency)
hive-flow init --batch-init project1,project2,project3,project4,project5 --parallel --max-concurrent 3
```

### Resource Monitoring
```bash
# With performance monitoring
hive-flow init --config batch-config-advanced.json --verbose

# Estimate before running
hive-flow batch estimate batch-config-enterprise.json
```

## Template Examples

### Web API Projects
```bash
# Multiple API services
hive-flow init --batch-init user-api,product-api,order-api --template web-api

# With different environments
hive-flow init --batch-init inventory-api --template web-api --environments dev,staging,prod
```

### React Applications
```bash
# Frontend applications
hive-flow init --batch-init customer-portal,admin-panel --template react-app

# With SPARC for TDD
hive-flow init --batch-init dashboard --template react-app --sparc
```

### Microservices
```bash
# Containerized services
hive-flow init --batch-init auth-service,payment-service,notification-service --template microservice

# Production-ready with monitoring
hive-flow init --batch-init core-services --template microservice --environments prod --sparc
```

### CLI Tools
```bash
# Command-line utilities
hive-flow init --batch-init deployment-tool,migration-tool --template cli-tool

# Cross-platform tools
hive-flow init --batch-init admin-cli --template cli-tool --environments dev
```

## Environment Examples

### Development Setup
```bash
# Development environment with debugging
hive-flow init --batch-init myapp --environments dev --template web-api
```

**Creates:**
- Debug mode enabled
- Hot reload configuration
- Verbose logging
- Development database settings

### Staging Environment
```bash
# Staging environment for testing
hive-flow init --batch-init myapp --environments staging --template microservice
```

**Creates:**
- Testing tools enabled
- Monitoring setup
- Preview mode features
- Integration test configuration

### Production Environment
```bash
# Production environment with security
hive-flow init --batch-init myapp --environments prod --template microservice
```

**Creates:**
- Security hardening
- Performance optimization
- Minimal logging
- Production database settings

### Multi-Environment Pipeline
```bash
# Complete CI/CD pipeline
hive-flow init --batch-init payment-service --environments dev,staging,prod --template microservice
```

**Creates:**
- `payment-service-dev/` - Development version
- `payment-service-staging/` - Testing version  
- `payment-service-prod/` - Production version

## Integration Examples

### With SPARC Development
```bash
# SPARC-enabled batch initialization
hive-flow init --batch-init project1,project2 --sparc --template web-api
```

**Creates:**
- `.claude/commands/` - Claude Code slash commands
- SPARC methodology integration
- TDD workflow support
- Architecture documentation

### With Custom Configuration
```bash
# Custom batch configuration
cat > my-batch.json << 'EOF'
{
  "projects": ["my-api", "my-web"],
  "baseOptions": {
    "sparc": true,
    "template": "web-api",
    "environments": ["dev"],
    "parallel": true,
    "maxConcurrency": 2
  }
}
EOF

hive-flow init --config my-batch.json
```

## Batch Manager Examples

### Configuration Management
```bash
# Create interactive configuration
hive-flow batch create-config --interactive

# Validate configuration
hive-flow batch validate-config my-batch.json

# Estimate resources
hive-flow batch estimate my-batch.json
```

### Template and Environment Discovery
```bash
# List available templates
hive-flow batch list-templates

# List available environments
hive-flow batch list-environments

# Get help
hive-flow batch help
```

## Troubleshooting Examples

### Common Issues

#### Memory Usage Too High
```bash
# Reduce concurrency
hive-flow init --batch-init projects --max-concurrent 2

# Use minimal template
hive-flow init --batch-init projects --minimal
```

#### Slow Performance
```bash
# Enable parallel processing
hive-flow init --batch-init projects --parallel

# Use faster template
hive-flow init --batch-init projects --template cli-tool
```

#### Configuration Errors
```bash
# Validate first
hive-flow batch validate-config my-batch.json

# Use force if needed
hive-flow init --config my-batch.json --force
```

### Debug Mode
```bash
# Verbose output for debugging
hive-flow init --batch-init projects --verbose

# Sequential mode for easier debugging
hive-flow init --batch-init projects --no-parallel
```

## Best Practices

### 1. Start Small
```bash
# Test with a few projects first
hive-flow init --batch-init test1,test2 --template web-api
```

### 2. Use Configuration Files
```bash
# Better for complex setups
hive-flow batch create-config enterprise-setup.json
# Edit the file, then:
hive-flow init --config enterprise-setup.json
```

### 3. Validate Before Running
```bash
# Always validate configurations
hive-flow batch validate-config my-batch.json

# Estimate resources
hive-flow batch estimate my-batch.json
```

### 4. Monitor Performance
```bash
# Use performance monitoring
hive-flow init --config my-batch.json --verbose

# Adjust concurrency based on system
hive-flow init --config my-batch.json --max-concurrent 4
```

### 5. Environment Consistency
```bash
# Use same template across environments
hive-flow init --batch-init myapp --environments dev,staging,prod --template microservice
```

## Advanced Examples

### Custom Resource Limits
```bash
# Configure resource limits in batch config
{
  "baseOptions": {
    "maxConcurrency": 3,
    "performanceMonitoring": true,
    "resourceLimits": {
      "maxMemoryMB": 2048,
      "maxCPUPercent": 80
    }
  }
}
```

### Conditional Project Creation
```bash
# Use project-specific configurations
{
  "projectConfigs": {
    "high-performance-api": {
      "template": "microservice",
      "environment": "prod",
      "customConfig": {
        "optimization": "aggressive",
        "caching": "redis",
        "monitoring": "detailed"
      }
    }
  }
}
```

### Integration with CI/CD
```bash
# CI/CD pipeline integration
name: Batch Project Setup
on: workflow_dispatch
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup projects
        run: |
          npx hive-flow@latest init --config .github/batch-config.json
```

## Next Steps

1. **Try the Examples**: Run the provided configuration files
2. **Create Custom Configs**: Use `hive-flow batch create-config --interactive`
3. **Scale Gradually**: Start small and increase complexity
4. **Monitor Performance**: Use built-in monitoring features
5. **Integrate with SPARC**: Enable SPARC for advanced development workflows

For more information, see the [Batch Initialization Documentation](../docs/batch-initialization.md).