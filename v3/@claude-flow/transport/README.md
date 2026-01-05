# @claude-flow/transport

Transport layer module for Claude-Flow V3.

## Overview

This module provides transport layer implementations for agent communication, including QUIC, WebSocket, and HTTP/2 protocols.

## Features

- **QUIC Transport**: High-performance UDP-based communication
- **WebSocket**: Real-time bidirectional communication
- **HTTP/2**: Multiplexed request/response patterns
- **Connection Pooling**: Efficient connection management
- **Load Balancing**: Distribute traffic across endpoints

## Installation

```bash
npm install @claude-flow/transport
```

## Usage

```typescript
import { QUICTransport, WebSocketTransport } from '@claude-flow/transport';

// QUIC Transport (recommended for high-throughput)
const quic = new QUICTransport({
  host: 'localhost',
  port: 4433,
  tls: {
    cert: './cert.pem',
    key: './key.pem',
  },
});

await quic.listen();

// WebSocket Transport
const ws = new WebSocketTransport({
  url: 'ws://localhost:8080',
  reconnect: true,
});

await ws.connect();

// Send message
await ws.send({
  type: 'task',
  payload: { /* ... */ },
});

// Receive messages
ws.on('message', (msg) => {
  console.log('Received:', msg);
});
```

## API Reference

### QUICTransport

High-performance QUIC-based transport.

#### Methods

- `listen()` - Start listening for connections
- `connect(endpoint)` - Connect to remote endpoint
- `send(message)` - Send message
- `close()` - Close transport

### WebSocketTransport

WebSocket-based transport for real-time communication.

#### Methods

- `connect()` - Establish WebSocket connection
- `send(message)` - Send message
- `on(event, handler)` - Register event handler
- `close()` - Close connection

## Configuration

```typescript
interface TransportConfig {
  protocol: 'quic' | 'websocket' | 'http2';
  host?: string;
  port?: number;
  tls?: TLSConfig;
  poolSize?: number;
  timeout?: number;
}
```

## Performance

| Protocol | Latency | Throughput | Use Case |
|----------|---------|------------|----------|
| QUIC | <5ms | High | Inter-agent messaging |
| WebSocket | <10ms | Medium | Real-time updates |
| HTTP/2 | <20ms | Medium | Request/response |

## License

MIT
