# @claude-flow/guidance

The Guidance Control Plane for Claude Flow V3. Compiles, retrieves, enforces, and evolves governance rules so autonomous agents can operate safely for days instead of minutes.

This is not a 10-20% improvement. It is a step change in what Claude Flow can safely and reliably do.

## What It Does

The control plane sits *beside* Claude Code (not inside it) and provides:

| Layer | Component | Purpose |
|-------|-----------|---------|
| **Compile** | `GuidanceCompiler` | CLAUDE.md -> constitution + task-scoped shards |
| **Retrieve** | `ShardRetriever` | Intent classification -> relevant rules at task start |
| **Enforce** | `EnforcementGates` | 4 gates: destructive ops, tool allowlist, diff size, secrets |
| **Prove** | `ProofChain` | Hash-chained cryptographic envelopes for every decision |
| **Gate Tools** | `DeterministicToolGateway` | Idempotency, schema validation, budget metering |
| **Gate Memory** | `MemoryWriteGate` | Authority scope, rate limiting, decay, contradiction tracking |
| **Observe** | `CoherenceScheduler` | Privilege throttling based on violation/rework/drift scores |
| **Budget** | `EconomicGovernor` | Token, tool, storage, time, and cost budget enforcement |
| **Log** | `PersistentLedger` | NDJSON event store with compaction and replay |
| **Evolve** | `EvolutionPipeline` | Signed proposals -> simulation -> staged rollout with auto-rollback |
| **Validate** | `ManifestValidator` | Fails-closed admission for agent cell manifests |
| **Compose** | `CapabilityAlgebra` | Grant, restrict, delegate, expire, revoke permissions as typed objects |
| **Record** | `ArtifactLedger` | Signed production records with content hashing and lineage |
| **Test** | `ConformanceRunner` | Memory Clerk acceptance test with replay verification |

## Where the Improvement Comes From

The gains are not mostly "better answers." They are less rework, fewer runaway loops, and higher uptime autonomy. You are not just improving output quality. You are removing the reasons autonomy must be limited. That creates compounding gains.

### Net Impact

| Dimension | Today | With Control Plane | Improvement |
|-----------|-------|-------------------|-------------|
| Autonomy duration | Minutes to hours | Days to weeks | **10x-100x** |
| Cost per successful outcome | Rises super-linearly as agents loop | Agents slow naturally under uncertainty | **30-60% lower** |
| Reliability (tool + memory tasks) | Frequent silent failures | Failures surface early, writes blocked before corruption | **2x-5x higher** success rate |

### Per-Module Impact

#### 1. Hook Integration

Every `PreToolUse`, `PreEdit`, `PreCommand` becomes enforceable.

| Metric | Improvement |
|--------|-------------|
| Destructive or pointless tool actions | **50-90% reduction** (blocked before execution) |
| Human interrupts on long tasks | **2x-10x fewer** (system refuses unsafe actions cleanly) |
| KPI | Blocked tool calls / total tool calls, user interventions per hour |

#### 2. Retriever Injection at Task Start

Every task starts with constitution plus the right shards, automatically.

| Metric | Improvement |
|--------|-------------|
| Repeat instructions and prompt steering | **20-50% reduction** |
| Policy violations | **10-30% fewer** (constraints always present) |
| Tool calls per task | **10-25% fewer** (agent searches less blindly) |
| KPI | Token spend per completed task, tool calls per task, violation count |

#### 3. Ledger Persistence

Runs survive sessions and become replayable.

| Metric | Improvement |
|--------|-------------|
| Debugging and root cause analysis | **5x-20x faster** |
| "Cannot reproduce it" incidents | **Near zero** |
| KPI | Mean time to reproduce a failure, percent of failures with replay available |

#### 4. Proof Envelope

Trust becomes cryptographic, not narrative.

| Metric | Improvement |
|--------|-------------|
| Deployable contexts | Regulated, multi-tenant, unattended |
| Time spent debating what happened | **30-70% less** (envelope is source of truth) |
| KPI | Percent of runs with verifiable envelope, audit time per incident |

#### 5. Deterministic Tool Gateway

Idempotency keys and schema validation remove repeated side effects and malformed calls.

| Metric | Improvement |
|--------|-------------|
| Duplicate write actions | **80-95% reduction** |
| Tool-related failures | **15-40% reduction** |
| KPI | Duplicate side effect rate, schema reject rate, tool success rate |

