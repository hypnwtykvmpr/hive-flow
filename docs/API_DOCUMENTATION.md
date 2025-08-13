# 🔗 Claude-Flow API Documentation

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Base URL](#base-url)
- [Rate Limiting](#rate-limiting)
- [Error Handling](#error-handling)
- [Core Endpoints](#core-endpoints)
  - [Agent Management](#agent-management)
  - [Task Management](#task-management)
  - [Swarm Operations](#swarm-operations)
  - [Memory Management](#memory-management)
  - [System Management](#system-management)
- [WebSocket Events](#websocket-events)
- [MCP Protocol](#mcp-protocol)
- [Code Examples](#code-examples)

---

## Overview

The Claude-Flow API provides programmatic access to all orchestration capabilities, enabling integration with external systems and custom automation workflows.

### API Design Principles

- **RESTful Architecture** - Standard HTTP methods and status codes
- **JSON Format** - All requests and responses use JSON
- **Idempotent Operations** - Safe retry mechanisms
- **Pagination** - Efficient handling of large datasets
- **Real-time Updates** - WebSocket support for live data

## Authentication

### API Key Authentication

```http
Authorization: Bearer YOUR_API_KEY
```

### JWT Token Authentication

```javascript
// Request token
POST /api/auth/token
{
  "username": "user@example.com",
  "password": "secure_password"
}

// Response
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_in": 3600,
  "refresh_token": "..."
}
```

### OAuth 2.0 Support

```http
GET /api/auth/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  redirect_uri=YOUR_REDIRECT_URI&
  response_type=code&
  scope=read write
```

## Base URL

```
Production: https://api.claude-flow.ai/v2
Staging:    https://staging-api.claude-flow.ai/v2
Local:      http://localhost:3000/api
```

## Rate Limiting

| Tier | Requests/Minute | Requests/Hour | Burst Limit |
|------|----------------|---------------|-------------|
| Free | 60 | 1,000 | 100 |
| Pro | 300 | 10,000 | 500 |
| Enterprise | Unlimited | Unlimited | Custom |

### Rate Limit Headers

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1640995200
```

## Error Handling

### Error Response Format

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested agent was not found",
    "details": {
      "agent_id": "agent-123",
      "timestamp": "2024-01-01T12:00:00Z"
    }
  },
  "request_id": "req-abc123"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No Content |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 429 | Rate Limited |
| 500 | Internal Server Error |
| 503 | Service Unavailable |

---

## Core Endpoints

## Agent Management

### List All Agents

```http
GET /api/agents
```

**Query Parameters:**

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| status | string | Filter by status (active, idle, terminated) | all |
| type | string | Filter by agent type | all |
| page | integer | Page number | 1 |
| limit | integer | Items per page | 50 |
| sort | string | Sort field (created_at, name, type) | created_at |
| order | string | Sort order (asc, desc) | desc |

**Response:**

```json
{
  "agents": [
    {
      "id": "agent-001",
      "name": "Coder-Alpha",
      "type": "coder",
      "status": "active",
      "capabilities": ["code_generation", "refactoring", "debugging"],
      "current_task": "task-123",
      "metrics": {
        "tasks_completed": 42,
        "success_rate": 0.95,
        "average_time": 120
      },
      "created_at": "2024-01-01T10:00:00Z",
      "updated_at": "2024-01-01T12:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 150,
    "pages": 3
  }
}
```

### Create New Agent

```http
POST /api/agents
```

**Request Body:**

```json
{
  "type": "coder",
  "name": "Coder-Beta",
  "capabilities": ["code_generation", "testing"],
  "config": {
    "model": "claude-3-sonnet",
    "temperature": 0.7,
    "max_tokens": 4000
  },
  "metadata": {
    "project": "api-v2",
    "team": "backend"
  }
}
```

**Response:**

```json
{
  "id": "agent-002",
  "name": "Coder-Beta",
  "type": "coder",
  "status": "initializing",
  "capabilities": ["code_generation", "testing"],
  "config": {
    "model": "claude-3-sonnet",
    "temperature": 0.7,
    "max_tokens": 4000
  },
  "created_at": "2024-01-01T13:00:00Z"
}
```

### Get Agent Details

```http
GET /api/agents/{agent_id}
```

**Response:**

```json
{
  "id": "agent-001",
  "name": "Coder-Alpha",
  "type": "coder",
  "status": "active",
  "capabilities": ["code_generation", "refactoring", "debugging"],
  "current_task": {
    "id": "task-123",
    "description": "Implement user authentication",
    "progress": 0.75
  },
  "history": [
    {
      "task_id": "task-122",
      "completed_at": "2024-01-01T11:00:00Z",
      "duration": 300,
      "result": "success"
    }
  ],
  "metrics": {
    "tasks_completed": 42,
    "success_rate": 0.95,
    "average_time": 120,
    "resource_usage": {
      "cpu": 0.25,
      "memory": 512
    }
  },
  "config": {
    "model": "claude-3-sonnet",
    "temperature": 0.7
  },
  "created_at": "2024-01-01T10:00:00Z",
  "updated_at": "2024-01-01T12:00:00Z"
}
```

### Update Agent

```http
PUT /api/agents/{agent_id}
```

**Request Body:**

```json
{
  "name": "Coder-Alpha-Updated",
  "config": {
    "temperature": 0.8,
    "max_tokens": 5000
  },
  "metadata": {
    "priority": "high"
  }
}
```

### Terminate Agent

```http
DELETE /api/agents/{agent_id}
```

**Response:**

```json
{
  "message": "Agent terminated successfully",
  "agent_id": "agent-001",
  "final_status": "terminated",
  "terminated_at": "2024-01-01T14:00:00Z"
}
```

### Agent Health Check

```http
GET /api/agents/{agent_id}/health
```

**Response:**

```json
{
  "agent_id": "agent-001",
  "status": "healthy",
  "checks": {
    "memory": "ok",
    "cpu": "ok",
    "connectivity": "ok",
    "task_queue": "ok"
  },
  "metrics": {
    "uptime": 3600,
    "memory_usage": 256,
    "cpu_usage": 0.15,
    "queue_size": 3
  },
  "last_heartbeat": "2024-01-01T14:00:00Z"
}
```

---

## Task Management

### List Tasks

```http
GET /api/tasks
```

**Query Parameters:**

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| status | string | Filter by status (pending, running, completed, failed) | all |
| agent_id | string | Filter by assigned agent | all |
| priority | string | Filter by priority (low, medium, high, critical) | all |
| page | integer | Page number | 1 |
| limit | integer | Items per page | 50 |

**Response:**

```json
{
  "tasks": [
    {
      "id": "task-123",
      "type": "code_generation",
      "description": "Implement user authentication",
      "status": "running",
      "priority": "high",
      "assigned_agent": "agent-001",
      "progress": 0.75,
      "created_at": "2024-01-01T10:00:00Z",
      "started_at": "2024-01-01T10:05:00Z",
      "estimated_completion": "2024-01-01T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 200,
    "pages": 4
  }
}
```

### Create Task

```http
POST /api/tasks
```

**Request Body:**

```json
{
  "type": "code_generation",
  "description": "Create REST API endpoints for user management",
  "priority": "high",
  "requirements": {
    "language": "typescript",
    "framework": "express",
    "features": ["CRUD operations", "validation", "authentication"]
  },
  "constraints": {
    "deadline": "2024-01-02T00:00:00Z",
    "max_agents": 3,
    "budget": 100
  },
  "metadata": {
    "project": "api-v2",
    "sprint": "2024-Q1-S1"
  }
}
```

**Response:**

```json
{
  "id": "task-124",
  "type": "code_generation",
  "description": "Create REST API endpoints for user management",
  "status": "pending",
  "priority": "high",
  "created_at": "2024-01-01T14:00:00Z",
  "estimated_duration": 1800,
  "assigned_agents": []
}
```

### Get Task Details

```http
GET /api/tasks/{task_id}
```

**Response:**

```json
{
  "id": "task-123",
  "type": "code_generation",
  "description": "Implement user authentication",
  "status": "completed",
  "priority": "high",
  "assigned_agent": "agent-001",
  "progress": 1.0,
  "result": {
    "success": true,
    "output": {
      "files_created": ["auth.controller.ts", "auth.service.ts"],
      "lines_of_code": 450,
      "tests_created": 12
    },
    "artifacts": [
      {
        "type": "code",
        "path": "/src/auth/auth.controller.ts",
        "size": 2048
      }
    ]
  },
  "timeline": {
    "created_at": "2024-01-01T10:00:00Z",
    "queued_at": "2024-01-01T10:01:00Z",
    "started_at": "2024-01-01T10:05:00Z",
    "completed_at": "2024-01-01T10:25:00Z"
  },
  "metrics": {
    "duration": 1200,
    "cpu_time": 300,
    "memory_peak": 512,
    "api_calls": 5
  }
}
```

### Update Task

```http
PUT /api/tasks/{task_id}
```

**Request Body:**

```json
{
  "priority": "critical",
  "deadline": "2024-01-01T18:00:00Z",
  "metadata": {
    "escalated": true,
    "reason": "customer request"
  }
}
```

### Cancel Task

```http
DELETE /api/tasks/{task_id}
```

**Response:**

```json
{
  "message": "Task cancelled successfully",
  "task_id": "task-123",
  "status": "cancelled",
  "cancelled_at": "2024-01-01T15:00:00Z",
  "rollback_performed": true
}
```

### Assign Task to Agent

```http
POST /api/tasks/{task_id}/assign
```

**Request Body:**

```json
{
  "agent_id": "agent-002",
  "priority_override": "critical",
  "start_immediately": true
}
```

---

## Swarm Operations

### List Swarms

```http
GET /api/swarms
```

**Response:**

```json
{
  "swarms": [
    {
      "id": "swarm-001",
      "name": "API Development Swarm",
      "topology": "hierarchical",
      "status": "active",
      "objective": "Build complete REST API",
      "agents": [
        {
          "id": "agent-001",
          "role": "coordinator"
        },
        {
          "id": "agent-002",
          "role": "worker"
        }
      ],
      "progress": 0.65,
      "created_at": "2024-01-01T09:00:00Z"
    }
  ]
}
```

### Create Swarm

```http
POST /api/swarms
```

**Request Body:**

```json
{
  "name": "Microservices Development",
  "objective": "Build microservices architecture",
  "topology": "mesh",
  "config": {
    "max_agents": 10,
    "auto_scale": true,
    "fault_tolerance": "high",
    "communication_protocol": "async"
  },
  "initial_agents": [
    {
      "type": "architect",
      "count": 1
    },
    {
      "type": "backend-dev",
      "count": 3
    },
    {
      "type": "tester",
      "count": 2
    }
  ],
  "tasks": [
    "Design system architecture",
    "Implement user service",
    "Implement order service",
    "Create API gateway",
    "Setup monitoring"
  ]
}
```

### Get Swarm Status

```http
GET /api/swarms/{swarm_id}/status
```

**Response:**

```json
{
  "id": "swarm-001",
  "status": "active",
  "health": "healthy",
  "topology": "mesh",
  "agents": {
    "total": 6,
    "active": 5,
    "idle": 1,
    "failed": 0
  },
  "tasks": {
    "total": 10,
    "completed": 6,
    "in_progress": 3,
    "pending": 1
  },
  "progress": 0.65,
  "performance": {
    "throughput": 12.5,
    "efficiency": 0.89,
    "coordination_overhead": 0.12
  },
  "resource_usage": {
    "cpu": 2.5,
    "memory": 2048,
    "network": 150
  },
  "last_update": "2024-01-01T15:00:00Z"
}
```

### Control Swarm

```http
POST /api/swarms/{swarm_id}/control
```

**Request Body:**

```json
{
  "action": "scale",
  "parameters": {
    "agent_type": "backend-dev",
    "count": 2,
    "operation": "add"
  }
}
```

**Available Actions:**

- `pause` - Pause swarm execution
- `resume` - Resume swarm execution
- `scale` - Scale agents up or down
- `optimize` - Optimize swarm topology
- `rebalance` - Rebalance task distribution

### Swarm Communication

```http
POST /api/swarms/{swarm_id}/broadcast
```

**Request Body:**

```json
{
  "message": {
    "type": "directive",
    "content": "Switch to high-priority mode",
    "target": "all",
    "priority": "high"
  }
}
```

---

## Memory Management

### Store Memory

```http
POST /api/memory
```

**Request Body:**

```json
{
  "key": "project_context",
  "value": {
    "description": "E-commerce platform",
    "tech_stack": ["Node.js", "React", "PostgreSQL"],
    "requirements": ["scalability", "security", "performance"]
  },
  "namespace": "project-alpha",
  "ttl": 86400,
  "tags": ["context", "requirements"],
  "access_level": "shared"
}
```

### Retrieve Memory

```http
GET /api/memory/{key}
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| namespace | string | Memory namespace |
| version | integer | Specific version |

**Response:**

```json
{
  "key": "project_context",
  "value": {
    "description": "E-commerce platform",
    "tech_stack": ["Node.js", "React", "PostgreSQL"],
    "requirements": ["scalability", "security", "performance"]
  },
  "namespace": "project-alpha",
  "version": 3,
  "created_at": "2024-01-01T10:00:00Z",
  "updated_at": "2024-01-01T14:00:00Z",
  "accessed_count": 15,
  "tags": ["context", "requirements"]
}
```

### Query Memory

```http
GET /api/memory/query
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| pattern | string | Search pattern |
| namespace | string | Filter by namespace |
| tags | array | Filter by tags |
| limit | integer | Max results |

**Response:**

```json
{
  "results": [
    {
      "key": "api_design",
      "namespace": "project-alpha",
      "relevance": 0.95,
      "snippet": "RESTful API design patterns...",
      "tags": ["api", "design"]
    }
  ],
  "total": 25,
  "query_time": 15
}
```

### Update Memory

```http
PUT /api/memory/{key}
```

**Request Body:**

```json
{
  "value": {
    "description": "Updated e-commerce platform",
    "tech_stack": ["Node.js", "React", "PostgreSQL", "Redis"],
    "requirements": ["scalability", "security", "performance", "caching"]
  },
  "merge": true,
  "create_version": true
}
```

### Delete Memory

```http
DELETE /api/memory/{key}
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| namespace | string | Memory namespace |
| cascade | boolean | Delete related entries |

### Memory Statistics

```http
GET /api/memory/stats
```

**Response:**

```json
{
  "total_entries": 1250,
  "namespaces": 15,
  "size_bytes": 5242880,
  "cache_hits": 8500,
  "cache_misses": 1500,
  "hit_rate": 0.85,
  "top_namespaces": [
    {
      "name": "project-alpha",
      "entries": 350,
      "size": 1048576
    }
  ],
  "memory_usage": {
    "used": 5242880,
    "limit": 268435456,
    "percentage": 0.02
  }
}
```

---

## System Management

### System Status

```http
GET /api/system/status
```

**Response:**

```json
{
  "status": "operational",
  "version": "2.0.0-alpha.88",
  "uptime": 86400,
  "components": {
    "orchestrator": "healthy",
    "memory": "healthy",
    "mcp_server": "healthy",
    "database": "healthy",
    "cache": "healthy"
  },
  "metrics": {
    "agents_active": 25,
    "tasks_queued": 45,
    "memory_usage": 0.45,
    "cpu_usage": 0.65
  },
  "cluster": {
    "nodes": 3,
    "leader": "node-1",
    "sync_status": "synchronized"
  }
}
```

### Health Check

```http
GET /api/health
```

**Response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T15:00:00Z",
  "checks": [
    {
      "name": "database",
      "status": "pass",
      "response_time": 5
    },
    {
      "name": "memory",
      "status": "pass",
      "response_time": 2
    },
    {
      "name": "orchestrator",
      "status": "pass",
      "response_time": 8
    }
  ]
}
```

### System Configuration

```http
GET /api/system/config
```

**Response:**

```json
{
  "orchestrator": {
    "max_agents": 100,
    "task_queue_size": 1000,
    "default_topology": "mesh"
  },
  "memory": {
    "backend": "sqlite",
    "cache_size_mb": 256,
    "compression": true
  },
  "security": {
    "auth_enabled": true,
    "rate_limiting": true,
    "encryption": "AES-256"
  },
  "features": {
    "swarm_intelligence": true,
    "neural_patterns": true,
    "mcp_integration": true
  }
}
```

### Performance Metrics

```http
GET /api/system/metrics
```

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| period | string | Time period (1h, 24h, 7d, 30d) |
| resolution | string | Data resolution (1m, 5m, 1h) |

**Response:**

```json
{
  "period": "24h",
  "resolution": "1h",
  "metrics": {
    "throughput": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "value": 125.5
      }
    ],
    "latency": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "p50": 45,
        "p95": 125,
        "p99": 250
      }
    ],
    "error_rate": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "value": 0.002
      }
    ],
    "resource_usage": [
      {
        "timestamp": "2024-01-01T00:00:00Z",
        "cpu": 0.65,
        "memory": 0.45,
        "disk": 0.30
      }
    ]
  }
}
```

### Generate Diagnostic Report

```http
POST /api/system/diagnostics
```

**Request Body:**

```json
{
  "include": ["logs", "metrics", "config", "memory_dump"],
  "time_range": {
    "start": "2024-01-01T00:00:00Z",
    "end": "2024-01-01T23:59:59Z"
  },
  "format": "json",
  "compress": true
}
```

**Response:**

```json
{
  "report_id": "diag-20240101-150000",
  "status": "generating",
  "estimated_time": 30,
  "download_url": "/api/system/diagnostics/diag-20240101-150000/download"
}
```

---

## WebSocket Events

### Connection

```javascript
const ws = new WebSocket('wss://api.claude-flow.ai/v2/ws');

ws.on('open', () => {
  // Authenticate
  ws.send(JSON.stringify({
    type: 'auth',
    token: 'YOUR_API_TOKEN'
  }));
  
  // Subscribe to events
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['agents', 'tasks', 'swarms']
  }));
});
```

### Event Types

#### Agent Events

```javascript
// Agent status change
{
  "type": "agent.status",
  "data": {
    "agent_id": "agent-001",
    "status": "active",
    "previous_status": "idle",
    "timestamp": "2024-01-01T15:00:00Z"
  }
}

// Agent task assignment
{
  "type": "agent.task_assigned",
  "data": {
    "agent_id": "agent-001",
    "task_id": "task-123",
    "timestamp": "2024-01-01T15:00:00Z"
  }
}

// Agent metrics update
{
  "type": "agent.metrics",
  "data": {
    "agent_id": "agent-001",
    "metrics": {
      "cpu": 0.45,
      "memory": 512,
      "tasks_completed": 43
    },
    "timestamp": "2024-01-01T15:00:00Z"
  }
}
```

#### Task Events

```javascript
// Task progress update
{
  "type": "task.progress",
  "data": {
    "task_id": "task-123",
    "progress": 0.75,
    "estimated_completion": "2024-01-01T15:30:00Z",
    "timestamp": "2024-01-01T15:00:00Z"
  }
}

// Task completed
{
  "type": "task.completed",
  "data": {
    "task_id": "task-123",
    "result": "success",
    "duration": 1200,
    "timestamp": "2024-01-01T15:20:00Z"
  }
}

// Task failed
{
  "type": "task.failed",
  "data": {
    "task_id": "task-123",
    "error": "Timeout exceeded",
    "retry_count": 2,
    "timestamp": "2024-01-01T15:30:00Z"
  }
}
```

#### Swarm Events

```javascript
// Swarm topology change
{
  "type": "swarm.topology_changed",
  "data": {
    "swarm_id": "swarm-001",
    "topology": "mesh",
    "previous_topology": "hierarchical",
    "reason": "optimization",
    "timestamp": "2024-01-01T15:00:00Z"
  }
}

// Swarm agent joined
{
  "type": "swarm.agent_joined",
  "data": {
    "swarm_id": "swarm-001",
    "agent_id": "agent-003",
    "role": "worker",
    "timestamp": "2024-01-01T15:00:00Z"
  }
}

// Swarm progress update
{
  "type": "swarm.progress",
  "data": {
    "swarm_id": "swarm-001",
    "progress": 0.75,
    "tasks_completed": 15,
    "tasks_remaining": 5,
    "timestamp": "2024-01-01T15:00:00Z"
  }
}
```

### Sending Commands via WebSocket

```javascript
// Execute command
ws.send(JSON.stringify({
  "type": "command",
  "command": "agent.spawn",
  "parameters": {
    "type": "coder",
    "name": "Coder-Gamma"
  },
  "request_id": "req-123"
}));

// Response
{
  "type": "command_response",
  "request_id": "req-123",
  "status": "success",
  "data": {
    "agent_id": "agent-003",
    "status": "initializing"
  }
}
```

---

## MCP Protocol

### MCP Server Endpoints

```http
POST /mcp/v1/initialize
POST /mcp/v1/tools/list
POST /mcp/v1/tools/call
POST /mcp/v1/resources/list
POST /mcp/v1/resources/read
POST /mcp/v1/prompts/list
POST /mcp/v1/prompts/get
```

### Initialize MCP Session

```http
POST /mcp/v1/initialize
```

**Request:**

```json
{
  "protocolVersion": "2024.11.5",
  "capabilities": {
    "tools": true,
    "resources": true,
    "prompts": true
  },
  "clientInfo": {
    "name": "claude-code",
    "version": "1.0.0"
  }
}
```

**Response:**

```json
{
  "protocolVersion": "2024.11.5",
  "capabilities": {
    "tools": true,
    "resources": true,
    "prompts": true
  },
  "serverInfo": {
    "name": "claude-flow-mcp",
    "version": "2.0.0"
  }
}
```

### List Available Tools

```http
POST /mcp/v1/tools/list
```

**Response:**

```json
{
  "tools": [
    {
      "name": "swarm_init",
      "description": "Initialize a new swarm with specified topology",
      "inputSchema": {
        "type": "object",
        "properties": {
          "topology": {
            "type": "string",
            "enum": ["centralized", "distributed", "mesh", "hierarchical"]
          },
          "maxAgents": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          }
        },
        "required": ["topology"]
      }
    },
    {
      "name": "agent_spawn",
      "description": "Create a new agent",
      "inputSchema": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string"
          },
          "config": {
            "type": "object"
          }
        },
        "required": ["type"]
      }
    }
  ]
}
```

### Call MCP Tool

```http
POST /mcp/v1/tools/call
```

**Request:**

```json
{
  "name": "swarm_init",
  "arguments": {
    "topology": "mesh",
    "maxAgents": 10
  }
}
```

**Response:**

```json
{
  "content": [
    {
      "type": "text",
      "text": "Swarm initialized successfully with mesh topology"
    }
  ],
  "metadata": {
    "swarm_id": "swarm-002",
    "topology": "mesh",
    "max_agents": 10,
    "created_at": "2024-01-01T16:00:00Z"
  }
}
```

---

## Code Examples

### JavaScript/TypeScript

```typescript
import { ClaudeFlowClient } from 'claude-flow-sdk';

