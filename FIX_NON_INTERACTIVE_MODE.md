# Non-Interactive Mode Fix - Regression from alpha.83

## Summary
Fixed a regression where the `--non-interactive` flag was not being properly handled in swarm and hive-mind commands. The issue was that the code was checking for the flag AFTER spawning Claude in interactive mode, instead of BEFORE.

## Issue
In claude-flow versions after alpha.83 (including alpha.87), the --non-interactive flag was being ignored because:
1. The code would check if Claude CLI exists
2. If it exists, immediately spawn Claude in interactive mode
3. Only THEN check if --non-interactive was specified
4. By that point, Claude was already running interactively

## Root Cause
The non-interactive flag check was happening too late in the execution flow.

## Solution
Moved the non-interactive flag check to happen FIRST, before any Claude spawning occurs.

## Files Modified

### 1. `/src/cli/simple-commands/swarm.js`
- **Line 842-846**: Added early check for non-interactive mode BEFORE checking for Claude
- **Line 854-870**: Made error messages conditional based on interactive/non-interactive mode
- **Line 875-889**: Made launch messages conditional based on mode
- **Line 770-807**: Fixed --claude flag to always use interactive mode (as intended)

### 2. `/src/cli/simple-commands/hive-mind.js`
- **Line 1484-1492**: Added early check for non-interactive mode in spawn subcommand
- **Line 426-446**: Added non-interactive check at start of spawnSwarm function

## Key Changes

### Before (Broken):
```javascript
// Check if claude exists
execSync('which claude');
// Launch claude immediately
console.log('Launching...');
spawn('claude', args);
// Only then check non-interactive (too late!)
if (flags['non-interactive']) { ... }
```

### After (Fixed):
```javascript
// Check non-interactive FIRST
const isNonInteractive = flags['non-interactive'] || ...;
// Then check if claude exists
execSync('which claude');
// Launch with appropriate mode
if (!isNonInteractive) {
  console.log('Launching...');
}
spawn('claude', isNonInteractive ? [..., '-p'] : args);
```

## Special Cases

### --claude Flag
The `--claude` flag is meant to force interactive mode, so it bypasses non-interactive checks:
- `claude-flow swarm "task" --claude` → Always interactive
- `claude-flow swarm "task" --non-interactive` → Non-interactive
- `claude-flow swarm "task"` → Interactive by default

## Testing

### Working Commands:
```bash
# Non-interactive mode (fixed)
./claude-flow swarm "Test task" --non-interactive
./claude-flow hive-mind spawn "Test task" --count 2 --non-interactive

# Interactive mode with --claude flag (preserved)
./claude-flow swarm "Test task" --claude

# Default interactive mode
./claude-flow swarm "Test task"
```

## Compatibility
This fix restores the behavior from alpha.83 where --non-interactive flag was properly respected.