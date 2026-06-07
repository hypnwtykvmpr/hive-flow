---
name: neural-training
description: >
  Neural pattern training with SONA (Self-Optimizing Neural Architecture), MoE (Mixture of Experts), and EWC++ for knowledge consolidation.
  Use when: pattern learning, model optimization, knowledge transfer, adaptive routing.
  Skip when: simple tasks, no learning required, one-off operations.
---

# Neural Training Skill

## Purpose
Train and optimize neural patterns using SONA, MoE, and EWC++ systems.

## When to Trigger
- Training new patterns
- Optimizing agent routing
- Knowledge consolidation
- Pattern recognition tasks

## Intelligence Pipeline

1. **RETRIEVE** — Fetch relevant patterns via HNSW (fast HNSW-indexed)
2. **JUDGE** — Evaluate with verdicts (success$failure)
3. **DISTILL** — Extract key learnings via LoRA
4. **CONSOLIDATE** — Prevent catastrophic forgetting via EWC++

## Components

| Component | Purpose | Performance |
|-----------|---------|-------------|
| SONA | Self-optimizing adaptation | low-latency |
| MoE | Expert routing | 8 experts |
| HNSW | Pattern search | HNSW-indexed |
| EWC++ | Prevent forgetting | Continuous |
| Flash Attention | Speed | Flash Attention optimization |

## Commands

### Train Patterns
```bash
hive-flow neural train --model-type moe --epochs 10
```

### Check Status
```bash
hive-flow neural status
```

### View Patterns
```bash
hive-flow neural patterns --type all
```

### Predict
```bash
hive-flow neural predict --input "task description"
```

### Optimize
```bash
hive-flow neural optimize --target latency
```

## Best Practices
1. Use pretrain hook for batch learning
2. Store successful patterns after completion
3. Consolidate regularly to prevent forgetting
4. Route based on task complexity