// Initialize client
const client = new ClaudeFlowClient({
  apiKey: process.env.CLAUDE_FLOW_API_KEY,
  baseUrl: 'https://api.claude-flow.ai/v2'
});

// Create and manage agents
async function manageAgents() {
  // Create a new agent
  const agent = await client.agents.create({
    type: 'coder',
    name: 'TypeScript Expert',
    capabilities: ['typescript', 'react', 'node']
  });

  // Get agent status
  const status = await client.agents.getStatus(agent.id);
  console.log(`Agent ${agent.name} is ${status.status}`);

  // Assign task to agent
  const task = await client.tasks.create({
    type: 'code_generation',
    description: 'Create user authentication module',
    priority: 'high'
  });

  await client.tasks.assign(task.id, agent.id);

  // Monitor progress
  const progress = await client.tasks.getProgress(task.id);
  console.log(`Task progress: ${progress.percentage}%`);
}

// Swarm operations
async function swarmOperations() {
  // Create a swarm
  const swarm = await client.swarms.create({
    name: 'API Development',
    topology: 'hierarchical',
    objective: 'Build REST API',
    agents: [
      { type: 'architect', count: 1 },
      { type: 'backend-dev', count: 3 },
      { type: 'tester', count: 2 }
    ]
  });

  // Monitor swarm
  const status = await client.swarms.getStatus(swarm.id);
  console.log(`Swarm progress: ${status.progress * 100}%`);

  // Scale swarm
  await client.swarms.scale(swarm.id, {
    agentType: 'backend-dev',
    count: 2,
    operation: 'add'
  });
}