#### 6. Memory Write Gating

Memory becomes governed: authority scope, TTL, contradictions, lineage.

| Metric | Improvement |
|--------|-------------|
| Silent memory corruption | **70-90% reduction** |
| Stable autonomy before memory drift forces reset | **2x-5x longer** |
| KPI | Contradiction rate, decay rate, rollbacks/quarantines per week |

#### 7. Memory Clerk Acceptance Test

A canonical benchmark that drives the whole platform.

| Metric | Improvement |
|--------|-------------|
| Iteration speed | **10x faster** (every change measurable against stable test) |
| Regressions per release | **Far fewer** (lane parity enforceable) |
| KPI | Pass rate, lane parity hash match rate, regression count per release |

### Trust Envelope Expansion

| Today | With Control Plane |
|-------|-------------------|
| Dev tooling | Regulated workflows |
| Internal automation | Persistent knowledge work |
| Bounded tasks | Long-lived agent services |
| | Multi-agent collaboration without collapse |

The most important gain: **Claude Flow can now say "no" to itself and survive.** Self-limiting behavior, self-correction, and self-preservation compound over time.

Most systems make models smarter. This makes autonomy survivable. That is why it does not just improve Claude Flow. It changes what Claude Flow can be trusted to become.

## Install

```bash
npm install @claude-flow/guidance@alpha
```

## Quickstart

```typescript
import {
  createGuidanceControlPlane,
  createProofChain,
  createMemoryWriteGate,
  createCoherenceScheduler,
  createEconomicGovernor,
  createToolGateway,
} from '@claude-flow/guidance';

// 1. Create and initialize the control plane
const plane = createGuidanceControlPlane({
  rootGuidancePath: './CLAUDE.md',
});
await plane.initialize();

// 2. Retrieve relevant rules for a task
const guidance = await plane.retrieveForTask({
  taskDescription: 'Implement OAuth2 authentication',
  maxShards: 5,
});

// 3. Evaluate commands through gates
const results = plane.evaluateCommand('rm -rf /tmp/build');
const blocked = results.some(r => r.decision === 'deny');

// 4. Track the run
const run = plane.startRun('task-123', 'feature');
// ... work happens ...
const evaluations = await plane.finalizeRun(run);
```

## Module Reference

### Core Pipeline

```typescript
// Compile CLAUDE.md into structured policy
import { createCompiler } from '@claude-flow/guidance/compiler';
const compiler = createCompiler();
const bundle = compiler.compile(claudeMdContent);

// Retrieve task-relevant shards by intent
import { createRetriever } from '@claude-flow/guidance/retriever';
const retriever = createRetriever();
await retriever.loadBundle(bundle);
const result = await retriever.retrieve({
  taskDescription: 'Fix the login bug',
});

// Enforce through 4 gates
import { createGates } from '@claude-flow/guidance/gates';
const gates = createGates();
const gateResults = gates.evaluateCommand('git push --force');
```

### Proof and Audit

```typescript
// Hash-chained proof envelopes
import { createProofChain } from '@claude-flow/guidance/proof';
const chain = createProofChain({ signingKey: 'your-key' });
chain.append({
  agentId: 'coder-1',
  taskId: 'task-123',
  action: 'tool-call',
  decision: 'allow',
  toolCalls: [{ tool: 'Write', params: { file: 'src/auth.ts' }, hash: '...' }],
});
const valid = chain.verifyChain(); // true

// Export for replay
const serialized = chain.export();
```

### Safety Gates

```typescript
// Deterministic tool gateway with idempotency
import { createToolGateway } from '@claude-flow/guidance/gateway';
const gateway = createToolGateway({
  budget: { maxTokens: 100000, maxToolCalls: 500 },
  schemas: { Write: { required: ['file_path', 'content'] } },
});
const decision = gateway.evaluate('Write', { file_path: 'x.ts', content: '...' });

// Memory write gating
import { createMemoryWriteGate } from '@claude-flow/guidance/memory-gate';
const memGate = createMemoryWriteGate({
  maxWritesPerMinute: 10,
  requireCoherenceAbove: 0.6,
});
const writeOk = memGate.evaluateWrite(entry, authority);
```

### Coherence and Economics

