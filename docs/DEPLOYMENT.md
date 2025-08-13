# 🚀 Claude-Flow Production Deployment Guide

## Table of Contents

- [Quick Start](#quick-start)
- [System Requirements](#system-requirements)
- [Environment Variables](#environment-variables)
- [Docker Deployment](#docker-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)
- [CI/CD Pipeline](#cicd-pipeline)
- [Monitoring & Observability](#monitoring--observability)
- [Security Configuration](#security-configuration)
- [Load Balancing](#load-balancing)
- [Production Setup](#production-setup)
- [Cloud Deployment](#cloud-deployment)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

### Production Installation

```bash
# Install from npm registry
npm install -g claude-flow@alpha

# Verify installation
npx claude-flow@alpha --version

# Initialize configuration
npx claude-flow@alpha init --force

# Test installation
npx claude-flow@alpha swarm "test deployment" --agents 3
```

### Prerequisites Check

```bash
# Check Node.js version (requires ≥20.0.0)
node --version

# Check npm version (requires ≥9.0.0)
npm --version

# Check system resources
free -h  # Memory check
df -h    # Disk space check

# Install required tools
apt-get update && apt-get install -y curl wget jq
```

---

## System Requirements

### Production Requirements

| Component | Minimum | Recommended | Enterprise |
|-----------|---------|-------------|------------|
| Node.js | v20.0.0 | v20 LTS | v20 LTS |
| RAM | 4 GB | 8 GB | 16 GB |
| CPU | 2 cores | 4 cores | 8+ cores |
| Disk Space | 2 GB | 10 GB | 50 GB |
| Network | 100 Mbps | 1 Gbps | 10 Gbps |
| Uptime SLA | 99% | 99.9% | 99.99% |

### Operating System Support

- **Linux**: Ubuntu 20.04+, CentOS 8+, RHEL 8+, Amazon Linux 2
- **Docker**: Alpine 3.18+, Ubuntu 22.04+
- **Kubernetes**: 1.24+
- **Cloud**: AWS, GCP, Azure, DigitalOcean

### Network Requirements

```bash
# Required ports
3000/tcp   # Main API server
8080/tcp   # MCP server
5432/tcp   # PostgreSQL (if used)
6379/tcp   # Redis (if used)
9090/tcp   # Prometheus metrics
3001/tcp   # Grafana dashboard

# Outbound connections
https://api.anthropic.com    # Claude API
https://api.openai.com       # OpenAI API (optional)
https://registry.npmjs.org   # Package registry
https://github.com           # Repository access
```

### Minimum Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Node.js | v20.0.0 | v20 LTS |
| npm | v9.0.0 | Latest |
| RAM | 2 GB | 8 GB |
| CPU | 2 cores | 4+ cores |
| Disk Space | 500 MB | 2 GB |
| OS | Windows 10, macOS 10.15, Ubuntu 20.04 | Latest stable |

### Operating System Specific

#### Windows

```powershell
# Install Node.js via Chocolatey
choco install nodejs

# Or via Scoop
scoop install nodejs

# Install build tools (for native dependencies)
npm install -g windows-build-tools

# Special consideration for SQLite
npm install -g better-sqlite3 --build-from-source
```

#### macOS

```bash
# Install via Homebrew
brew install node

# Install Xcode Command Line Tools
xcode-select --install

# Fix potential permissions
sudo npm install -g claude-flow@alpha --unsafe-perm
```

#### Linux (Ubuntu/Debian)

```bash
# Install Node.js via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install build essentials
sudo apt-get install -y build-essential

# Install SQLite dependencies
sudo apt-get install -y libsqlite3-dev
```

---

## Configuration

### Initial Setup

```bash
# Interactive setup wizard
claude-flow init

# Force setup (non-interactive)
claude-flow init --force

# Custom configuration directory
claude-flow init --config-dir ./my-config
```

### Configuration File Structure

```json
// .claude-flow/config.json
{
  "version": "2.0.0",
  "orchestrator": {
    "maxConcurrentAgents": 100,
    "taskQueueSize": 1000,
    "defaultTopology": "mesh",
    "healthCheckInterval": 30000
  },
  "memory": {
    "backend": "sqlite",
    "dbPath": ".swarm/memory.db",
    "cacheSizeMB": 256,
    "compressionEnabled": true,
    "ttlSeconds": 86400
  },
  "providers": {
    "anthropic": {
      "apiKey": "${CLAUDE_API_KEY}",
      "model": "claude-3-sonnet-20240229",
      "temperature": 0.7,
      "maxTokens": 4000
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "model": "gpt-4-turbo",
      "temperature": 0.7
    }
  },
  "api": {
    "enabled": true,
    "port": 3000,
    "host": "0.0.0.0",
    "cors": {
      "enabled": true,
      "origins": ["http://localhost:*"]
    }
  },
  "logging": {
    "level": "info",
    "file": "claude-flow.log",
    "maxSize": "10m",
    "maxFiles": 5
  },
  "hooks": {
    "enabled": true,
    "preTask": true,
    "postTask": true,
    "sessionRestore": true
  },
  "swarm": {
    "defaultAgents": 5,
    "maxAgents": 50,
    "autoScale": true,
    "topology": "mesh"
  }
}
```

### MCP Server Configuration

```json
// .claude-flow/mcp-config.json
{
  "mcpServers": {
    "claude-flow": {
      "command": "npx",
      "args": ["claude-flow@alpha", "mcp", "start"],
      "env": {
        "CLAUDE_FLOW_MCP_MODE": "server"
      }
    }
  },
  "globalShortcut": "cmd+shift+f"
}
```

---

## Environment Setup

### Environment Variables

```bash
# Create .env file
cat > .env << EOF
# API Keys
CLAUDE_API_KEY=your_claude_api_key
OPENAI_API_KEY=your_openai_api_key
GOOGLE_API_KEY=your_google_api_key

# Claude Flow Configuration
CLAUDE_FLOW_DEBUG=false
CLAUDE_FLOW_LOG_LEVEL=info
CLAUDE_FLOW_DATA_DIR=./.claude-flow
CLAUDE_FLOW_MEMORY_DIR=./.swarm
CLAUDE_FLOW_PORT=3000

# Performance Settings
CLAUDE_FLOW_MAX_AGENTS=50
CLAUDE_FLOW_MAX_CONCURRENT_TASKS=10
CLAUDE_FLOW_MEMORY_LIMIT=512
CLAUDE_FLOW_CACHE_SIZE=256

# Feature Flags
CLAUDE_FLOW_ENABLE_HOOKS=true
CLAUDE_FLOW_ENABLE_MCP=true
CLAUDE_FLOW_ENABLE_SWARM=true
CLAUDE_FLOW_ENABLE_NEURAL=true

# Provider Settings
CLAUDE_FLOW_DEFAULT_PROVIDER=anthropic
CLAUDE_FLOW_DEFAULT_MODEL=claude-3-sonnet
CLAUDE_FLOW_TEMPERATURE=0.7
CLAUDE_FLOW_MAX_TOKENS=4000

# Security
CLAUDE_FLOW_API_KEY=your_api_key_for_claude_flow
CLAUDE_FLOW_JWT_SECRET=your_jwt_secret
CLAUDE_FLOW_ENCRYPTION_KEY=your_encryption_key
EOF

# Load environment variables
source .env
# Or on Windows
set -a; source .env; set +a
```

### Shell Configuration

#### Bash/Zsh

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$PATH:$(npm config get prefix)/bin"
alias cf="claude-flow"
alias cfs="claude-flow swarm"
alias cfh="claude-flow hive-mind"
alias cfsparc="claude-flow sparc"

# Claude Flow shortcuts
cf-init() {
  claude-flow init --force
}

cf-swarm() {
  claude-flow swarm "$@" --agents 5
}

cf-hive() {
  claude-flow hive-mind spawn "$@" --claude
}
```

#### PowerShell

```powershell
# Add to $PROFILE
$env:PATH += ";$(npm config get prefix)"
Set-Alias cf claude-flow
Set-Alias cfs "claude-flow swarm"
Set-Alias cfh "claude-flow hive-mind"

function cf-init {
  claude-flow init --force
}

function cf-swarm {
  claude-flow swarm $args --agents 5
}

function cf-hive {
  claude-flow hive-mind spawn $args --claude
}
```

---

## Docker Deployment

### Dockerfile

```dockerfile
# Multi-stage build for optimal size
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ sqlite-dev

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build application
RUN npm run build

# Production stage
FROM node:20-alpine

# Install runtime dependencies
RUN apk add --no-cache sqlite

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Create data directories
RUN mkdir -p /data/.claude-flow /data/.swarm /data/memory

# Set environment variables
ENV NODE_ENV=production \
    CLAUDE_FLOW_DATA_DIR=/data/.claude-flow \
    CLAUDE_FLOW_MEMORY_DIR=/data/.swarm \
    PORT=3000

# Expose ports
EXPOSE 3000 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Run as non-root user
USER node

# Start application
CMD ["node", "dist/cli/main.js", "server"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  claude-flow:
    build: .
    image: claude-flow:latest
    container_name: claude-flow
    restart: unless-stopped
    ports:
      - "3000:3000"
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - CLAUDE_API_KEY=${CLAUDE_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - CLAUDE_FLOW_LOG_LEVEL=info
    volumes:
      - ./data:/data
      - ./config:/app/config
      - ./logs:/app/logs
    networks:
      - claude-flow-network
    depends_on:
      - redis
      - postgres

  redis:
    image: redis:7-alpine
    container_name: claude-flow-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - claude-flow-network

  postgres:
    image: postgres:15-alpine
    container_name: claude-flow-postgres
    restart: unless-stopped
    environment:
      - POSTGRES_DB=claude_flow
      - POSTGRES_USER=claude_flow
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      - claude-flow-network

  nginx:
    image: nginx:alpine
    container_name: claude-flow-nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - claude-flow
    networks:
      - claude-flow-network

volumes:
  redis-data:
  postgres-data:

networks:
  claude-flow-network:
    driver: bridge
```

### Building and Running

```bash
# Build Docker image
docker build -t claude-flow:latest .

# Run with Docker
docker run -d \
  --name claude-flow \
  -p 3000:3000 \
  -e CLAUDE_API_KEY=$CLAUDE_API_KEY \
  -v $(pwd)/data:/data \
  claude-flow:latest

# Run with Docker Compose
docker-compose up -d

# View logs
docker logs -f claude-flow

# Stop container
docker stop claude-flow

# Remove container
docker rm claude-flow
```

---

## Kubernetes Deployment

### Deployment Manifest

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: claude-flow
  namespace: default
  labels:
    app: claude-flow
    version: v2.0.0
spec:
  replicas: 3
  selector:
    matchLabels:
      app: claude-flow
  template:
    metadata:
      labels:
        app: claude-flow
    spec:
      containers:
      - name: claude-flow
        image: claudeflow/claude-flow:alpha
        ports:
        - containerPort: 3000
          name: api
        - containerPort: 8080
          name: mcp
        env:
        - name: NODE_ENV
          value: "production"
        - name: CLAUDE_API_KEY
          valueFrom:
            secretKeyRef:
              name: claude-flow-secrets
              key: claude-api-key
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: claude-flow-secrets
              key: database-url
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
        volumeMounts:
        - name: config
          mountPath: /app/config
        - name: data
          mountPath: /data
      volumes:
      - name: config
        configMap:
          name: claude-flow-config
      - name: data
        persistentVolumeClaim:
          claimName: claude-flow-pvc
```

### Service Manifest

```yaml
apiVersion: v1
kind: Service
metadata:
  name: claude-flow-service
  namespace: default
spec:
  type: LoadBalancer
  selector:
    app: claude-flow
  ports:
  - port: 80
    targetPort: 3000
    protocol: TCP
    name: http
  - port: 8080
    targetPort: 8080
    protocol: TCP
    name: mcp
```

### ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: claude-flow-config
  namespace: default
data:
  config.json: |
    {
      "orchestrator": {
        "maxConcurrentAgents": 100,
        "taskQueueSize": 1000
      },
      "memory": {
        "backend": "postgres",
        "cacheSizeMB": 512
      }
    }
```

### Secrets

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: claude-flow-secrets
  namespace: default
type: Opaque
data:
  claude-api-key: <base64-encoded-api-key>
  database-url: <base64-encoded-database-url>
  jwt-secret: <base64-encoded-jwt-secret>
```

### Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: claude-flow-hpa
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: claude-flow
  minReplicas: 3
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### Deployment Commands

```bash
# Create namespace
kubectl create namespace claude-flow

# Apply configurations
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secrets.yaml
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/hpa.yaml

# Check deployment status
kubectl get pods -n claude-flow
kubectl get svc -n claude-flow

# View logs
kubectl logs -f deployment/claude-flow -n claude-flow

# Scale deployment
kubectl scale deployment/claude-flow --replicas=5 -n claude-flow

# Update deployment
kubectl set image deployment/claude-flow claude-flow=claudeflow/claude-flow:v2.0.1 -n claude-flow

# Delete deployment
kubectl delete namespace claude-flow
```

---

## Cloud Deployment

### AWS Deployment

#### Using AWS ECS

```bash
# Create task definition
aws ecs register-task-definition \
  --family claude-flow \
  --requires-compatibilities FARGATE \
  --network-mode awsvpc \
  --cpu 1024 \
  --memory 2048 \
  --container-definitions file://task-definition.json

# Create service
aws ecs create-service \
  --cluster default \
  --service-name claude-flow \
  --task-definition claude-flow:1 \
  --desired-count 3 \
  --launch-type FARGATE \
  --network-configuration file://network-config.json
```

#### Using AWS Lambda

```javascript
// handler.js
const { ClaudeFlow } = require('claude-flow');

exports.handler = async (event) => {
  const claudeFlow = new ClaudeFlow({
    apiKey: process.env.CLAUDE_API_KEY
  });
  
  const result = await claudeFlow.execute(event.task);
  
  return {
    statusCode: 200,
    body: JSON.stringify(result)
  };
};
```

### Google Cloud Platform

```bash
# Deploy to Cloud Run
gcloud run deploy claude-flow \
  --image gcr.io/project-id/claude-flow:latest \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars="CLAUDE_API_KEY=$CLAUDE_API_KEY"

# Deploy to App Engine
gcloud app deploy app.yaml

# Deploy to GKE
gcloud container clusters create claude-flow-cluster \
  --num-nodes=3 \
  --zone=us-central1-a

kubectl apply -f k8s/
```

### Azure Deployment

```bash
# Deploy to Azure Container Instances
az container create \
  --resource-group claude-flow-rg \
  --name claude-flow \
  --image claudeflow/claude-flow:latest \
  --dns-name-label claude-flow \
  --ports 3000 \
  --environment-variables CLAUDE_API_KEY=$CLAUDE_API_KEY

# Deploy to Azure App Service
az webapp create \
  --resource-group claude-flow-rg \
  --plan claude-flow-plan \
  --name claude-flow \
  --deployment-container-image-name claudeflow/claude-flow:latest
```

### Heroku Deployment

```bash
# Create Heroku app
heroku create claude-flow

# Set environment variables
heroku config:set CLAUDE_API_KEY=$CLAUDE_API_KEY
heroku config:set NODE_ENV=production

# Deploy
git push heroku main

# Scale dynos
heroku ps:scale web=3

# View logs
heroku logs --tail
```

---

## Production Setup

### SSL/TLS Configuration

```nginx
# nginx.conf
server {
    listen 80;
    server_name claude-flow.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name claude-flow.example.com;
    
    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    location / {
        proxy_pass http://claude-flow:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Database Setup

#### PostgreSQL

```sql
-- Create database
CREATE DATABASE claude_flow;

-- Create user
CREATE USER claude_flow WITH ENCRYPTED PASSWORD 'secure_password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE claude_flow TO claude_flow;

-- Create tables
\c claude_flow;

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL,
  config JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(50) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL,
  priority INTEGER DEFAULT 0,
  assigned_agent UUID REFERENCES agents(id),
  result JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_agents_type ON agents(type);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_agent);
```

### Backup Strategy

```bash
#!/bin/bash
# backup.sh

# Configuration
BACKUP_DIR="/backups"
DATE=$(date +%Y%m%d_%H%M%S)
DB_NAME="claude_flow"

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup SQLite database
sqlite3 .swarm/memory.db ".backup '$BACKUP_DIR/memory_$DATE.db'"

# Backup PostgreSQL (if used)
pg_dump $DB_NAME > $BACKUP_DIR/postgres_$DATE.sql

# Backup configuration files
tar -czf $BACKUP_DIR/config_$DATE.tar.gz .claude-flow/

# Backup logs
tar -czf $BACKUP_DIR/logs_$DATE.tar.gz logs/

# Upload to S3
aws s3 cp $BACKUP_DIR/ s3://claude-flow-backups/ --recursive

# Clean old backups (keep last 30 days)
find $BACKUP_DIR -type f -mtime +30 -delete

echo "Backup completed: $DATE"
```

### Monitoring Script

```bash
#!/bin/bash
# monitor.sh

# Check service health
health_check() {
  response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health)
  if [ $response -eq 200 ]; then
    echo "✅ Service is healthy"
  else
    echo "❌ Service is unhealthy (HTTP $response)"
    # Send alert
    send_alert "Claude Flow service is down"
  fi
}

# Check memory usage
check_memory() {
  memory=$(free -m | awk 'NR==2{printf "%.2f%%", $3*100/$2}')
  echo "📊 Memory usage: $memory"
  
  if [ ${memory%.*} -gt 90 ]; then
    send_alert "High memory usage: $memory"
  fi
}

# Check disk usage
check_disk() {
  disk=$(df -h / | awk 'NR==2{print $5}')
  echo "💾 Disk usage: $disk"
  
  if [ ${disk%?} -gt 90 ]; then
    send_alert "High disk usage: $disk"
  fi
}

# Send alert function
send_alert() {
  message=$1
  # Send to Slack
  curl -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"Alert: $message\"}" \
    $SLACK_WEBHOOK_URL
}

# Run checks
while true; do
  clear
  echo "Claude Flow Monitoring - $(date)"
  echo "================================"
  health_check
  check_memory
  check_disk
  sleep 60
done
```

---

## Monitoring & Maintenance

### Health Checks

```javascript
// health-check.js
const healthCheck = {
  service: async () => {
    try {
      const response = await fetch('http://localhost:3000/health');
      return response.ok;
    } catch (error) {
      return false;
    }
  },
  
  database: async () => {
    try {
      const db = new Database('.swarm/memory.db');
      const result = db.prepare('SELECT 1').get();
      return result !== undefined;
    } catch (error) {
      return false;
    }
  },
  
  memory: () => {
    const used = process.memoryUsage();
    const limit = 2 * 1024 * 1024 * 1024; // 2GB
    return used.heapUsed < limit;
  }
};

// Run health checks
setInterval(async () => {
  const results = {
    service: await healthCheck.service(),
    database: await healthCheck.database(),
    memory: healthCheck.memory()
  };
  
  console.log('Health Check Results:', results);
  
  if (!Object.values(results).every(v => v)) {
    console.error('Health check failed!');
    // Send alert
  }
}, 60000); // Every minute
```

### Log Rotation

```bash
# /etc/logrotate.d/claude-flow
/var/log/claude-flow/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 node node
    sharedscripts
    postrotate
        /usr/bin/killall -SIGUSR1 node
    endscript
}
```

### Performance Tuning

```bash
# System limits configuration
# /etc/security/limits.conf
node soft nofile 65536
node hard nofile 65536
node soft nproc 32768
node hard nproc 32768

# Sysctl optimization
# /etc/sysctl.conf
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 30
```

---

## Troubleshooting

### Common Issues

#### Issue: Installation Fails

```bash
# Clear npm cache
npm cache clean --force

# Remove node_modules
rm -rf node_modules package-lock.json

# Reinstall
npm install

# Use different registry
npm install --registry https://registry.npmjs.org/
```

#### Issue: SQLite Errors

```bash
# Rebuild SQLite
npm rebuild better-sqlite3

# Install from source
npm install better-sqlite3 --build-from-source

# Use in-memory fallback
export CLAUDE_FLOW_MEMORY_BACKEND=memory
```

#### Issue: Permission Denied

```bash
# Fix npm permissions
sudo chown -R $(whoami) $(npm config get prefix)

# Fix data directory permissions
chmod -R 755 .claude-flow .swarm

# Run with elevated permissions (not recommended)
sudo npm install -g claude-flow@alpha --unsafe-perm
```

#### Issue: API Key Not Working

```bash
# Verify API key
curl -H "Authorization: Bearer $CLAUDE_API_KEY" \
  https://api.anthropic.com/v1/models

# Check environment variable
echo $CLAUDE_API_KEY

# Set directly in config
claude-flow config set providers.anthropic.apiKey "your-key"
```

#### Issue: Port Already in Use

```bash
# Find process using port
lsof -i :3000
# or
netstat -tulpn | grep 3000

# Kill process
kill -9 <PID>

# Use different port
CLAUDE_FLOW_PORT=3001 claude-flow server
```

### Debug Mode

```bash
# Enable debug logging
export CLAUDE_FLOW_DEBUG=true
export CLAUDE_FLOW_LOG_LEVEL=debug

# Run with verbose output
claude-flow --verbose swarm "test"

# Enable trace logging
NODE_DEBUG=* claude-flow swarm "test"

# Profile performance
node --prof dist/cli/main.js swarm "test"
node --prof-process isolate-*.log > profile.txt
```

### Recovery Procedures

#### Database Recovery

```bash
# Backup corrupted database
cp .swarm/memory.db .swarm/memory.db.backup

# Attempt repair
sqlite3 .swarm/memory.db "PRAGMA integrity_check"
sqlite3 .swarm/memory.db ".recover" | sqlite3 .swarm/memory_recovered.db

# Restore from backup
cp backups/memory_latest.db .swarm/memory.db
```

#### Session Recovery

```bash
# List available sessions
claude-flow hive-mind sessions

# Recover specific session
claude-flow hive-mind resume <session-id>

# Export session data
claude-flow hive-mind export <session-id> > session-backup.json

# Import session data
claude-flow hive-mind import < session-backup.json
```

---

## Support Resources

### Getting Help

```bash
# Built-in help
claude-flow --help
claude-flow <command> --help

# Interactive help
claude-flow help interactive

# Generate diagnostic report
claude-flow diagnostics --full > diagnostic-report.txt
```

### Community Support

- **Discord**: [Join our community](https://discord.gg/claude-flow)
- **GitHub Issues**: [Report bugs](https://github.com/ruvnet/claude-flow/issues)
- **Documentation**: [Online docs](https://docs.claude-flow.ai)
- **Stack Overflow**: Tag `claude-flow`

### Professional Support

For enterprise support, contact: support@claude-flow.ai

---

<div align="center">

**Claude-Flow Deployment Guide v2.0.0**

[Back to README](../README.md) | [Architecture](ARCHITECTURE.md) | [API Docs](API_DOCUMENTATION.md)

</div>