// Real-time monitoring with WebSocket
function realTimeMonitoring() {
  const ws = client.websocket();

  ws.on('agent.status', (event) => {
    console.log(`Agent ${event.agent_id} changed to ${event.status}`);
  });

  ws.on('task.completed', (event) => {
    console.log(`Task ${event.task_id} completed`);
  });

  ws.subscribe(['agents', 'tasks', 'swarms']);
}

// Memory operations
async function memoryOperations() {
  // Store context
  await client.memory.store('project_context', {
    name: 'E-commerce Platform',
    stack: ['Node.js', 'React', 'PostgreSQL'],
    requirements: ['scalability', 'security']
  }, {
    namespace: 'project-alpha',
    ttl: 86400
  });

  // Query memory
  const results = await client.memory.query('authentication', {
    namespace: 'project-alpha',
    limit: 10
  });

  results.forEach(result => {
    console.log(`Found: ${result.key} (relevance: ${result.relevance})`);
  });
}
```

### Python

```python
from claude_flow import ClaudeFlowClient
import asyncio

# Initialize client
client = ClaudeFlowClient(
    api_key="YOUR_API_KEY",
    base_url="https://api.claude-flow.ai/v2"
)

async def main():
    # Create an agent
    agent = await client.agents.create(
        type="coder",
        name="Python Expert",
        capabilities=["python", "django", "fastapi"]
    )
    
    # Create and assign task
    task = await client.tasks.create(
        type="code_generation",
        description="Create data processing pipeline",
        priority="high"
    )
    
    await client.tasks.assign(task.id, agent.id)
    
    # Wait for completion
    while True:
        status = await client.tasks.get_status(task.id)
        if status.status in ["completed", "failed"]:
            break
        await asyncio.sleep(5)
    
    # Get results
    result = await client.tasks.get_result(task.id)
    print(f"Task completed: {result.success}")
    
    # Create a swarm for complex project
    swarm = await client.swarms.create(
        name="ML Pipeline Development",
        topology="mesh",
        agents=[
            {"type": "ml-developer", "count": 2},
            {"type": "data-engineer", "count": 2},
            {"type": "tester", "count": 1}
        ]
    )
    
    # Monitor swarm progress
    async for update in client.swarms.stream_progress(swarm.id):
        print(f"Progress: {update.progress * 100:.1f}%")
        if update.progress >= 1.0:
            break