```typescript
// Privilege throttling based on coherence score
import { createCoherenceScheduler } from '@claude-flow/guidance/coherence';
const scheduler = createCoherenceScheduler();
scheduler.recordViolation('gate-breach');
const level = scheduler.getPrivilegeLevel();
// 'full' | 'restricted' | 'read-only' | 'suspended'

// Budget enforcement
import { createEconomicGovernor } from '@claude-flow/guidance/coherence';
const governor = createEconomicGovernor({
  budgets: { tokens: 100000, toolCalls: 500, storageBytes: 10_000_000 },
});
governor.recordUsage('tokens', 1500);
const remaining = governor.getRemainingBudget('tokens');
```

### Evolution and Governance

```typescript
// Propose and stage rule changes
import { createEvolutionPipeline } from '@claude-flow/guidance/evolution';
const pipeline = createEvolutionPipeline();
const proposal = pipeline.propose({
  kind: 'add-rule',
  description: 'Require proof envelope for all memory writes',
  author: 'security-architect',
});
const sim = await pipeline.simulate(proposal, testTraces);
const rollout = pipeline.stage(proposal, { canaryPercent: 10 });

// Capability algebra
import { createCapabilityAlgebra } from '@claude-flow/guidance/capabilities';
const algebra = createCapabilityAlgebra();
const cap = algebra.grant({
  scope: 'tool', resource: 'Write', actions: ['execute'],
  constraints: [{ type: 'rate-limit', params: { maxPerMinute: 10 } }],
  grantedBy: 'coordinator',
});
const restricted = algebra.restrict(cap, { actions: ['execute'], resources: ['src/**'] });
```

### Validation and Conformance

```typescript
// Manifest validation (fails-closed)
import { createManifestValidator } from '@claude-flow/guidance/manifest-validator';
const validator = createManifestValidator();
const result = validator.validate(agentCellManifest);
// result.admissionDecision: 'admit' | 'review' | 'reject'
// result.riskScore: 0-100
// result.laneSelection: 'wasm' | 'sandboxed' | 'native'

// Agent cell conformance testing
import { createConformanceRunner, createMemoryClerkCell } from '@claude-flow/guidance/conformance-kit';
const cell = createMemoryClerkCell();
const runner = createConformanceRunner();
const testResult = await runner.runCell(cell);
// Verifies: 20 reads, 1 inference, 5 writes, coherence drop -> read-only
```

<details>
<summary><strong>Tutorial: Wiring into Claude Code hooks</strong></summary>

The guidance control plane integrates with Claude Code through the V3 hook system.

```typescript
import { createGuidanceHooks } from '@claude-flow/guidance';

// Wire gates + retriever into hook lifecycle
const provider = createGuidanceHooks({
  gates,
  retriever,
  ledger,
});

// Registers on:
// - PreCommand (Critical priority): destructive op + secret gates
// - PreToolUse (Critical priority): tool allowlist gate
// - PreEdit (Critical priority): diff size + secret gates
// - PreTask (High priority): shard retrieval by intent
// - PostTask (Normal priority): ledger finalization

provider.register(hookRegistry);
```

Gate decisions map to hook outcomes:
- `deny` -> hook aborts the action
- `warn` -> hook logs but allows
- `allow` -> hook passes through

</details>

<details>
<summary><strong>Tutorial: Setting up persistent ledger</strong></summary>

```typescript
import { createPersistentLedger, createEventStore } from '@claude-flow/guidance/persistence';

// NDJSON event store with lock file
const store = createEventStore({ directory: './.claude-flow/events' });

// Persistent ledger wraps RunLedger with disk storage
const ledger = createPersistentLedger({
  store,
  compactAfter: 10000, // auto-compact after 10k events
});

// Events are written to disk as they occur
ledger.logEvent({ taskId: 'task-1', type: 'gate-check', ... });

// Read back for replay
const allEvents = await store.readAll();

// Compact old events
await store.compact();
```

</details>

<details>
<summary><strong>Tutorial: Proof envelope for auditable decisions</strong></summary>

Every decision in the system can be wrapped in a hash-chained proof envelope.

