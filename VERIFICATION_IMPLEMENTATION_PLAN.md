# Truth Scoring & Verification Implementation Plan
## Backward-Compatible Integration for Claude-Flow

### Executive Summary
This plan introduces truth scoring and verification mechanisms into Claude-Flow without breaking existing functionality. All new features are opt-in with progressive enhancement.

---

## Phase 1: Foundation Layer (Week 1)
**Goal**: Add verification infrastructure without changing existing behavior

### 1.1 MCP Tool Extensions
```javascript
// Extend existing tools with optional verification
mcp__claude-flow__swarm_init {
  topology: "mesh",  // existing
  maxAgents: 8,      // existing
  // NEW OPTIONAL FIELDS (backward compatible)
  verification: {
    enabled: false,  // default off for compatibility
    mode: "passive", // passive|active|strict
    truth_threshold: 0.80
  }
}

mcp__claude-flow__agent_spawn {
  type: "coder",     // existing
  capabilities: [],  // existing
  // NEW OPTIONAL FIELDS
  verification_hooks: {
    pre_task: "verify_prerequisites",
    post_task: "verify_completion",
    on_claim: "verify_claim"
  }
}

// NEW TOOL - doesn't affect existing flows
mcp__claude-flow__truth_score {
  agent_id: "string",
  task_id: "string",
  claim: {
    description: "string",
    success: boolean,
    metrics: {}
  },
  evidence: {
    test_results: [],
    build_status: "string",
    verification_method: "string"
  }
}
```

### 1.2 Memory Integration
```javascript
// Extend existing memory_usage tool
mcp__claude-flow__memory_usage {
  action: "store",
  key: "task_result",
  value: "data",
  namespace: "default",
  // NEW OPTIONAL FIELDS
  truth_metadata: {
    verified: false,
    score: 0.0,
    evidence: []
  }
}
```

### 1.3 Helper Scripts Structure
```bash
.claude/
├── helpers/
│   ├── verify.sh          # Verification runner
│   ├── truth-score.js     # Truth scoring calculator
│   ├── rollback.sh        # Rollback mechanism
│   └── checkpoint.js      # Checkpoint creator
├── hooks/
│   ├── pre-task.sh        # Existing hook
│   ├── post-task.sh       # Existing hook
│   ├── verify-claim.sh    # NEW verification hook
│   └── truth-check.sh     # NEW truth scoring hook
└── config/
    ├── verification.json   # NEW config file
    └── truth-thresholds.json  # NEW thresholds
```

---

## Phase 2: NPX Command Integration (Week 2)
**Goal**: Add verification commands that work with existing workflows

### 2.1 New Commands (Additive, Non-Breaking)
```bash
# New verification commands
npx claude-flow verify --enable          # Enable verification
npx claude-flow verify --status          # Check verification status
npx claude-flow verify --score [task-id] # Get truth score
npx claude-flow verify --history         # View verification history

# Extended existing commands (backward compatible)
npx claude-flow sparc run dev "task" --verify  # Add verification
npx claude-flow agent spawn coder --verify     # Spawn with verification
npx claude-flow swarm init mesh --verify=strict # Init with verification

# Truth scoring commands
npx claude-flow truth score [agent-id]         # Calculate truth score
npx claude-flow truth report                   # Generate truth report
npx claude-flow truth threshold --set 0.95     # Set truth threshold
```

### 2.2 Verification Helper Script
```bash
#!/bin/bash
# .claude/helpers/verify.sh

# Backward compatible - only runs if enabled
if [ -f ".claude/config/verification.json" ]; then
  VERIFY_ENABLED=$(jq -r '.enabled' .claude/config/verification.json)
  if [ "$VERIFY_ENABLED" = "true" ]; then
    # Run verification
    npm test --silent
    TEST_EXIT=$?
    
    # Calculate truth score
    node .claude/helpers/truth-score.js \
      --test-result=$TEST_EXIT \
      --agent-id=$1 \
      --task-id=$2
  fi
fi

# Always exit 0 to not break existing flows
exit 0
```

---

## Phase 3: Agent Enhancement (Week 3)
**Goal**: Add verification capabilities to agents without breaking existing ones

