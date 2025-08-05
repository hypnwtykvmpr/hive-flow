# GitHub Issue #577 Response

## Fixed: Hive Mind Session Resume Issues

Thank you for reporting these issues! I've implemented fixes for all the problems mentioned:

### ✅ Fixed Issues:

1. **"Cannot read properties of null (reading 'prepare')" error**
   - Fixed missing `await` on line 503 in `session-manager.js`
   - Added proper async/await handling throughout the session manager
   - Implemented database initialization checks before accessing `db.prepare()`

2. **Missing --dangerously-skip-permissions flag**
   - Changed condition from `flags['dangerously-skip-permissions'] !== false` to `!flags['no-auto-permissions']`
   - Flag now consistently applies for both initial spawn and resume operations

3. **Claude Code not opening when resuming**
   - Removed `--print` flag which was causing non-interactive mode
   - Changed stdio from 'pipe' to 'inherit' to match initial spawn behavior
   - Added sessionId parameter to launchClaudeWithContext function

4. **Enhanced session restoration context**
   - Significantly improved the `generateRestoredSessionPrompt` function
   - Now displays comprehensive session details including:
     - All agents (active and idle) with their current tasks
     - Complete task breakdown by status (completed, in-progress, pending)
     - Extended activity history (20 entries instead of 10)
     - Session metadata and timeline information
     - Checkpoint history with timestamps
     - Task assignments and priorities

### 🔍 Still Investigating:

- **Multiple CLI spawning issue**: Added debug logging to track spawn calls. This appears to be a race condition or Claude Code triggering multiple instances. Further investigation needed.

### Changes Made:

**File: `src/cli/simple-commands/hive-mind/session-manager.js`**
```javascript
// Line 503 - Fixed missing await
const session = await this.getSession(sessionId);

// Added initialization promise tracking
this.initializationPromise = this.initializeDatabase();

// Enhanced ensureInitialized method
async ensureInitialized() {
  if (this.initializationPromise) {
    await this.initializationPromise;
    this.initializationPromise = null;
  }
  // ... rest of initialization
}
```

**File: `src/cli/simple-commands/hive-mind.js`**
```javascript
// Simplified permissions flag condition
if (!flags['no-auto-permissions']) {
  claudeArgs.push('--dangerously-skip-permissions');
}

// Fixed Claude spawn for interactive session
const claudeArgs = [prompt]; // No --print flag
const claudeProcess = childSpawn('claude', claudeArgs, {
  stdio: 'inherit', // Changed from 'pipe'
  shell: false,
});

// Enhanced session prompt generation with comprehensive details
function generateRestoredSessionPrompt(session) {
  // Now includes all agents, complete task history,
  // extended logs, metadata, and more context
}
```

The fixes should resolve the session resume issues on both macOS and Debian. Please test and let me know if you encounter any remaining problems, especially regarding the multiple CLI spawning issue.