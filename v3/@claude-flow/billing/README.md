# @claude-flow/billing

Billing and metering module for Claude-Flow V3.

## Overview

This module provides billing, metering, and usage tracking capabilities for Claude-Flow agents and swarms.

## Features

- **Usage Metering**: Track API calls, tokens, and compute usage
- **Billing Integration**: Connect to payment providers
- **Cost Estimation**: Estimate costs before execution
- **Usage Reporting**: Generate usage reports and analytics

## Installation

```bash
npm install @claude-flow/billing
```

## Usage

```typescript
import { MeteringEngine } from '@claude-flow/billing';

const metering = new MeteringEngine({
  // configuration
});

// Track usage
await metering.trackUsage({
  agentId: 'agent-1',
  operation: 'task-execution',
  tokens: 1500,
  duration: 5000,
});

// Get usage report
const report = await metering.getUsageReport({
  startDate: new Date('2026-01-01'),
  endDate: new Date(),
});
```

## API Reference

### MeteringEngine

Main class for usage metering and billing.

#### Methods

- `trackUsage(usage: UsageRecord)` - Record usage event
- `getUsageReport(options)` - Generate usage report
- `estimateCost(task: Task)` - Estimate task cost

## Configuration

```typescript
interface BillingConfig {
  enabled: boolean;
  provider?: 'stripe' | 'custom';
  meteringInterval?: number;
  retentionDays?: number;
}
```

## License

MIT