### 3.1 Agent Definition Updates
```javascript
// agents/coder.js - Enhanced but backward compatible
export const coderAgent = {
  type: "coder",
  capabilities: ["javascript", "typescript"], // existing
  
  // NEW: Optional verification methods
  verification: {
    enabled: process.env.VERIFICATION_ENABLED || false,
    
    preTask: async (context) => {
      if (!this.verification.enabled) return true; // skip if disabled
      // Snapshot current state
      await exec('npx claude-flow checkpoint create');
      // Run baseline tests
      const baseline = await exec('npm test');
      return baseline.success;
    },
    
    postTask: async (context, result) => {
      if (!this.verification.enabled) return result; // pass through
      // Verify claims
      const verified = await verifyImplementation(result);
      // Store truth score
      await storeTruthScore(context.agentId, verified);
      return verified;
    },
    
    onClaim: async (claim) => {
      if (!this.verification.enabled) return claim; // pass through
      // Verify specific claim
      const evidence = await gatherEvidence(claim);
      const score = calculateTruthScore(claim, evidence);
      if (score < 0.80) {
        console.warn(`Low truth score: ${score}`);
      }
      return { ...claim, truth_score: score };
    }
  }
};
```

### 3.2 Verification Wrapper for All Agents
```javascript
// .claude/helpers/agent-wrapper.js
export function withVerification(agent) {
  // Return original agent if verification disabled
  if (!process.env.VERIFICATION_ENABLED) {
    return agent;
  }
  
  // Wrap agent with verification
  return {
    ...agent,
    execute: async (task) => {
      // Pre-verification
      const checkpoint = await createCheckpoint();
      
      try {
        // Execute original task
        const result = await agent.execute(task);
        
        // Post-verification
        const verified = await verifyResult(result);
        
        if (verified.truth_score < getThreshold()) {
          await rollback(checkpoint);
          throw new Error(`Verification failed: ${verified.truth_score}`);
        }
        
        return verified;
      } catch (error) {
        await rollback(checkpoint);
        throw error;
      }
    }
  };
}
```

---

## Phase 4: CLAUDE.md Template Update (Week 3)
**Goal**: Update init template with verification guidance

### 4.1 Enhanced CLAUDE.md Template
```markdown
# Claude Code Configuration

## Verification & Truth Scoring (Optional)

### Quick Start
Enable verification for reliable agent outputs:
\`\`\`bash
npx claude-flow verify --enable
npx claude-flow verify --threshold 0.95
\`\`\`

### Truth Scoring
Monitor agent reliability with truth scores:
\`\`\`bash
# Check agent truth score
npx claude-flow truth score [agent-id]

# View verification history
npx claude-flow truth history

# Generate truth report
npx claude-flow truth report --format json
\`\`\`

### Memory-Based Truth Tracking
Truth scores are automatically stored in memory:
- Location: \`.claude-flow/memory/truth-scores/\`
- Retention: 30 days (configurable)
- Format: JSON with evidence chain

### Verification Modes
- **OFF** (default): No verification, maximum speed
- **PASSIVE**: Log truth scores without enforcement
- **ACTIVE**: Warn on low truth scores
- **STRICT**: Block and rollback on verification failure

### Integration with Existing Commands
Add \`--verify\` to any command:
\`\`\`bash
npx claude-flow sparc run dev "build feature" --verify
npx claude-flow agent spawn coder --verify=strict
npx claude-flow swarm init mesh --verify
\`\`\`

### GitHub Actions Integration
Verification works with existing workflows:
\`\`\`yaml
- name: Run with Verification
  run: npx claude-flow@alpha sparc run dev "$TASK" --verify
  env:
    VERIFICATION_ENABLED: true
    TRUTH_THRESHOLD: 0.95
\`\`\`

[Existing CLAUDE.md content continues...]
```

---

## Phase 5: GitHub Integration (Week 4)
**Goal**: Add verification to GitHub workflows without breaking existing ones

### 5.1 GitHub Action Updates
```yaml
# .github/workflows/claude-flow-verify.yml (NEW)
name: Claude-Flow Verification
on:
  workflow_call:  # Can be called by existing workflows
    inputs:
      verification_mode:
        type: string
        default: 'passive'

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Verification
        run: |
          npx claude-flow@alpha verify --enable
          npx claude-flow@alpha verify --mode ${{ inputs.verification_mode }}
      
      - name: Run with Truth Scoring
        run: |
          npx claude-flow@alpha sparc run dev "${{ github.event.inputs.task }}" --verify
      
      - name: Generate Truth Report
        if: always()
        run: |
          npx claude-flow@alpha truth report --format markdown >> $GITHUB_STEP_SUMMARY
```

