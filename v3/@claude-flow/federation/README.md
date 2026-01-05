# @claude-flow/federation

Federation and cross-swarm coordination module for Claude-Flow V3.

## Overview

This module enables federation between multiple Claude-Flow instances, allowing distributed swarm coordination across different environments.

## Features

- **Cross-Swarm Communication**: Connect swarms across instances
- **Agent Discovery**: Discover and connect to remote agents
- **Task Delegation**: Delegate tasks to federated swarms
- **State Synchronization**: Keep federated state consistent

## Installation

```bash
npm install @claude-flow/federation
```

## Usage

```typescript
import { FederationHub } from '@claude-flow/federation';

const hub = new FederationHub({
  instanceId: 'instance-1',
  discoveryEndpoint: 'https://discovery.example.com',
});

await hub.initialize();

// Register with federation
await hub.register({
  capabilities: ['code-generation', 'testing'],
  maxAgents: 10,
});

// Discover remote swarms
const remoteSwarms = await hub.discoverSwarms({
  capabilities: ['security-analysis'],
});

// Delegate task to remote swarm
const result = await hub.delegateTask(remoteSwarms[0].id, task);
```

## API Reference

### FederationHub

Main class for federation management.

#### Methods

- `initialize()` - Initialize federation hub
- `register(config)` - Register with federation network
- `discoverSwarms(query)` - Discover available swarms
- `delegateTask(swarmId, task)` - Delegate task to remote swarm
- `shutdown()` - Gracefully disconnect from federation

## Configuration

```typescript
interface FederationConfig {
  instanceId: string;
  discoveryEndpoint?: string;
  heartbeatInterval?: number;
  maxConnections?: number;
  tls?: TLSConfig;
}
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Local Swarm    │◄───►│ Federation Hub  │
└─────────────────┘     └────────┬────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
            ┌───────▼───────┐         ┌───────▼───────┐
            │ Remote Swarm 1│         │ Remote Swarm 2│
            └───────────────┘         └───────────────┘
```

## License

MIT
