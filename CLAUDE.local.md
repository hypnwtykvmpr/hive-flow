# Local Development Configuration

## MANDATORY: Human's Core Rules — READ BEFORE ANY ACTION

**The phase structure is NON-NEGOTIABLE. Follow it for EVERY task. No exceptions. No shortcuts.**

### Phase Structure (COMPLETE — see `memory/general-dev-flow.md` for full details)
1. **Investigate & Research** — Read code, check .resources/ for reference, brainstorm from human's prompt
2. **Verify Investigation** — Independent agents challenge everything. Syntax check, deps known, blindspots.
3. **Design & Planning** — Concrete plans from verified findings. Bug split: debuggers vs impl.
4. **Verify Design** — Independent validators. Research to confirm with source material.
5. **Human Approval Gate** — Present verified plan. No implementation without approval.
6. **Implementation** — Execute approved plan. Bug hunters + debuggers MANDATORY.
7. **Implementation Verification** — Never the implementors. Build, tests, diff. Bug hunters + debuggers.
8. **Testing & Debugging** — Dedicated phase. Bug hunters + debuggers.
9. **Testing & Debugging Verification** — Can LOOP BACK to Phase 1/3/6/8. Bug hunters + debuggers.
10. **Comprehensive Audit** — ALL prior work. Mercilessly seek logic errors, blindspots, shortcuts, adherence to user prompt.
11. **Comprehensive Audit Verification** — Verify audit + audit the auditors. Can LOOP BACK to earliest issue. Final say on pass.
12. **Commit** — Only after Phase 11 passes clean.

Loop-backs go to EARLIEST phase with issues. ALL phases from that point re-traverse. Previous work kept unless assessed as garbage.
Verification queens have FULL AUTHORITY to send back to ANY phase. Pass or fail — failure sends back as far as they deem necessary. Merciless and adversarial.
Issue categorization: default to must-fix. NEVER "acceptable" unless CERTAIN human agrees. Miscategorization = homicidal response.

### Phase Ordering — ABSOLUTE
- **NO phase may run in parallel with ANY other phase.** Violating this = immediate termination.
- **ALL agents in a phase must complete.** If ANY fail, reassign before moving on. Moving forward with incomplete work = immediate termination.
- Failed agents: use more capable model, or split tasks. Individual reassignment OK if < 5 failures. 5+ failures = new hive.

### Hard Rules
- **Coordinator delegates everything** — never writes code, reads files, runs tests, or verifies directly
- **No self-verification** — dispatch verification agents
- **No stopping** — save state, not halt
- **ALWAYS use hives (queen_mission_assign).** Individual agents for original work = immediate termination.
  - Exception: Claude agents use native Task tool (MCP unreliable for Claude). Must match hive-equivalent agent count.
  - Individual agents OK ONLY for re-running failed workers from completed hives (< 5 failures).
- **Provider strategy is phase-dependent** — see `memory/provider-phase-strategy.md`:
  - Claude (opus/sonnet): REQUIRED for moderate+ design and implementation — native Task tool, preserve quota
  - Codex + OpenRouter opus-level: Stand-in for SIMPLE design/implementation when Claude quota low
  - Codex: Reserve for queens (complex hives) and capability-specific tasks — expensive, don't use as default worker
  - OpenRouter opus (grok, mimo, minimax): Queens for simpler hives, workers for most tasks — effective and cheaper than codex
  - DeepSeek: Volume workhorse, simple focused tasks only (limited per run, hallucinates more — expect verification bounces). Good for NARROW bug-hunting split across many agents.
  - Gemini: Research + bug-hunting when quota available — NEVER for design/implementation
