# Dual-Mode Skills (Claude Code + Codex)

Optional skills for orchestrating Claude Code and headless Codex workers together.

## Available Skills

| Skill | File | Purpose |
|-------|------|---------|
| `dual-spawn` | dual-spawn.md | Spawn headless Codex workers from Claude Code |
| `dual-coordinate` | dual-coordinate.md | Coordinate hybrid Claude+Codex workflows |
| `dual-collect` | dual-collect.md | Collect results from headless workers |

## Quick Start

### From Claude Code (Interactive)

```
/dual-spawn "Implement auth module" --workers 3
```

This spawns 3 headless Codex workers in background.

### Collect Results

```
/dual-collect --namespace results
```

### Full Workflow

```
/dual-coordinate --workflow hybrid_development --task "Build user API"
```

## Installation

Skills are pre-installed in `.claude/skills/dual-mode/`.
Invoke with `/skill-name` in Claude Code.
