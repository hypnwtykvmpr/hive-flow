# Hive Flow Remote Setup Guide

## Problem
When using `npx hive-flow@alpha` remotely, you may encounter:
- `ENOTEMPTY` npm cache errors
- Version mismatch issues  
- **Missing `./hive-flow@alpha` wrapper after init** ⭐ **FIXED!**
- Hook functionality not working

## Quick Fix

### Method 1: One-line Installation
```bash
curl -fsSL https://raw.githubusercontent.com/ruvnet/hive-flow/main/install-remote.sh | bash
```

### Method 2: Manual Installation
```bash
# Clear npm cache and reinstall
npm cache clean --force
npm uninstall -g hive-flow
npm install -g hive-flow@alpha --no-optional --legacy-peer-deps

# Verify and initialize
hive-flow --version
hive-flow init
```

### Method 3: Local Development Setup
If you're working with the source code:

```bash
# From the claude-code-flow directory
npm pack
npm install -g ./hive-flow-*.tgz
hive-flow --version
```

## Verification

Test that everything works:
```bash
# Check version
hive-flow --version

# Test hooks
hive-flow hooks notify --message "Setup complete" --level "success"

# Check system status
hive-flow status

# ⭐ NEW: Test wrapper creation
npx hive-flow@alpha init --force
ls -la ./hive-flow*
# Should show: ./hive-flow@alpha (executable)
./hive-flow@alpha --version
```

## Troubleshooting

### Cache Issues
```bash
npm cache clean --force
rm -rf ~/.npm/_npx
```

### Permission Issues
```bash
sudo npm install -g hive-flow@alpha
# or use nvm to avoid sudo
```

### Binary Not Found
```bash
# Check global bin directory
npm config get prefix
# Add to PATH if needed
export PATH="$(npm config get prefix)/bin:$PATH"
```

## Remote Usage Tips

1. **Use stable alpha version**: `hive-flow@alpha` instead of specific versions
2. **Clear cache first**: Always run `npm cache clean --force` before installation
3. **Use --legacy-peer-deps**: Helps resolve dependency conflicts
4. **Test hooks immediately**: Verify functionality after installation

## Success Indicators

✅ `hive-flow --version` shows current version  
✅ `hive-flow status` shows system running  
✅ `hive-flow hooks notify` works without errors  
✅ All commands available globally