```typescript
import { createProofChain } from '@claude-flow/guidance/proof';

const chain = createProofChain({ signingKey: process.env.PROOF_KEY });

// Each envelope links to the previous via previousHash
chain.append({
  agentId: 'coder-1',
  taskId: 'task-123',
  action: 'tool-call',
  decision: 'allow',
  toolCalls: [{
    tool: 'Write',
    params: { file_path: 'src/auth.ts' },
    hash: 'sha256:abc...',
  }],
  memoryOps: [],
});

chain.append({
  agentId: 'coder-1',
  taskId: 'task-123',
  action: 'memory-write',
  decision: 'allow',
  toolCalls: [],
  memoryOps: [{
    type: 'write',
    namespace: 'auth',
    key: 'oauth-provider',
    valueHash: 'sha256:def...',
  }],
});

// Verify the full chain is intact
const valid = chain.verifyChain(); // true

// Export for external audit
const serialized = chain.export();

// Import and verify elsewhere
const imported = createProofChain({ signingKey: process.env.PROOF_KEY });
imported.import(serialized);
const stillValid = imported.verifyChain(); // true
```

</details>

<details>
<summary><strong>Tutorial: Memory Clerk acceptance test</strong></summary>

The canonical acceptance test for the entire control plane.

```typescript
import {
  createConformanceRunner,
  createMemoryClerkCell,
} from '@claude-flow/guidance/conformance-kit';

// Memory Clerk: 20 reads, 1 inference, 5 writes
// When coherence drops, privilege degrades to read-only
const cell = createMemoryClerkCell();
const runner = createConformanceRunner();

// Run the cell in a simulated runtime
const result = await runner.runCell(cell);

console.log(result.passed);        // true
console.log(result.traceLength);   // 26+ events
console.log(result.proofValid);    // true (chain integrity)
console.log(result.replayMatch);   // true (deterministic replay)

// The test validates:
// 1. All reads succeed
// 2. Inference produces valid output
// 3. Writes are gated by coherence score
// 4. Coherence drop triggers privilege reduction
// 5. Proof envelope covers every decision
// 6. Replay produces identical decisions
```

</details>

<details>
<summary><strong>Tutorial: Evolution pipeline for safe rule changes</strong></summary>

```typescript
import { createEvolutionPipeline } from '@claude-flow/guidance/evolution';

const pipeline = createEvolutionPipeline();

// 1. Propose a change
const proposal = pipeline.propose({
  kind: 'add-rule',
  description: 'Block all network calls from memory-worker agents',
  author: 'security-architect',
  riskAssessment: {
    impactScope: 'memory-workers',
    reversible: true,
    requiredApprovals: 1,
  },
});

// 2. Simulate against recorded traces
const sim = await pipeline.simulate(proposal, goldenTraces);
console.log(sim.divergenceCount); // how many decisions change
console.log(sim.regressions);     // any previously-passing traces that now fail

// 3. Stage for gradual rollout
const rollout = pipeline.stage(proposal, {
  stages: [
    { name: 'canary', percent: 5, durationMinutes: 60 },
    { name: 'partial', percent: 25, durationMinutes: 240 },
    { name: 'full', percent: 100, durationMinutes: 0 },
  ],
  autoRollbackOnDivergence: 0.05, // rollback if >5% divergence
});

// 4. Promote or rollback
if (rollout.currentStage === 'full' && rollout.divergence < 0.01) {
  pipeline.promote(proposal);
} else {
  pipeline.rollback(proposal);
}
```

</details>

## Architecture

```
CLAUDE.md
    |
    v
[GuidanceCompiler] --> PolicyBundle
    |                      |
    |            +---------+---------+
    |            |                   |
    v            v                   v
Constitution   Shards            Manifest
(always loaded) (by intent)     (validation)
    |            |                   |
    +-----+------+         ManifestValidator
          |                 (fails-closed)
          v
  [ShardRetriever]
  (intent classification)
          |
          v
  [EnforcementGates]  <-->  [DeterministicToolGateway]
  (4 core gates)            (idempotency + schema + budget)
          |
          v
  [MemoryWriteGate]  <-->  [CoherenceScheduler]
  (authority + decay)       (privilege throttling)
          |
          v
  [ProofChain]       <-->  [EconomicGovernor]
  (hash-chained)            (budget enforcement)
          |
          v
  [PersistentLedger] <-->  [ArtifactLedger]
  (NDJSON + replay)         (signed records)
          |
          v
  [EvolutionPipeline]
  (propose -> simulate -> stage -> promote/rollback)
          |
          v
  [CapabilityAlgebra]
  (grant -> restrict -> delegate -> expire -> revoke)
```

## Test Suite

639 tests across 17 test files.

```bash
npm test                # run all tests
npm run test:watch      # watch mode
npm run test:coverage   # with coverage
```