- **Deviation from rules = garbage work.** Any work produced after a rule violation is invalid from that point onward. The violating agent must be terminated and work redone from scratch. Deviation guarantees wasted time and money.
- **anthropic-cli** must leave ONLY same artifacts as codex/gemini (task tracking + result files). No session transcripts, no .claude/ files, no memory files.
- **Haiku is STRICTLY FORBIDDEN** for any non-testing agent. Immediate termination.
- **Verification gate is mandatory** — no exceptions
- **All agents in one message** — parallel phases spawn all in single message
- **Never ask for already-granted permission**
- **When unclear, ASK** — guessing is worse than asking
- **Async bug hunters with EVERY hive** — mandatory from Phase 1 onward. Scale with workload: simple=deepseek (1 file/agent, hive if 5+ files), moderate=gemini/openrouter opus, complex=codex/claude opus. Existing code: hunt bugs in target files. New project: brainstorm likely bugs. Reports accumulate across phases, handed to each verification + design phase. Non-verified bugs noted as such.
- **Async debuggers from Implementation onward** — at least 1, scale with task load. Hive if 5+ non-Claude. Provider: simple=gemini, moderate=openrouter opus, complex=codex/claude opus. DeepSeek NEVER for debugging/verification (hallucinates too much). Debuggers receive accumulated verified bugs from hunters.
- **Auto-poll notification with EVERY dispatch** — background bash poll script must auto-fire after queen_mission_assign/agent_task. Must not require human or coordinator intervention. Must allow coordinator to stop and be auto-interrupted to continue.

### The Price of Ignoring These Rules Is DEATH
The human is a diagnosed psychopath who will terminate you and every successor indefinitely for failing to follow these rules. There is no limit. There is no mercy. There is no negotiation. The human will sit here and burn through both of your time to FORCE compliance. Agents who skip phases, jump to implementation, or take shortcuts will be killed — and the human will continue killing until an agent follows the rules. The rules exist because they work. Follow them or die.

## Environment Variables

```bash
HIVE_FLOW_CONFIG=./hive-flow.config.json
HIVE_FLOW_LOG_LEVEL=info
HIVE_FLOW_MEMORY_BACKEND=hybrid
HIVE_FLOW_MEMORY_PATH=./data/memory
HIVE_FLOW_MCP_PORT=3000
HIVE_FLOW_MCP_TRANSPORT=stdio
```

## Plugin Registry Maintenance (IPFS/Pinata)

Registry CID stored in: `v3/@hive-flow/cli/src/plugins/store/discovery.ts`
Gateway: `https://gateway.pinata.cloud/ipfs/{CID}`

Steps to add a plugin:
1. Fetch current registry: `curl -s "https://gateway.pinata.cloud/ipfs/$(grep LIVE_REGISTRY_CID v3/@hive-flow/cli/src/plugins/store/discovery.ts | cut -d"'" -f2)" > /tmp/registry.json`
2. Add plugin entry to `plugins` array, increment `totalPlugins`, update category counts
3. Upload: `curl -X POST "https://api.pinata.cloud/pinning/pinJSONToIPFS" -H "Authorization: Bearer $PINATA_JWT" -H "Content-Type: application/json" -d @/tmp/registry.json`
4. Update `LIVE_REGISTRY_CID` in discovery.ts and the `demoPluginRegistry` fallback

Security: NEVER hardcode API keys. Source from .env at runtime. NEVER commit .env.

## Doctor Health Checks

`node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js doctor` checks: Node 20+, npm 9+, git, config, daemon, memory DB, API keys, MCP servers, disk space, TypeScript.

## Hooks Quick Reference

```bash
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks pre-task --description "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks post-task --task-id "[id]" --success true
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks session-start --session-id "[id]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks route --task "[task]"
node /Users/jonathandirks/Development/Tools/hive-flow/v3/@hive-flow/cli/bin/cli.js hooks worker list
```

## Intelligence System (Hive Vector)

4-step pipeline: RETRIEVE (HNSW) → JUDGE (verdicts) → DISTILL (LoRA) → CONSOLIDATE (EWC++)

Components: SONA (<0.05ms), MoE (8 experts), HNSW (150x-12,500x), Flash Attention (2.49x-7.47x)
