# Claude Flow v2.0.0-alpha.88 Release Notes

## 🐛 Bug Fixes

### Fixed Non-Interactive Mode Regression
- **Issue**: The `--non-interactive` flag was being ignored in `swarm` and `hive-mind` commands
- **Root Cause**: Commands were checking for the flag AFTER spawning Claude in interactive mode
- **Solution**: Moved non-interactive flag checks to occur BEFORE any Claude spawning
- **Impact**: Restores proper non-interactive mode behavior from alpha.83

## 📝 Changes

### swarm.js
- Check for `--non-interactive` flag FIRST before spawning Claude
- Properly handle `--claude` flag to force interactive mode when explicitly requested
- Conditional output messages based on interactive/non-interactive mode

### hive-mind.js  
- Added early non-interactive check in spawn subcommand
- Fixed `spawnClaudeCodeInstances` to respect non-interactive mode
- `--claude` flag with `--non-interactive` now properly runs in non-interactive mode

## ✅ Working Commands

### Non-Interactive Mode
```bash
# Swarm command
./claude-flow swarm "Test task" --non-interactive

# Hive-mind command
./claude-flow hive-mind spawn "Test task" --non-interactive

# With --claude flag (respects non-interactive)
./claude-flow hive-mind spawn "Test task" --claude --non-interactive
```

### Interactive Mode
```bash
# Default behavior
./claude-flow swarm "Test task"

# Force interactive with --claude
./claude-flow swarm "Test task" --claude
```

## 🔄 Compatibility
This release restores the non-interactive mode behavior that was working correctly in alpha.83.