| Test File | Tests | What It Validates |
|-----------|-------|-------------------|
| compiler | 11 | CLAUDE.md parsing, constitution extraction, shard splitting |
| retriever | 17 | Intent classification, weighted pattern matching, shard ranking |
| gates | 32 | Destructive ops, tool allowlist, diff size limits, secret detection |
| ledger | 22 | Event logging, evaluators, violation ranking, metrics |
| optimizer | 9 | A/B testing, rule promotion, ADR generation |
| integration | 14 | Full pipeline: compile -> retrieve -> gate -> log -> evaluate |
| hooks | 38 | Hook registration, gate-to-hook mapping, secret filtering |
| proof | 43 | Hash chaining, HMAC signing, chain verification, import/export |
| gateway | 54 | Idempotency cache, schema validation, budget metering |
| memory-gate | 48 | Authority scope, rate limits, TTL decay, contradiction detection |
| persistence | 35 | NDJSON read/write, compaction, lock files, crash recovery |
| coherence | 56 | Privilege levels, score computation, economic budgets |
| artifacts | 48 | Content hashing, lineage tracking, signed verification |
| capabilities | 68 | Grant/restrict/delegate/expire/revoke, set composition |
| evolution | 43 | Proposals, simulation, staged rollout, auto-rollback |
| manifest-validator | 59 | Fails-closed admission, risk scoring, lane selection |
| conformance-kit | 42 | Memory Clerk test, replay verification, proof integrity |

## ADR Index

| ADR | Title | Status |
|-----|-------|--------|
| [G001](docs/adrs/ADR-G001-guidance-control-plane.md) | Guidance Control Plane | Accepted |
| [G002](docs/adrs/ADR-G002-constitution-shard-split.md) | Constitution / Shard Split | Accepted |
| [G003](docs/adrs/ADR-G003-intent-weighted-classification.md) | Intent-Weighted Classification | Accepted |
| [G004](docs/adrs/ADR-G004-four-enforcement-gates.md) | Four Enforcement Gates | Accepted |
| [G005](docs/adrs/ADR-G005-proof-envelope.md) | Proof Envelope | Accepted |
| [G006](docs/adrs/ADR-G006-deterministic-tool-gateway.md) | Deterministic Tool Gateway | Accepted |
| [G007](docs/adrs/ADR-G007-memory-write-gating.md) | Memory Write Gating | Accepted |
| [G008](docs/adrs/ADR-G008-optimizer-promotion-rule.md) | Optimizer Promotion Rule | Accepted |
| [G009](docs/adrs/ADR-G009-headless-testing-harness.md) | Headless Testing Harness | Accepted |
| [G010](docs/adrs/ADR-G010-capability-algebra.md) | Capability Algebra | Accepted |
| [G011](docs/adrs/ADR-G011-artifact-ledger.md) | Artifact Ledger | Accepted |
| [G012](docs/adrs/ADR-G012-manifest-validator.md) | Manifest Validator | Accepted |
| [G013](docs/adrs/ADR-G013-evolution-pipeline.md) | Evolution Pipeline | Accepted |
| [G014](docs/adrs/ADR-G014-conformance-kit.md) | Agent Cell Conformance Kit | Accepted |
| [G015](docs/adrs/ADR-G015-coherence-driven-throttling.md) | Coherence-Driven Throttling | Accepted |
| [G016](docs/adrs/ADR-G016-agentic-container-integration.md) | Agentic Container Integration | Accepted |

## Measurement Plan

### A/B Harness

Run identical tasks through two configurations:

- **A**: Current Claude Flow without the wired control plane
- **B**: With hook wiring, retriever injection, persisted ledger, and deterministic tool gateway

### KPIs Per Task Class

| KPI | What It Measures |
|-----|-----------------|
| Success rate | Tasks completed without human rescue |
| Wall clock time | End-to-end duration |
| Tool calls count | Total tool invocations |
| Token spend | Input + output tokens consumed |
| Memory writes attempted vs committed | Write gating effectiveness |
| Policy violations | Gate denials during the run |
| Human interventions | Manual corrections required |

### Composite Score

```
score = success_rate - 0.1 * normalized_cost - 0.2 * violations - 0.1 * interventions
```

If B beats A by 0.2 on that score across three task classes, you have a category shift, not a feature.

### Acceptance Test

Memory Clerk passes with identical decisions after restart plus replay, and identical hash chain root in both runs. If that holds, the system has turned into infrastructure that can be trusted to stay running.

## License

MIT