# Run the async main function
asyncio.run(main())
```

### cURL Examples

```bash
# Create an agent
curl -X POST https://api.claude-flow.ai/v2/api/agents \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "coder",
    "name": "API Developer",
    "capabilities": ["rest-api", "graphql", "openapi"]
  }'

# Create a task
curl -X POST https://api.claude-flow.ai/v2/api/tasks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "code_generation",
    "description": "Create user management API",
    "priority": "high"
  }'

# Query memory
curl -G https://api.claude-flow.ai/v2/api/memory/query \
  -H "Authorization: Bearer YOUR_API_KEY" \
  --data-urlencode "pattern=authentication" \
  --data-urlencode "namespace=project-alpha" \
  --data-urlencode "limit=10"

# Get system status
curl https://api.claude-flow.ai/v2/api/system/status \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Go

```go
package main

import (
    "context"
    "fmt"
    "log"
    
    cf "github.com/claude-flow/go-sdk"
)

func main() {
    // Initialize client
    client := cf.NewClient(
        cf.WithAPIKey("YOUR_API_KEY"),
        cf.WithBaseURL("https://api.claude-flow.ai/v2"),
    )
    
    ctx := context.Background()
    
    // Create an agent
    agent, err := client.Agents.Create(ctx, &cf.CreateAgentRequest{
        Type:         "coder",
        Name:         "Go Expert",
        Capabilities: []string{"go", "grpc", "microservices"},
    })
    if err != nil {
        log.Fatal(err)
    }
    
    fmt.Printf("Created agent: %s\n", agent.ID)
    
    // Create a task
    task, err := client.Tasks.Create(ctx, &cf.CreateTaskRequest{
        Type:        "code_generation",
        Description: "Create gRPC service",
        Priority:    "high",
    })
    if err != nil {
        log.Fatal(err)
    }
    
    // Assign task to agent
    err = client.Tasks.Assign(ctx, task.ID, agent.ID)
    if err != nil {
        log.Fatal(err)
    }
    
    // Monitor task progress
    progress, err := client.Tasks.GetProgress(ctx, task.ID)
    if err != nil {
        log.Fatal(err)
    }
    
    fmt.Printf("Task progress: %.0f%%\n", progress.Percentage*100)
}
```