### 5.2 PR Integration
```yaml
# Enhance existing PR workflows
- name: Verify PR Changes
  run: |
    # Only run if verification enabled
    if [ -f ".claude/config/verification.json" ]; then
      npx claude-flow@alpha verify --pr ${{ github.event.pull_request.number }}
    fi
```

---

## Phase 6: Progressive Rollout (Week 5-6)
**Goal**: Gradual adoption with feature flags

### 6.1 Feature Flags
```javascript
// .claude/config/features.json
{
  "verification": {
    "enabled": false,        // Start disabled
    "rollout_percentage": 0, // Gradual rollout
    "modes": {
      "development": "passive",
      "staging": "active",
      "production": "strict"
    }
  },
  "truth_scoring": {
    "enabled": false,
    "threshold": 0.80,
    "enforcement": "warn"  // warn|block|rollback
  }
}
```

### 6.2 Migration Path
```bash
#!/bin/bash
# .claude/migrate-to-verification.sh

echo "Migrating to verification-enabled Claude-Flow..."

# 1. Backup current config
cp -r .claude .claude.backup

# 2. Add verification config
cat > .claude/config/verification.json << EOF
{
  "enabled": false,
  "mode": "passive",
  "truth_threshold": 0.80,
  "rollback_enabled": false
}
EOF

# 3. Update package.json scripts (non-breaking)
npx json -I -f package.json -e 'this.scripts["verify"] = "npx claude-flow verify --status"'
npx json -I -f package.json -e 'this.scripts["truth:score"] = "npx claude-flow truth score"'

# 4. Install verification helpers
npx claude-flow@alpha init --add-verification

echo "Migration complete. Verification is installed but DISABLED by default."
echo "To enable: npx claude-flow verify --enable"
```

---

## Phase 7: Monitoring & Metrics (Week 6)
**Goal**: Track adoption and effectiveness

### 7.1 Metrics Collection
```javascript
// Automatic metrics (opt-in)
{
  "verification_metrics": {
    "truth_scores": {
      "average": 0.85,
      "trending": "up",
      "by_agent": {
        "coder": 0.82,
        "tester": 0.91,
        "reviewer": 0.88
      }
    },
    "rollback_rate": 0.05,
    "verification_time_overhead": "12%",
    "false_positive_rate": 0.02,
    "human_intervention_reduction": "75%"
  }
}
```

### 7.2 Dashboard Integration
```bash
# New dashboard command
npx claude-flow dashboard --verification

# Shows:
# - Truth scores by agent
# - Verification success rate
# - Rollback frequency
# - Performance impact
```

---

## Implementation Timeline

### Week 1: Foundation
- [ ] Implement MCP tool extensions
- [ ] Create verification helper scripts
- [ ] Set up memory persistence

### Week 2: Commands
- [ ] Add npx verification commands
- [ ] Integrate with existing commands
- [ ] Create truth scoring system

### Week 3: Agents
- [ ] Update agent definitions
- [ ] Create verification wrapper
- [ ] Update CLAUDE.md template

### Week 4: GitHub
- [ ] Create verification workflows
- [ ] Integrate with PR checks
- [ ] Add to existing workflows

### Week 5: Testing
- [ ] Test backward compatibility
- [ ] Performance benchmarking
- [ ] Edge case validation

### Week 6: Rollout
- [ ] Deploy to alpha channel
- [ ] Monitor metrics
- [ ] Gather feedback
- [ ] Gradual production rollout

---

## Success Criteria

1. **Zero Breaking Changes**: All existing workflows continue to work
2. **Opt-In Adoption**: Users choose when to enable verification
3. **Performance**: <15% overhead when verification enabled
4. **Truth Accuracy**: >95% correlation between claims and reality
5. **Developer Satisfaction**: >80% positive feedback

---

## Risk Mitigation

1. **Performance Impact**: 
   - Verification runs async where possible
   - Caching of truth scores
   - Selective verification (critical paths only)

2. **Adoption Resistance**:
   - Start with passive mode (logging only)
   - Show value through metrics
   - Gradual enforcement

3. **False Positives**:
   - Tunable thresholds
   - Agent-specific configurations
   - Learning from historical data

---

This implementation plan ensures that verification and truth scoring enhance Claude-Flow without disrupting existing users, providing a smooth migration path to a more reliable AI-assisted development paradigm.