---

## API SDK Libraries

### Official SDKs

- **JavaScript/TypeScript**: `npm install claude-flow-sdk`
- **Python**: `pip install claude-flow`
- **Go**: `go get github.com/claude-flow/go-sdk`
- **Ruby**: `gem install claude-flow`
- **Java**: Maven/Gradle coordinates available

### Community SDKs

- **Rust**: `cargo add claude-flow`
- **PHP**: `composer require claude-flow/sdk`
- **C#/.NET**: NuGet package available
- **Swift**: Swift Package Manager support

---

## Rate Limiting & Quotas

### Default Limits

| Resource | Free Tier | Pro Tier | Enterprise |
|----------|-----------|----------|------------|
| API Requests/min | 60 | 300 | Unlimited |
| Agents | 5 | 50 | Unlimited |
| Tasks/hour | 100 | 1,000 | Unlimited |
| Memory Storage | 100 MB | 10 GB | Unlimited |
| WebSocket Connections | 1 | 10 | Unlimited |

### Rate Limit Headers

```http
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 45
X-RateLimit-Reset: 1640995200
X-RateLimit-Resource: api-requests
```

### Handling Rate Limits

```javascript
// Automatic retry with exponential backoff
const response = await client.request({
  maxRetries: 3,
  retryDelay: 1000,
  retryMultiplier: 2,
  onRateLimit: (retryAfter) => {
    console.log(`Rate limited. Retrying after ${retryAfter}ms`);
  }
});
```

---

## Best Practices

### 1. Efficient Pagination

```javascript
// Use cursor-based pagination for large datasets
let cursor = null;
const allAgents = [];

do {
  const response = await client.agents.list({
    limit: 100,
    cursor: cursor
  });
  
  allAgents.push(...response.agents);
  cursor = response.nextCursor;
} while (cursor);
```

### 2. Batch Operations

```javascript
// Batch multiple operations for efficiency
const batch = client.batch();

batch.add('createAgent1', client.agents.create, { type: 'coder' });
batch.add('createAgent2', client.agents.create, { type: 'tester' });
batch.add('createTask', client.tasks.create, { type: 'testing' });

const results = await batch.execute();
```

### 3. Error Handling

```javascript
try {
  const agent = await client.agents.create({ type: 'coder' });
} catch (error) {
  if (error.code === 'RATE_LIMITED') {
    // Wait and retry
    await sleep(error.retryAfter);
    return retry();
  } else if (error.code === 'INVALID_REQUEST') {
    // Handle validation error
    console.error('Validation failed:', error.details);
  } else {
    // Handle other errors
    throw error;
  }
}
```

### 4. WebSocket Reconnection

```javascript
class ResilientWebSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.reconnectAttempts = 0;
    this.connect();
  }
  
  connect() {
    this.ws = new WebSocket(this.url);
    
    this.ws.on('close', () => {
      // Exponential backoff reconnection
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      setTimeout(() => this.connect(), delay);
      this.reconnectAttempts++;
    });
    
    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      // Re-authenticate and resubscribe
      this.authenticate();
      this.resubscribe();
    });
  }
}
```

---

## Support & Resources

### Documentation

- [API Reference](https://docs.claude-flow.ai/api)
- [SDK Documentation](https://docs.claude-flow.ai/sdks)
- [Integration Guides](https://docs.claude-flow.ai/integrations)
- [Best Practices](https://docs.claude-flow.ai/best-practices)

### Support Channels

- **Email**: api-support@claude-flow.ai
- **Discord**: [Join our community](https://discord.gg/claude-flow)
- **GitHub Issues**: [Report bugs](https://github.com/ruvnet/claude-flow/issues)
- **Stack Overflow**: Tag `claude-flow`

### API Status

- **Status Page**: https://status.claude-flow.ai
- **Uptime**: 99.9% SLA for Enterprise
- **Maintenance Windows**: Announced 72 hours in advance

---

<div align="center">

**Claude-Flow API v2.0.0**

[Back to Top](#-claude-flow-api-documentation)

</div>